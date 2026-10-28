/**
 * 实时采集 + 插件装配单测。
 *
 * 两部分：
 *  1. `createLiveCollector`：turn 事件流 → 「每次调用一条记录」的状态机
 *     （TTFT 只认第一包、缺 message 标 incomplete、run_end 兜底）；
 *  2. `activate(host)`：订阅 / 路由 / 徽标 / 定时 / 降级 / 授权 / 与回填的去重。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveCollector } from "../../lib/live.mjs";
import { createLedgerStore, LEDGER_FILE } from "../../lib/ledger.mjs";
import { BACKFILL_STATE_FILE } from "../../lib/sessions.mjs"
import { activate } from "../../index.mjs";
import { createMockHost } from "../support/mock-host.mjs";
import { createMockFs } from "../support/mock-fs.mjs";
import { assistantLine, makeSessionTree, makeTmpDir, sessionHeader, writeSessionFile } from "../support/session-fixtures.mjs";

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

// ─────────────────────────────────────────── activate 装配

/** 调一次已注册的路由，返回应答 JSON。 */
function callRoute(host, method, path, query = {}) {
	const route = host.mock.routes.find((r) => r.method === method && r.path === path);
	if (!route) throw new Error(`路由没注册：${method} ${path}`);
	return new Promise((resolve) => {
		route.handler({ query }, { status: () => {}, json: (payload) => resolve(payload) });
	});
}

/** 等 activate 里的 `void syncNow()` 跑完（回填是异步的）。 */
async function flush(times = 6) {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

function makeHost(overrides = {}) {
	const dataDir = overrides.dataDir ?? makeTmpDir("ul-data-");
	const host = createMockHost({ dataDir, ...overrides });
	return { host, dataDir };
}

let cleanups: Array<() => void> = [];
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
});

