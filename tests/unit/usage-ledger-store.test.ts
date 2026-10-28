/**
 * 账本存储单测：归一到记录、去重合并、append-only 折叠、崩溃容错、压实。
 *
 * 这是 2.0 的地基：去重错了就会「回填 + live 各算一次」，成本直接翻倍。
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	LEDGER_FILE,
	RECORD_SOURCES,
	RECORD_STATUS,
	callKey,
	createLedgerStore,
	entryKey,
	mergeRecord,
	normalizeRecord,
	recordId,
} from "../../lib/ledger.mjs";

function tmp() {
	return mkdtempSync(join(tmpdir(), "ul-ledger-"));
}

const LIVE = {
	ts: 1791774070834,
	conversationId: "conv-1",
	provider: "cliproxyapi",
	model: "grok-4.7",
	costUsd: 0.020144,
	durationMs: 4321,
	ttftMs: 733,
	stopReason: "stop",
	status: "ok",
	source: "live",
};

const BACKFILL = {
	ts: 1791774070834,
	sessionId: "sess-1",
	entryId: "a1",
	provider: "cliproxyapi",
	model: "grok-4.7",
	thinkingLevel: "high",
	inputTokens: 7309,
	outputTokens: 825,
	cacheReadTokens: 1152,
	cacheWriteTokens: 0,
	reasoningTokens: 558,
	totalTokens: 9286,
	costUsd: 0.020144,
	durationMs: 4321,
	stopReason: "stop",
	status: "ok",
	hasUsage: true,
	source: "backfill",
};

describe("normalizeRecord：形状归一与垃圾输入", () => {
	it("字符串/数组/null 一律丢弃", () => {
		expect(normalizeRecord(null)).toBeNull();
		expect(normalizeRecord(undefined)).toBeNull();
		expect(normalizeRecord("x")).toBeNull();
		expect(normalizeRecord([])).toBeNull();
		expect(normalizeRecord(42)).toBeNull();
	});

	it("空记录（无时间无模型无 token 无成本）没有统计价值，丢弃", () => {
		expect(normalizeRecord({})).toBeNull();
		expect(normalizeRecord({ source: "live" })).toBeNull();
	});

	it("非法数值（负数 / NaN / 字符串数字）按规则处理：字符串数字收下、负数与 NaN 丢弃", () => {
		const rec = normalizeRecord({ ts: "100", model: "m", inputTokens: -5, outputTokens: Number.NaN, costUsd: "0.5" });
		expect(rec.ts).toBe(100);
		expect(rec.inputTokens).toBeNull();
		expect(rec.outputTokens).toBeNull();
		expect(rec.costUsd).toBe(0.5);
	});

	it("source 只认 live / backfill，其它回落 backfill", () => {
		expect(normalizeRecord({ ts: 1, model: "m", source: "live" }).source).toBe(RECORD_SOURCES.live);
		expect(normalizeRecord({ ts: 1, model: "m", source: "hack" }).source).toBe(RECORD_SOURCES.backfill);
	});

	it("status 白名单：非法值回落 ok", () => {
		expect(normalizeRecord({ ts: 1, model: "m", status: "weird" }).status).toBe(RECORD_STATUS.ok);
		expect(normalizeRecord({ ts: 1, model: "m", status: "incomplete" }).status).toBe(RECORD_STATUS.incomplete);
	});

	it("sources 去重合并并排序", () => {
		const rec = normalizeRecord({ ...BACKFILL, sources: ["backfill", "live", "backfill"] });
		expect(rec.sources).toEqual(["backfill", "live"]);
	});

	it("文本字段去首尾空格，空串算缺失", () => {
		const rec = normalizeRecord({ ts: 1, model: "  grok-4.7  ", provider: "   ", thinkingLevel: "" });
		expect(rec.model).toBe("grok-4.7");
		expect(rec.provider).toBeNull();
		expect(rec.thinkingLevel).toBeNull();
	});
});

describe("去重键：entryKey / callKey / recordId", () => {
	it("entryKey 带 sessionId 前缀，避免跨会话 entry id 撞车", () => {
		expect(entryKey("s1", "a1")).toBe("e:s1:a1");
		expect(entryKey("s2", "a1")).not.toBe(entryKey("s1", "a1"));
		expect(entryKey(null, "a1")).toBe("e:-:a1");
		expect(entryKey("s1", "")).toBe("");
	});

	it("callKey 优先用 ts+model+provider（live 与回填的交集）", () => {
		expect(callKey({ ts: 100, model: "m", provider: "p" })).toBe("c:100:m:p");
		expect(callKey({ ts: 100, model: "m" })).toBe("c:100:m:-");
		expect(callKey({ conversationId: "c", turnStartAt: 50, model: "m" })).toBe("l:c:50:m");
		expect(callKey({})).toBe("");
	});

	it("recordId：entry 键 > 内容键 > 退化键", () => {
		expect(recordId({ sessionId: "s", entryId: "e", ts: 1, model: "m" })).toBe("e:s:e");
		expect(recordId({ ts: 1, model: "m", provider: "p" })).toBe("c:1:m:p");
		expect(recordId({ source: "live", conversationId: "c" })).toBe("x:live:0:-:c");
	});

	it("显式 id 优先保留（前端行的 key 稳定）", () => {
		expect(normalizeRecord({ ts: 1, model: "m", id: "manual" }).id).toBe("manual");
	});
});

describe("mergeRecord：回填与 live 合并语义", () => {
	it("回填补齐 live 的 token / hasUsage，TTFT 保留 live 的值", () => {
		const live = normalizeRecord(LIVE);
		const back = normalizeRecord(BACKFILL);
		const merged = mergeRecord(live, back);
		expect(merged.inputTokens).toBe(7309);
		expect(merged.outputTokens).toBe(825);
		expect(merged.reasoningTokens).toBe(558);
		expect(merged.ttftMs).toBe(733);
		expect(merged.hasUsage).toBe(true);
		expect(merged.model).toBe("grok-4.7");
	});

	it("反向合并（回填先到、live 后到）同样不翻倍", () => {
		const merged = mergeRecord(normalizeRecord(BACKFILL), normalizeRecord(LIVE));
		expect(merged.ttftMs).toBe(733);
		expect(merged.outputTokens).toBe(825);
		// entryId 以先到者为准
		expect(merged.entryId).toBe("a1");
	});

	it("数值取已知值的大者：部分数据不会把已知值清零", () => {
		const a = normalizeRecord({ ts: 1, model: "m", durationMs: 500 });
		const b = normalizeRecord({ ts: 1, model: "m", durationMs: null });
		expect(mergeRecord(a, b).durationMs).toBe(500);
		expect(mergeRecord(b, a).durationMs).toBe(500);
	});

	it("status：incomplete 会被真实状态升级，不会把 ok 降级成 incomplete", () => {
		const incomplete = normalizeRecord({ ts: 1, model: "m", status: "incomplete" });
		const ok = normalizeRecord({ ts: 1, model: "m", status: "ok", outputTokens: 10 });
		expect(mergeRecord(incomplete, ok).status).toBe("ok");
		expect(mergeRecord(ok, incomplete).status).toBe("ok");
	});

	it("status：error 是真实结果，不能被后来的 ok 抹掉语义（保住 error 优先的场景由调用方决定）", () => {
		const error = normalizeRecord({ ts: 1, model: "m", status: "error" });
		const ok = normalizeRecord({ ts: 1, model: "m", status: "ok" });
		// 同一调用只会有一次真实结局：以「后到的非 incomplete」为准（error → ok 视为拿到更完整信息）
		expect(mergeRecord(error, ok).status).toBe("ok");
	});

	it("source：任一方是 live 就记 live，sources 记全两种来源", () => {
		const merged = mergeRecord(normalizeRecord(LIVE), normalizeRecord(BACKFILL));
		expect(merged.source).toBe("live");
		expect(merged.sources).toEqual(["backfill", "live"]);
	});

	it("id 优先保留 entry 身份（回填稳定 id，跨重启不变）", () => {
		const merged = mergeRecord(normalizeRecord(LIVE), normalizeRecord(BACKFILL));
		expect(merged.id).toBe("e:sess-1:a1");
		// 两边都没 entry 身份时才用内容键
		expect(mergeRecord(normalizeRecord({ ...LIVE, ts: 1 }), normalizeRecord({ ...LIVE, ts: 1 })).id).toBe(
			"c:1:grok-4.7:cliproxyapi",
		);
	});
});

describe("createLedgerStore：写入 / 折叠 / 容错", () => {
	it("新记录 added:true，重复（同 entryKey）merged:true 且只留一条", () => {
		const store = createLedgerStore({ dir: tmp() });
		expect(store.add(BACKFILL).added).toBe(true);
		const second = store.add({ ...BACKFILL, outputTokens: 900 });
		expect(second.added).toBe(false);
		expect(second.merged).toBe(true);
		expect(store.size).toBe(1);
		expect(store.list()[0].outputTokens).toBe(900);
	});

	it("live 与回填先后到达各一次，结果只有一条且 token 与 TTFT 都在", () => {
		const dir = tmp();
		const store = createLedgerStore({ dir });
		store.add(LIVE);
		store.add(BACKFILL);
		expect(store.size).toBe(1);
		const only = store.list()[0];
		expect(only.ttftMs).toBe(733);
		expect(only.inputTokens).toBe(7309);
		expect(only.sources).toEqual(["backfill", "live"]);
		// 重启后仍然只有一条（log-structured 折叠有效）
		const reloaded = createLedgerStore({ dir });
		reloaded.load();
		expect(reloaded.size).toBe(1);
		expect(reloaded.list()[0].outputTokens).toBe(825);
	});

	it("不同调用不会被误合并（同模型不同 ts / 同 ts 不同模型）", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(BACKFILL);
		store.add({ ...BACKFILL, entryId: "a2", ts: 1791774099999 });
		store.add({ ...BACKFILL, entryId: "a3", model: "deepseek-v4" });
		expect(store.size).toBe(3);
	});

	it("跨会话相同的 entry id 不会撞车（sessionId 进键）", () => {
		const store = createLedgerStore({ dir: tmp() });
		// 不同时间 → 内容键也不同，但 entry id 同名；sessionId 必须把两者分开
		store.add({ ...BACKFILL, sessionId: "s1", entryId: "a1", ts: 1000 });
		store.add({ ...BACKFILL, sessionId: "s2", entryId: "a1", ts: 2000, outputTokens: 111 });
		expect(store.size).toBe(2);
		expect(store.list().map((r) => r.id)).toEqual(["e:s1:a1", "e:s2:a1"]);
	});

	it("同一毫秒、同模型、同 provider 的两条不同 entry 是两次调用（2.0.0 曾误合并）", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add({ ...BACKFILL, sessionId: "s1", entryId: "a1" });
		store.add({ ...BACKFILL, sessionId: "s2", entryId: "a1" });
		// entry 身份不同 → 两次真实调用，必须各留一条（同毫秒不是同一次调用）
		expect(store.size).toBe(2);
	});

	it("落盘文件是 JSONL，一行一条记录", () => {
		const dir = tmp();
		const store = createLedgerStore({ dir });
		store.add(BACKFILL);
		store.add(LIVE);
		const text = readFileSync(join(dir, LEDGER_FILE), "utf8");
		const lines = text.trim().split("\n");
		expect(lines.length).toBe(2);
		for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
	});

	it("文件不存在时 load 返回空账本，不抛错", () => {
		const store = createLedgerStore({ dir: join(tmp(), "not-exist") });
		const res = store.load();
		expect(res.records).toBe(0);
		expect(store.size).toBe(0);
	});

	it("崩溃遗留的半行被忽略，其余行照常读入", () => {
		const dir = tmp();
		writeFileSync(join(dir, LEDGER_FILE), `${JSON.stringify(normalizeRecord(BACKFILL))}\n{"ts":1,"model":"trunc`, "utf8");
		const store = createLedgerStore({ dir });
		const res = store.load();
		expect(res.records).toBe(1);
		expect(res.bad).toBe(1);
	});

	it("坏 JSON 行计入 bad，不影响其余记录", () => {
		const dir = tmp();
		writeFileSync(
			join(dir, LEDGER_FILE),
			`not-json\n${JSON.stringify(normalizeRecord(BACKFILL))}\n[]\n`,
			"utf8",
		);
		const store = createLedgerStore({ dir });
		const res = store.load();
		expect(res.records).toBe(1);
		expect(res.bad).toBe(2);
	});

	it("冗余行过多时自动压实：文件行数回落到记录数", () => {
		const dir = tmp();
		const store = createLedgerStore({ dir });
		for (let i = 0; i < 5; i++) store.add({ ...BACKFILL, outputTokens: 100 + i });
		expect(readFileSync(join(dir, LEDGER_FILE), "utf8").trim().split("\n").length).toBe(5);
		const reloaded = createLedgerStore({ dir });
		const res = reloaded.load();
		expect(res.records).toBe(1);
		expect(res.compactions).toBe(1);
		expect(readFileSync(join(dir, LEDGER_FILE), "utf8").trim().split("\n").length).toBe(1);
		expect(reloaded.list()[0].outputTokens).toBe(104);
	});

	it("没有 dir 时退化为纯内存账本（不抛错、persistence:false）", () => {
		const store = createLedgerStore({});
		expect(store.add(BACKFILL).added).toBe(true);
		expect(store.stats().persistence).toBe(false);
		expect(store.load().records).toBe(0);
	});

	it("写盘失败降级为内存账本：统计仍可用，只记一次 warn", () => {
		const log = vi.fn();
		const fsStub = {
			existsSync: () => false,
			mkdirSync: () => {
				throw new Error("EACCES: mock");
			},
			readFileSync: () => "",
			writeFileSync: () => {},
			appendFileSync: () => {},
			renameSync: () => {},
		};
		const store = createLedgerStore({ dir: join(tmp(), "x"), fs: fsStub, log });
		expect(store.add(BACKFILL).added).toBe(true);
		expect(store.add(LIVE).merged).toBe(true);
		expect(store.stats().writeErrors).toBeGreaterThan(0);
		expect(log.mock.calls.filter((c) => c[0] === "warn").length).toBe(1);
	});

	it("addMany 汇总 added / merged / invalid", () => {
		const store = createLedgerStore({ dir: tmp() });
		const res = store.addMany([BACKFILL, LIVE, null, "bad"]);
		expect(res).toEqual({ added: 1, merged: 1, paired: 1, invalid: 2 });
		expect(store.size).toBe(1);
	});

	it("query 按时间窗过滤，list 按 ts 升序", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.addMany([
			{ ...BACKFILL, entryId: "a1", ts: 300 },
			{ ...BACKFILL, entryId: "a2", ts: 100 },
			{ ...BACKFILL, entryId: "a3", ts: 200 },
		]);
		expect(store.list().map((r) => r.ts)).toEqual([100, 200, 300]);
		expect(store.query({ fromMs: 150, toMs: 250 }).map((r) => r.ts)).toEqual([200]);
		expect(store.query({ fromMs: 250 }).length).toBe(1);
	});

	it("stats 暴露记录数、行数、路径（看板状态行要显示）", () => {
		const dir = tmp();
		const store = createLedgerStore({ dir });
		store.load();
		store.add(BACKFILL);
		const st = store.stats();
		expect(st.records).toBe(1);
		expect(st.path).toBe(join(dir, LEDGER_FILE));
		expect(st.persistence).toBe(true);
		expect(existsSync(st.path)).toBe(true);
	});
});

// ──────────────────────────────────────────────────────────── P0：2.0.1

const P0_TS = 1_792_493_011_970; // 实测里一条键被 16 次真实调用共用的毫秒

/** 回填记录：身份 = 会话文件 + entry id（同毫秒也能多条，各自独立）。 */
function backfillOf(entryId: string, extra: Record<string, unknown> = {}) {
	return {
		ts: P0_TS,
		sessionFile: "C:\sessions\--proj--\2026-10-12T03-00-10-854Z_uuid.jsonl",
		sessionId: "sess-1",
		entryId,
		provider: "xiaomi",
		model: "mimo-v2.6-pro",
		inputTokens: 1000,
		outputTokens: 100,
		totalTokens: 1100,
		costUsd: 0.5,
		hasUsage: true,
		status: "ok",
		source: RECORD_SOURCES.backfill,
		...extra,
	};
}

