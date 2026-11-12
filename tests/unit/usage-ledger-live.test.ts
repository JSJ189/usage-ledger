/**
 * 实时采集 + v3 插件装配单测。
 *
 * 两部分：
 *  1. `createLiveCollector`：turn 事件流 → 「每次调用一条记录」的状态机
 *     （TTFT 只认第一包、缺 message 标 incomplete、run_end 兜底）；
 *  2. `activate(host)`：v3 路由、内存设置快照、live 写入 SQLite、`/api/v3/overview` 与边界错误码。
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveCollector } from "../../lib/live.mjs";
import { createLedgerStore } from "../../lib/ledger.mjs";
import { activate } from "../../index.mjs";
import { createMockHost } from "../support/mock-host.mjs";
import { makeTmpDir } from "../support/session-fixtures.mjs";

/** 收集器 + 内存账本。 */
function collector() {
	const store = createLedgerStore({});
	const log = vi.fn();
	const live = createLiveCollector({ store, log });
	return { store, live, log };
}

const T0 = 1_791_774_000_000;

/** 一条完整的 turn 事件序列（assistant 消息带 model/provider/cost）。 */
function fullTurn({ conversationId = "conv-1", start = T0, ttft = 733, duration = 4321, model = "grok-4.7" } = {}) {
	return [
		{ type: "run_start", conversationId, at: start - 10 },
		{ type: "turn_start", conversationId, at: start },
		{ type: "turn_first_token", conversationId, at: start + ttft, durationMs: ttft },
		{ type: "turn_end", conversationId, at: start + duration },
		{ type: "run_end", conversationId, at: start + duration + 5, stopReason: "stop" },
		{ type: "__model", model },
	];
}