describe("activate：装配、订阅、降级", () => {
	it("订阅 onRunEvent 并注册 4 个数据路由 + 3 个 POST 动作", () => {
		const { host } = makeHost();
		boot(host);
		expect(host.mock.handlers.onRunEvent?.length).toBe(1);
		const paths = host.mock.routes.map((r) => `${r.method} ${r.path}`).sort();
		expect(paths).toEqual([
			"GET /api/meta",
			"GET /api/records",
			"GET /api/series",
			"GET /api/summary",
			"POST /api/backfill",
			"POST /api/backfill/stop",
			"POST /api/grant",
		]);
	});

	it("注册徽标刷新与回填两个定时任务 + 后台任务心跳", () => {
		const { host } = makeHost();
		boot(host);
		const ids = host.mock.schedules.map((s) => s.opts?.id).sort();
		expect(ids).toEqual(["usage-ledger-backfill", "usage-ledger-badge"]);
		expect(host.mock.backgroundTasks.length).toBe(1);
	});

	it("没有 fs 时徽标写「仅实时」，看板拿到 live-only 降级信息", async () => {
		const { host } = makeHost();
		boot(host);
		await flush();
		expect(host.mock.lastUiUpdate("usage-ledger-badge")?.badge).toBe("仅实时");
		const meta = await callRoute(host, "GET", "/api/meta");
		expect(meta.ok).toBe(true);
		expect(meta.meta.mode).toBe("live-only");
		expect(meta.meta.grant.required).toBe(true);
		expect(meta.meta.grant.reason).toContain("fs:read");
	});

	it("有 fs 时进入 full 模式，feed 一条 live turn 后 summary 能读出来", async () => {
		const root = makeTmpDir("ul-sessions-");
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: root } });
		boot(host);
		await flush();
		host.mock.emit("onRunEvent", { type: "turn_start", conversationId: "conv-1", at: Date.now() - 3000 });
		host.mock.emit("onRunEvent", {
			type: "turn_first_token",
			conversationId: "conv-1",
			at: Date.now() - 2200,
			durationMs: 800,
		});
		host.mock.emit("onRunEvent", {
			type: "message",
			conversationId: "conv-1",
			at: Date.now() - 1000,
			message: {
				role: "assistant",
				model: "grok-4.7",
				provider: "cliproxyapi",
				timestamp: Date.now() - 1000,
				usageCost: 0.02,
				stopReason: "stop",
			},
		});
		host.mock.emit("onRunEvent", { type: "turn_end", conversationId: "conv-1", at: Date.now() });
		const summary = await callRoute(host, "GET", "/api/summary", { window: "today" });
		expect(summary.ok).toBe(true);
		expect(summary.summary.calls).toBe(1);
		expect(summary.summary.ttft.p50).toBe(800);
		expect(summary.models[0].model).toBe("grok-4.7");
		expect(host.mock.lastUiUpdate("usage-ledger-badge")?.badge).toBe("1/800ms");
	});

	it("账本落到 host.dataDir 的 ledger.jsonl（不写 sessions 目录）", async () => {
		const { host, dataDir } = makeHost();
		boot(host);
		await flush();
		host.mock.emit("onRunEvent", { type: "turn_start", conversationId: "c1", at: Date.now() - 2000 });
		host.mock.emit("onRunEvent", { type: "turn_end", conversationId: "c1", at: Date.now() });
		expect(existsSync(join(dataDir, LEDGER_FILE))).toBe(true);
		const lines = readFileSync(join(dataDir, LEDGER_FILE), "utf8").trim().split("\n");
		expect(lines.length).toBe(1);
		expect(JSON.parse(lines[0]).status).toBe("incomplete");
	});

	it("启动即回填：会话树里的 assistant 行变成记录（token / 真实成本）", async () => {
		const tree = makeSessionTree();
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: tree.root } });
		boot(host);
		await flush();
		const summary = await callRoute(host, "GET", "/api/summary", { window: "all" });
		expect(summary.summary.calls).toBe(1);
		expect(summary.summary.tokens.output).toBe(825);
		expect(summary.summary.cost.amount).toBeCloseTo(0.020144, 6);
		// 回填记录没有 TTFT
		expect(summary.summary.ttft.samples).toBe(0);
	});

	it("回填 + live 同一次调用只留一条（1:1 配对：token 取回填、TTFT 取 live）", async () => {
		const ts = 1_791_774_070_834;
		const root = makeTmpDir("ul-both-");
		writeSessionFile(root, "--p--", "s.jsonl", [
			sessionHeader({ id: "sess-1" }),
			assistantLine({ id: "a1", ts, provider: "cliproxyapi", model: "grok-4.7" }),
		]);
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: root } });
		boot(host);
		await flush();
		host.mock.emit("onRunEvent", { type: "turn_start", conversationId: "conv-1", at: ts - 4000 });
		host.mock.emit("onRunEvent", { type: "turn_first_token", conversationId: "conv-1", at: ts - 3200, durationMs: 800 });
		host.mock.emit("onRunEvent", {
			type: "message",
			conversationId: "conv-1",
			at: ts - 100,
			message: { role: "assistant", model: "grok-4.7", provider: "cliproxyapi", timestamp: ts, usageCost: 0.020144 },
		});
		host.mock.emit("onRunEvent", { type: "turn_end", conversationId: "conv-1", at: ts });
		await flush();
		const records = await callRoute(host, "GET", "/api/records", { window: "all" });
		expect(records.total).toBe(1);
		expect(records.records[0].ttftMs).toBe(800);
		expect(records.records[0].outputTokens).toBe(825);
		expect(records.records[0].sources).toEqual(["backfill", "live"]);
	});

	it("POST /api/backfill：手动回填并把新字节写进账本", async () => {
		const root = makeTmpDir("ul-manual-");
		const file = writeSessionFile(root, "--p--", "s.jsonl", [sessionHeader(), assistantLine({ id: "a1" })]);
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: root, backfillOnStart: false } });
		boot(host);
		await flush();
		expect((await callRoute(host, "GET", "/api/summary", { window: "all" })).summary.calls).toBe(0);
		writeSessionFile(root, "--p--", "s.jsonl", [sessionHeader(), assistantLine({ id: "a1" })]);
		const first = await callRoute(host, "POST", "/api/backfill");
		expect(first.ok).toBe(true);
		expect(first.backfill.records).toBe(1);
		expect(file.endsWith(".jsonl")).toBe(true);
	});

	it("POST /api/grant：用户批准后自动回填，模式从 live-only 变 full", async () => {
		const tree = makeSessionTree();
		const fsApi = createMockFs({ authorized: false });
		const { host } = makeHost({ fs: fsApi, settings: { sessionsDir: tree.root } });
		boot(host);
		await flush();
		expect((await callRoute(host, "GET", "/api/meta")).meta.mode).toBe("live-only");
		const granted = await callRoute(host, "POST", "/api/grant");
		expect(granted.ok).toBe(true);
		expect(fsApi.state.requests.length).toBe(1);
		expect((await callRoute(host, "GET", "/api/meta")).meta.mode).toBe("full");
		expect((await callRoute(host, "GET", "/api/summary", { window: "all" })).summary.calls).toBe(1);
	});

	it("用户拒绝授权：grant 返回 ok:false，仍是 live-only，不抛错", async () => {
		const tree = makeSessionTree();
		const fsApi = createMockFs({ authorized: false, grantOnRequest: false });
		const { host } = makeHost({ fs: fsApi, settings: { sessionsDir: tree.root } });
		boot(host);
		await flush();
		const denied = await callRoute(host, "POST", "/api/grant");
		expect(denied.ok).toBe(false);
		expect(denied.code).toBe("denied");
	});

	it("设置变化（sessionsDir）会重建回填器并重新回填", async () => {
		const treeA = makeSessionTree();
		// treeB 用不同的 sessionId/ts，否则会被账本按 entry / 内容键合并成一条（这正是设计）
		const treeB = { root: makeTmpDir("ul-settings-b-") };
		writeSessionFile(treeB.root, "--proj-b--", "s.jsonl", [
			sessionHeader({ id: "sess-b" }),
			assistantLine({ id: "b1", ts: 1791774000000, model: "model-b" }),
		]);
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: treeA.root } });
		boot(host);
		await flush();
		expect((await callRoute(host, "GET", "/api/meta")).meta.sessionsRoot).toBe(treeA.root);
		host.mock.emitSettings({ sessionsDir: treeB.root });
		await flush();
		expect((await callRoute(host, "GET", "/api/meta")).meta.sessionsRoot).toBe(treeB.root);
		expect((await callRoute(host, "GET", "/api/summary", { window: "all" })).summary.calls).toBe(2);
	});

	it("backfillOnStart:false 时启动不扫盘（fs 读取次数为 0）", async () => {
		const tree = makeSessionTree();
		const fsApi = createMockFs();
		const { host } = makeHost({ fs: fsApi, settings: { sessionsDir: tree.root, backfillOnStart: false } });
		boot(host);
		await flush();
		expect(fsApi.state.reads).toBe(0);
	});

	it("定时回调可直接触发（fireSchedules 里徽标刷新 + 回填都不抛错）", async () => {
		const tree = makeSessionTree();
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: tree.root } });
		boot(host);
		await flush();
		await expect(host.mock.fireSchedules()).resolves.toBeDefined();
		await flush();
		expect((await callRoute(host, "GET", "/api/summary", { window: "all" })).summary.calls).toBe(1);
	});

	it("卸载：注销 onRunEvent 订阅与定时任务", async () => {
		const { host } = makeHost();
		const cleanup = activate(host);
		expect(host.mock.handlers.onRunEvent?.length).toBe(1);
		expect(host.mock.schedules.length).toBe(2);
		cleanup();
		expect(host.mock.handlers.onRunEvent?.length ?? 0).toBe(0);
		expect(host.mock.schedules.length).toBe(0);
		await flush(2);
	});

	it("窗口筛选真的过滤：昨日记录不进 today", async () => {
		const root = makeTmpDir("ul-window-");
		const yesterday = Date.now() - 2 * 86_400_000;
		writeSessionFile(root, "--p--", "s.jsonl", [
			sessionHeader(),
			assistantLine({ id: "a-old", ts: yesterday }),
			assistantLine({ id: "a-new", ts: Date.now() - 1000 }),
		]);
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: root } });
		boot(host);
		await flush();
		expect((await callRoute(host, "GET", "/api/summary", { window: "today" })).summary.calls).toBe(1);
		expect((await callRoute(host, "GET", "/api/summary", { window: "30d" })).summary.calls).toBe(2);
	});

	it("按模型筛选与按状态筛选都生效", async () => {
		const root = makeTmpDir("ul-filter-");
		writeSessionFile(root, "--p--", "s.jsonl", [
			sessionHeader(),
			assistantLine({ id: "a1", ts: Date.now() - 3000, model: "model-a" }),
			assistantLine({ id: "a2", ts: Date.now() - 2000, model: "model-b", stopReason: "error" }),
			assistantLine({ id: "a3", ts: Date.now() - 1000, model: "model-b" }),
		]);
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: root } });
		boot(host);
		await flush();
		const onlyA = await callRoute(host, "GET", "/api/summary", { window: "all", model: "model-a" });
		expect(onlyA.summary.calls).toBe(1);
		const errors = await callRoute(host, "GET", "/api/records", { window: "all", status: "error" });
		expect(errors.total).toBe(1);
		expect(errors.records[0].model).toBe("model-b");
		const paged = await callRoute(host, "GET", "/api/records", { window: "all", pageSize: 2, page: 2 });
		expect(paged.total).toBe(3);
		expect(paged.pages).toBe(2);
		expect(paged.records.length).toBe(1);
	});

	it("趋势接口：默认按小时，day 给日期桶", async () => {
		const root = makeTmpDir("ul-series-");
		writeSessionFile(root, "--p--", "s.jsonl", [sessionHeader(), assistantLine({ id: "a1", ts: Date.now() - 1000 })]);
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: root } });
		boot(host);
		await flush();
		const hourly = await callRoute(host, "GET", "/api/series", { window: "all" });
		expect(hourly.series.length).toBe(1);
		expect(hourly.series[0].hour).toMatch(/T\d{2}:00:00$/);
		const daily = await callRoute(host, "GET", "/api/series", { window: "all", bucket: "day" });
		expect(daily.series[0].hour).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("activate：覆盖率、续批与 2.0.1 账本迁移", () => {
	const scheduleIds = (host) => host.mock.schedules.map((s) => s.opts?.id);

	it("meta 暴露文件覆盖率（已导入 X/M 个会话文件）与 importing 标记", async () => {
		const tree = makeSessionTree({ projects: 1, filesPerProject: 2 });
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: tree.root } });
		boot(host);
		await flush();
		const meta = (await callRoute(host, "GET", "/api/meta")).meta;
		expect(meta.coverage).toEqual({ imported: 2, eligible: 2, remaining: 0 });
		expect(meta.importing).toBe(false);
	});

	it("徽标 tooltip 带文件覆盖率（不让用户以为已经导完）", async () => {
		const tree = makeSessionTree();
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: tree.root } });
		boot(host);
		await flush();
		const patch = host.mock.lastUiUpdate("usage-ledger-badge");
		expect(patch.hint).toContain("已导入 1/1 个会话文件");
	});

	it("批次没扫完就自动续批：扫完后 importing 转 false 并摘掉续批定时任务", async () => {
		const tree = makeSessionTree({ projects: 1, filesPerProject: 201 });
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: tree.root } });
		boot(host);
		await flush();
		expect(scheduleIds(host)).toContain("usage-ledger-backfill-continue");
		const before = (await callRoute(host, "GET", "/api/meta")).meta;
		expect(before.importing).toBe(true);
		expect(before.coverage.eligible).toBe(201);
		expect(before.coverage.imported).toBe(200);
		// 触发续批：下一批把剩下 1 个扫完
		await host.mock.fireSchedules();
		await flush(20);
		const after = (await callRoute(host, "GET", "/api/meta")).meta;
		expect(after.coverage).toEqual({ imported: 201, eligible: 201, remaining: 0 });
		expect(after.importing).toBe(false);
		expect(scheduleIds(host)).not.toContain("usage-ledger-backfill-continue");
	});

	it("POST /api/backfill/stop：用户停止后不再续批", async () => {
		const tree = makeSessionTree({ projects: 1, filesPerProject: 201 });
		const { host } = makeHost({ fs: createMockFs(), settings: { sessionsDir: tree.root } });
		boot(host);
		await flush();
		expect(scheduleIds(host)).toContain("usage-ledger-backfill-continue");
		const stopped = await callRoute(host, "POST", "/api/backfill/stop");
		expect(stopped.ok).toBe(true);
		expect(scheduleIds(host)).not.toContain("usage-ledger-backfill-continue");
	});

	it("升级到 2.0.1：污染的 2.0.0 账本被重建（回填记录丢弃、offset 清零重新导入）", async () => {
		const tree = makeSessionTree();
		const { host, dataDir } = makeHost({ fs: createMockFs(), settings: { sessionsDir: tree.root } });
		// 2.0.0 留下的污染记录：把多次真实调用折叠成一条，成本是假的 9 美元
		const polluted = {
			ts: 1_792_493_011_970,
			sessionId: "sess-1",
			entryId: "a1",
			provider: "cliproxyapi",
			model: "grok-4.7",
			inputTokens: 1,
			outputTokens: 1,
			totalTokens: 2,
			costUsd: 9,
			status: "ok",
			source: "backfill",
			id: "e:sess-1:a1",
			sources: ["backfill"],
		};
		writeFileSync(join(dataDir, LEDGER_FILE), `${JSON.stringify(polluted)}\n`, "utf8");
		// 老版本的状态文件（没有 ledgerSchema，offset 已到文件尾 → 不重建就不会重读）
		writeFileSync(join(dataDir, BACKFILL_STATE_FILE), JSON.stringify({ version: 1, root: tree.root, files: {} }), "utf8");
		boot(host);
		await flush();
		const meta = (await callRoute(host, "GET", "/api/meta")).meta;
		expect(meta.ledger.records).toBe(1);
		const rows = (await callRoute(host, "GET", "/api/records", { window: "all" })).records;
		expect(rows.length).toBe(1);
		// 假数字被清掉，换成会话里真实的一条调用
		expect(rows[0].costUsd).toBeCloseTo(0.020144, 6);
		expect(rows[0].totalTokens).toBe(9286);
		// 迁移只跑一次：状态文件里记了 ledgerSchema
		const state = JSON.parse(readFileSync(join(dataDir, BACKFILL_STATE_FILE), "utf8"));
		expect(Number(state.ledgerSchema)).toBe(2);
	});
});