/** live 记录：有 TTFT、没 token；身份 = 对话 + turn 起点。 */
function liveOf(conversationId: string, extra: Record<string, unknown> = {}) {
	return {
		ts: P0_TS,
		conversationId,
		turnStartAt: P0_TS - 800,
		provider: "xiaomi",
		model: "mimo-v2.6-pro",
		costUsd: 0.5,
		durationMs: 4000,
		ttftMs: 700,
		status: "ok",
		source: RECORD_SOURCES.live,
		...extra,
	};
}

describe("P0 修复：回填身份唯一（禁止 ts+model+provider 去重）", () => {
	it("同一毫秒同模型的 16 条真实调用（entryId 各不相同）必须是 16 条记录", () => {
		const store = createLedgerStore({ dir: tmp() });
		for (let i = 0; i < 16; i++) store.add(backfillOf(`a${i}`));
		expect(store.size).toBe(16);
		expect(store.list().every((r) => r.id.startsWith("e:"))).toBe(true);
	});

	it("sessionFile 进身份键：同名 entryId 在不同会话文件里不撞车", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(backfillOf("a1", { sessionFile: "C:\s\one.jsonl" }));
		store.add(backfillOf("a1", { sessionFile: "C:\s\two.jsonl" }));
		expect(store.size).toBe(2);
	});

	it("同一个 entry 重读（同文件同 id）仍然只留一条（增量回填不会翻倍）", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(backfillOf("a1"));
		store.add(backfillOf("a1", { outputTokens: 222 }));
		expect(store.size).toBe(1);
		expect(store.list()[0].outputTokens).toBe(222);
	});

	it("没有 entry 身份的回填记录不靠 ts+model+provider 合并（宁可多一条）", () => {
		const store = createLedgerStore({ dir: tmp() });
		const noId = { ...backfillOf("x"), entryId: null, sessionFile: null, sessionId: null };
		store.add(noId);
		store.add({ ...noId });
		expect(store.size).toBe(2);
	});
});