describe("createLiveCollector：事件流 → 记录", () => {
	it("完整 turn：TTFT / 耗时 / 模型 / 成本都落到一条 live 记录", () => {
		const { store, live } = collector();
		const events = fullTurn();
		const model = events.pop();
		void model;
		live.handle(events[0]);
		live.handle(events[1]);
		live.handle(events[2]);
		live.handle({
			type: "message",
			conversationId: "conv-1",
			at: T0 + 4300,
			message: {
				id: "a-1",
				role: "assistant",
				content: [],
				model: "grok-4.7",
				provider: "cliproxyapi",
				timestamp: T0 + 4321,
				usageCost: 0.020144,
				stopReason: "stop",
			},
		});
		live.handle(events[3]);
		expect(store.size).toBe(1);
		const rec = store.list()[0];
		expect(rec).toMatchObject({
			conversationId: "conv-1",
			model: "grok-4.7",
			provider: "cliproxyapi",
			ttftMs: 733,
			durationMs: 4321,
			costUsd: 0.020144,
			stopReason: "stop",
			status: "ok",
			source: "live",
		});
		expect(rec.ts).toBe(T0 + 4321);
	});

	it("live 记录没有 token（UiMessage 不带 token），token 字段是 null", () => {
		const { store, live } = collector();
		const [start, turnStart, firstToken] = fullTurn();
		live.handle(start);
		live.handle(turnStart);
		live.handle(firstToken);
		live.handle({
			type: "message",
			conversationId: "conv-1",
			at: T0 + 4000,
			message: { role: "assistant", model: "m", provider: "p", timestamp: T0 + 4000 },
		});
		live.handle({ type: "turn_end", conversationId: "conv-1", at: T0 + 4321 });
		const rec = store.list()[0];
		expect(rec.inputTokens).toBeNull();
		expect(rec.totalTokens).toBeNull();
		expect(rec.hasUsage).toBe(false);
	});

	it("run_end 兜底：turn 里没有 message 也落库并标 incomplete", () => {
		const { store, live } = collector();
		live.handle({ type: "turn_start", conversationId: "c1", at: T0 });
		live.handle({ type: "run_end", conversationId: "c1", at: T0 + 2000, stopReason: "aborted" });
		expect(store.size).toBe(1);
		expect(store.list()[0].status).toBe("incomplete");
		expect(store.list()[0].ttftMs).toBeNull();
		expect(store.list()[0].durationMs).toBe(2000);
	});

	it("一轮只认第一个首包（后续 turn_first_token 不覆盖）", () => {
		const { store, live } = collector();
		live.handle({ type: "turn_start", conversationId: "c1", at: T0 });
		live.handle({ type: "turn_first_token", conversationId: "c1", at: T0 + 500, durationMs: 500 });
		live.handle({ type: "turn_first_token", conversationId: "c1", at: T0 + 900, durationMs: 900 });
		live.handle({ type: "turn_end", conversationId: "c1", at: T0 + 2000 });
		expect(store.list()[0].ttftMs).toBe(500);
	});

	it("一次 run 里两轮 → 两条记录", () => {
		const { store, live } = collector();
		live.handle({ type: "run_start", conversationId: "c1", at: T0 });
		for (const start of [T0, T0 + 60_000]) {
			live.handle({ type: "turn_start", conversationId: "c1", at: start });
			live.handle({ type: "turn_first_token", conversationId: "c1", at: start + 400, durationMs: 400 });
			live.handle({ type: "turn_end", conversationId: "c1", at: start + 3000 });
		}
		expect(store.size).toBe(2);
	});

	it("没有 turn_start 的 turn_end 被忽略（不造脏记录）", () => {
		const { store, live } = collector();
		live.handle({ type: "turn_end", conversationId: "c1", at: T0 });
		expect(store.size).toBe(0);
		expect(live.stats().ignored).toBe(1);
	});

	it("没有打开 turn 的 run_end 什么都不做", () => {
		const { store, live } = collector();
		live.handle({ type: "run_start", conversationId: "c1", at: T0 });
		live.handle({ type: "run_end", conversationId: "c1", at: T0 + 10 });
		expect(store.size).toBe(0);
	});

	it("用户消息 / 未知事件类型被忽略", () => {
		const { store, live } = collector();
		live.handle({ type: "turn_start", conversationId: "c1", at: T0 });
		live.handle({ type: "message", conversationId: "c1", at: T0 + 1, message: { role: "user", content: [] } });
		live.handle({ type: "tool_start", conversationId: "c1", at: T0 + 2, toolName: "read" });
		live.handle({ type: "turn_end", conversationId: "c1", at: T0 + 3 });
		expect(store.list()[0].status).toBe("incomplete");
		expect(live.stats().ignored).toBe(2);
	});

	it("非对象事件直接返回空数组", () => {
		const { live } = collector();
		expect(live.handle(null)).toEqual([]);
		expect(live.handle("x")).toEqual([]);
	});

	it("message 的 stopReason=error → status error", () => {
		const { store, live } = collector();
		live.handle({ type: "turn_start", conversationId: "c1", at: T0 });
		live.handle({
			type: "message",
			conversationId: "c1",
			at: T0 + 100,
			message: { role: "assistant", model: "m", provider: "p", stopReason: "error", errorMessage: "500" },
		});
		live.handle({ type: "turn_end", conversationId: "c1", at: T0 + 200 });
		expect(store.list()[0].status).toBe("error");
	});

	it("并发对话互不串台（按 conversationId 分槽）", () => {
		const { store, live } = collector();
		live.handle({ type: "turn_start", conversationId: "c1", at: T0 });
		live.handle({ type: "turn_start", conversationId: "c2", at: T0 + 100 });
		live.handle({ type: "turn_first_token", conversationId: "c2", at: T0 + 200, durationMs: 100 });
		live.handle({ type: "turn_end", conversationId: "c2", at: T0 + 500 });
		live.handle({ type: "turn_end", conversationId: "c1", at: T0 + 900 });
		expect(store.size).toBe(2);
		const byConv = store.list().map((r) => r.conversationId).sort();
		expect(byConv).toEqual(["c1", "c2"]);
		const c2 = store.list().find((r) => r.conversationId === "c2");
		expect(c2.ttftMs).toBe(100);
	});

	it("stats / pending / reset", () => {
		const { live } = collector();
		live.handle({ type: "turn_start", conversationId: "c1", at: T0 });
		expect(live.pending()).toBe(1);
		expect(live.stats().events).toBe(1);
		live.reset();
		expect(live.pending()).toBe(0);
	});

	it("写入账本抛错时只记 warn，不把事件处理打挂", () => {
		const log = vi.fn();
		const store = {
			add: () => {
				throw new Error("disk full");
			},
		};
		const live = createLiveCollector({ store, log });
		live.handle({ type: "turn_start", conversationId: "c1", at: T0 });
		expect(() => live.handle({ type: "turn_end", conversationId: "c1", at: T0 + 10 })).not.toThrow();
		expect(log).toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────── v3 activate 装配

/** 调一次已注册的路由，返回应答 JSON。 */
function callRoute(host, method, path, query = {}, pluginPath = path) {
	const route = host.mock.routes.find((r) => r.method === method && r.path === path);
	if (!route) throw new Error(`路由没注册：${method} ${path}`);
	return new Promise((resolve) => {
		route.handler(
			{ query, pluginPath },
			{
				headersSent: false,
				setHeader: () => {},
				status: () => {},
				json: (payload) => resolve(payload),
				end: () => {},
			},
		);
	});
}

const tmpDirs: string[] = [];
const cleanups: Array<() => void> = [];

function trackDir(prefix: string) {
	const dir = makeTmpDir(prefix);
	tmpDirs.push(dir);
	return dir;
}

function makeV3Host(overrides: Record<string, unknown> = {}) {
	const dataDir = (overrides.dataDir as string) ?? trackDir("ul-v3-data-");
	const sessionsDir = trackDir("ul-v3-sessions-");
	const settingsObj = {
		sessionsDir,
		autoImport: false,
		backfillOnStart: false,
		...(typeof overrides.settings === "object" && overrides.settings ? overrides.settings : {}),
	};
	const host = createMockHost({
		dataDir,
		fetch: async () => ({ ok: false, status: 503, text: async () => "" }),
		...overrides,
		settings: settingsObj,
	});
	// host.getSettings 返回内存对象
	host.getSettings = () => settingsObj;
	return { host, dataDir, sessionsDir, settingsObj };
}

function boot(host) {
	const cleanup = activate(host);
	cleanups.push(cleanup);
	return cleanup;
}

afterEach(() => {
	for (const fn of cleanups.splice(0)) {
		try {
			fn();
		} catch {
			/* ignore */
		}
	}
	for (const dir of tmpDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 临时目录清理失败不影响结果 */
		}
	}
});

describe("activate（v3）：路由装配、内存设置与 API 校验", () => {
	it("空临时 dataDir 启动：注册 v3 路由、订阅 onRunEvent，不触碰真实用户目录", () => {
		const { host, dataDir, settingsObj } = makeV3Host();
		expect(host.getSettings()).toBe(settingsObj);
		boot(host);

		expect(host.mock.handlers.onRunEvent?.length).toBe(1);
		expect(host.mock.backgroundTasks.length).toBe(1);
		expect(existsSync(join(dataDir, "plugin-data", "usage-ledger", "ledger.sqlite"))).toBe(true);

		const paths = host.mock.routes.map((r) => `${r.method} ${r.path}`).sort();
		expect(paths).toEqual([
			"GET /api/v3/export",
			"GET /api/v3/import/errors",
			"GET /api/v3/import/status",
			"GET /api/v3/meta",
			"GET /api/v3/overview",
			"GET /api/v3/record/*",
			"GET /api/v3/records",
			"POST /api/v3/grant",
			"POST /api/v3/import/cancel",
			"POST /api/v3/import/pause",
			"POST /api/v3/import/recalc",
			"POST /api/v3/import/resume",
			"POST /api/v3/import/start",
			"POST /api/v3/prices/refresh",
		]);
	});

	it("GET /api/v3/overview?range=today 返回 ok:true，写入一条 live turn 后 kpi.calls 变为 1", async () => {
		const { host } = makeV3Host();
		boot(host);

		const empty = await callRoute(host, "GET", "/api/v3/overview", { range: "today" });
		expect(empty.ok).toBe(true);
		expect(empty.range.key).toBe("today");
		expect(empty.kpi.calls).toBe(0);

		const now = Date.now();
		host.mock.emit("onRunEvent", { type: "turn_start", conversationId: "conv-v3", at: now - 2000 });
		host.mock.emit("onRunEvent", { type: "turn_first_token", conversationId: "conv-v3", at: now - 1500, durationMs: 500 });
		host.mock.emit("onRunEvent", {
			type: "message",
			conversationId: "conv-v3",
			at: now - 100,
			message: {
				role: "assistant",
				model: "grok-4.7",
				provider: "cliproxyapi",
				timestamp: now,
				usageCost: 0.012,
				stopReason: "stop",
			},
		});
		host.mock.emit("onRunEvent", { type: "turn_end", conversationId: "conv-v3", at: now });

		const after = await callRoute(host, "GET", "/api/v3/overview", { range: "today" });
		expect(after.ok).toBe(true);
		expect(after.kpi.calls).toBe(1);
		expect(after.kpi.ok).toBe(1);
		expect(after.kpi.ttft.samples).toBe(1);

		const list = await callRoute(host, "GET", "/api/v3/records", { range: "today" });
		expect(list.ok).toBe(true);
		expect(list.total).toBe(1);
		expect(list.records.length).toBe(1);
		expect(list.records[0].model).toBe("grok-4.7");
		expect(list.records[0].cost).toBe(0.012);
		expect(list.records[0].costSource).toBe("sdk");

		const detail = await callRoute(
			host,
			"GET",
			"/api/v3/record/*",
			{},
			`/api/v3/record/${list.records[0].id}`,
		);
		expect(detail.ok).toBe(true);
		expect(detail.record.id).toBe(list.records[0].id);
	});

	it("from > to 返回 ok:false 且 code 为 bad-range", async () => {
		const { host } = makeV3Host();
		boot(host);

		const now = Date.now();
		const overviewBad = await callRoute(host, "GET", "/api/v3/overview", {
			from: String(now),
			to: String(now - 60_000),
		});
		expect(overviewBad.ok).toBe(false);
		expect(overviewBad.code).toBe("bad-range");

		const recordsBad = await callRoute(host, "GET", "/api/v3/records", {
			from: String(now),
			to: String(now - 60_000),
		});
		expect(recordsBad.ok).toBe(false);
		expect(recordsBad.code).toBe("bad-range");
	});

	it("非法 cursor 返回 ok:false 且 code 为 bad-cursor", async () => {
		const { host } = makeV3Host();
		boot(host);

		const badCursor = await callRoute(host, "GET", "/api/v3/records", {
			range: "today",
			cursor: "not-a-valid-cursor",
		});
		expect(badCursor.ok).toBe(false);
		expect(badCursor.code).toBe("bad-cursor");
	});

	it("meta / import/status / cleanup 正常动作与卸载", async () => {
		const { host } = makeV3Host();
		const cleanup = boot(host);

		const meta = await callRoute(host, "GET", "/api/v3/meta");
		expect(meta.ok).toBe(true);
		expect(meta.meta.schemaVersion).toBe(3);

		const status = await callRoute(host, "GET", "/api/v3/import/status");
		expect(status.ok).toBe(true);
		expect(status.status.phase).toBe("idle");

		cleanup();
		expect(host.mock.handlers.onRunEvent?.length ?? 0).toBe(0);
	});
});