describe("P0 修复：live ↔ 回填严格 1:1 贪心配对", () => {
	it("1 条回填 + 3 条同毫秒同模型 live：只配对一条，另两条各自独立（绝不塌成 1 条）", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(backfillOf("a1"));
		const res = [store.add(liveOf("conv-1")), store.add(liveOf("conv-2")), store.add(liveOf("conv-3"))];
		expect(store.size).toBe(3);
		expect(res.filter((r) => r.paired).length).toBe(1);
		const records = store.list();
		expect(records.filter((r) => r.paired === true).length).toBe(1);
		const liveOnly = records.filter((r) => r.paired !== true);
		expect(liveOnly.length).toBe(2);
		// 没配上对的那两条：各自保留 TTFT，token 仍是 null（不许被别人的 token 污染）
		for (const r of liveOnly) {
			expect(r.ttftMs).toBe(700);
			expect(r.inputTokens).toBeNull();
		}
		expect(store.stats().liveOnly).toBe(2);
		expect(store.stats().paired).toBe(1);
	});

	it("3 条回填 + 1 条 live：只配对一条，其余两条的 TTFT 仍是 null", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(backfillOf("a1"));
		store.add(backfillOf("a2"));
		store.add(backfillOf("a3"));
		const res = store.add(liveOf("conv-1"));
		expect(res.paired).toBe(true);
		expect(store.size).toBe(3);
		const withTtft = store.list().filter((r) => r.ttftMs !== null);
		expect(withTtft.length).toBe(1);
		expect(withTtft[0].ttftMs).toBe(700);
		expect(withTtft[0].inputTokens).toBe(1000);
		// 没配上对的两条回填：token 在、TTFT 为 null，一条都不能少
		expect(store.list().filter((r) => r.ttftMs === null).length).toBe(2);
		expect(store.list().every((r) => r.status === "ok")).toBe(true);
	});

	it("配对条件：|ts 差| <= 3000ms 配，超出就各自留着", () => {
		const near = createLedgerStore({ dir: tmp() });
		near.add(backfillOf("a1"));
		near.add(liveOf("conv-near", { ts: P0_TS + 3000 }));
		expect(near.size).toBe(1);
		const far = createLedgerStore({ dir: tmp() });
		far.add(backfillOf("a1"));
		far.add(liveOf("conv-far", { ts: P0_TS + 3001 }));
		expect(far.size).toBe(2);
	});

	it("配对条件：model 或 provider 不同就不配", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(backfillOf("a1"));
		store.add(liveOf("conv-model", { model: "grok-4.7" }));
		store.add(liveOf("conv-provider", { provider: "other" }));
		expect(store.size).toBe(3);
	});

	it("2 条回填 + 1 条 live：只有一条被认领，另一条不许被吞", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(backfillOf("a1"));
		store.add(backfillOf("a2"));
		store.add(liveOf("conv-1"));
		expect(store.size).toBe(2);
		expect(store.list().filter((r) => r.paired === true).length).toBe(1);
		expect(store.list().filter((r) => r.ttftMs === null).length).toBe(1);
	});

	it("贪心取最接近的 ts（不是随便一条）", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(backfillOf("a1", { ts: P0_TS - 2000 }));
		store.add(backfillOf("a2", { ts: P0_TS }));
		store.add(liveOf("conv-1", { ts: P0_TS + 100 }));
		const paired = store.list().find((r) => r.paired === true);
		expect(paired?.entryId).toBe("a2");
	});

	it("配对口径：token/成本取回填，TTFT/耗时取 live，状态优先真实结局", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(backfillOf("a1", { status: "incomplete", hasUsage: false, inputTokens: null, costUsd: null }));
		store.add(liveOf("conv-1", { durationMs: 4321 }));
		const only = store.list()[0];
		expect(store.size).toBe(1);
		expect(only.ttftMs).toBe(700);
		expect(only.durationMs).toBe(4321);
		expect(only.status).toBe("ok");
		expect(only.paired).toBe(true);
		expect(only.sources).toEqual(["backfill", "live"]);
		expect(only.id.startsWith("e:")).toBe(true);
	});

	it("配对结果落盘后重启仍然是同一条（log-structured 折叠）", () => {
		const dir = tmp();
		const store = createLedgerStore({ dir });
		store.add(backfillOf("a1"));
		store.add(liveOf("conv-1"));
		expect(store.size).toBe(1);
		const reloaded = createLedgerStore({ dir });
		reloaded.load();
		expect(reloaded.size).toBe(1);
		expect(reloaded.list()[0].ttftMs).toBe(700);
		expect(reloaded.list()[0].inputTokens).toBe(1000);
		expect(reloaded.list()[0].paired).toBe(true);
	});

	it("配过对的记录不会被第二条 live 再次认领", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(liveOf("conv-1"));
		store.add(backfillOf("a1"));
		expect(store.size).toBe(1);
		store.add(liveOf("conv-2"));
		// conv-2 没有回填可配 → 自己一条，不是并进已配对的那条
		expect(store.size).toBe(2);
	});
});

describe("账本重建（2.0.0 污染数据的一次性迁移）", () => {
	it("丢弃回填来源记录、把配过对的 live 退回纯 live，并压实文件", () => {
		const dir = tmp();
		const store = createLedgerStore({ dir });
		store.add(backfillOf("a1"));
		store.add(liveOf("conv-1")); // 与 a1 配对 → 变成「回填 + live」混合记录
		store.add(backfillOf("a2"));
		expect(store.size).toBe(2);
		const rebuilt = store.rebuild();
		expect(rebuilt.ok).toBe(true);
		expect(rebuilt.dropped).toBe(1); // a2 是纯回填
		expect(rebuilt.reset).toBe(1); // 混合记录退回 live
		const records = store.list();
		expect(records.length).toBe(1);
		const only = records[0];
		expect(only.source).toBe(RECORD_SOURCES.live);
		expect(only.sources).toEqual(["live"]);
		expect(only.paired).toBe(false);
		expect(only.inputTokens).toBeNull();
		expect(only.costUsd).toBeNull();
		expect(only.ttftMs).toBe(700);
		// 文件也重建了：读回来还是 1 条纯 live
		const reloaded = createLedgerStore({ dir });
		reloaded.load();
		expect(reloaded.size).toBe(1);
		expect(reloaded.list()[0].inputTokens).toBeNull();
	});

	it("干净账本上 rebuild 是 no-op（不误删、不重复压实）", () => {
		const store = createLedgerStore({ dir: tmp() });
		store.add(liveOf("conv-1"));
		const before = store.stats().compactions;
		const rebuilt = store.rebuild();
		expect(rebuilt).toEqual({ ok: true, dropped: 0, reset: 0, kept: 1 });
		expect(store.size).toBe(1);
		expect(store.stats().compactions).toBe(before);
	});
});
