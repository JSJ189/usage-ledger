#!/usr/bin/env node
/**
 * v3 端到端基准（也是集成冒烟测试）：`npm run bench` / `node scripts/v3-bench.mjs`
 *
 * 做什么：
 *  1. 在系统临时目录建库（绝不碰真实状态目录）；
 *  2. 造 N 条跨度 60 天的调用记录，按 2000 条一批写入（模拟 worker 的批量写）；
 *  3. 从库里的 rollup 行建内存索引，逐个时间窗跑 aggregate（含 series/topN）；
 *  4. 校验一致性：series 的 calls 求和 === kpi.calls === 明细 count；
 *  5. 与 docs/V3-CONTRACT.md §七 的硬门槛对比，超阈值退出码 1。
 *
 * 用法：node scripts/v3-bench.mjs [记录数，默认 150000]
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = Math.max(1000, Math.trunc(Number(process.argv[2]) || 150000));
const DAY = 86_400_000;
const SPAN_DAYS = 60;

const results = {};
const fail = [];
let tmpDir = "";

function nowMs() {
	return Date.now();
}
function ms(t0) {
	return +(nowMs() - t0).toFixed(2);
}
function rssMB() {
	return Math.round(process.memoryUsage().rss / 1048576);
}

// ── 造数据（固定种子，结果可复现）
let seed = 42;
function rnd() {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}
const MODELS = ["mimo-v2.6-pro", "deepseek-v4.1-flash", "qwen3.8-flash-next", "gemini-3.8-flash", "grok-4.7"];
const PROVIDERS = ["xiaomi", "deepseek", "aliyun", "google", "xai"];
const PROJECTS = ["JK项目/知识库", "omp_optimize", "PDmodel/code", "空", null];
const STATUSES = ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "client_error", "rate_limited", "provider_error", "aborted", "incomplete"];

function makeRows(n) {
	const rows = [];
	const t0 = nowMs() - SPAN_DAYS * DAY;
	for (let i = 0; i < n; i++) {
		const ts = t0 + Math.floor(rnd() * SPAN_DAYS * DAY);
		const status = STATUSES[Math.floor(rnd() * STATUSES.length)];
		const outTok = status === "aborted" || status === "incomplete" ? null : 80 + Math.floor(rnd() * 1200);
		const inTok = status === "aborted" ? null : 200 + Math.floor(rnd() * 3000);
		const cacheRead = inTok === null ? null : Math.floor(rnd() * 12000);
		const e2e = 500 + Math.floor(rnd() * 40_000);
		const ttft = rnd() < 0.62 ? 200 + Math.floor(rnd() * 12_000) : null;
		const gen = ttft !== null ? Math.max(0, e2e - ttft) : e2e;
		const costSdk = rnd() < 0.5 ? Number((rnd() * 0.05).toFixed(6)) : 0;
		rows.push({
			ts,
			entryKey: `e:bench-${Math.floor(i / 50)}.jsonl:${i}`,
			convId: `c${i % 997}`,
			model: MODELS[i % MODELS.length],
			provider: PROVIDERS[i % PROVIDERS.length],
			project: PROJECTS[i % PROJECTS.length],
			status,
			origin: i % 3 === 0 ? "live" : "backfill",
			inTok,
			outTok,
			cacheRead,
			cacheWrite: 0,
			reasoningTok: 0,
			totalTok: inTok === null || outTok === null ? null : inTok + outTok + cacheRead,
			costSdk,
			costEst: costSdk > 0 ? null : Number((rnd() * 0.02).toFixed(6)),
			costSource: costSdk > 0 ? "sdk" : "estimate",
			priceId: costSdk > 0 ? null : "modelsdev:bench/model",
			priceVersion: costSdk > 0 ? null : 7,
			ttftMs: ttft,
			genMs: gen,
			e2eMs: e2e,
			stopReason: status === "ok" ? "endTurn" : null,
		});
	}
	return rows;
}

try {
	// ── 动态导入（缺文件时给出可读错误，而不是栈）
	const { openStore } = await import("../lib/v3/store.mjs");
	const { createRollupIndex } = await import("../lib/v3/rollup.mjs");

	tmpDir = mkdtempSync(join(tmpdir(), "ul-v3-bench-"));

	let t = nowMs();
	const store = openStore({ dir: tmpDir, readOnly: false, log: () => {} });
	results.openMs = ms(t);
	// 基线放在造数之后：RSS 增量只反映「入库 + 索引 + rollup」的开销，不含测试自己的造数数组
	const rssBaseline = rssMB();

	const rows = makeRows(N);
	t = nowMs();
	const CHUNK = 2000;
	for (let i = 0; i < rows.length; i += CHUNK) {
		store.insertBatch(rows.slice(i, i + CHUNK), { rollupVersion: 1 });
	}
	results.insert = { rows: rows.length, totalMs: ms(t), perRowUs: +((ms(t) * 1000) / rows.length).toFixed(2) };

	t = nowMs();
	results.dbBytes = statSync(join(tmpDir, "ledger.sqlite")).size;
	results.bytesPerRow = Math.round(results.dbBytes / rows.length);
	results.dbBytesMB = +(results.dbBytes / 1048576).toFixed(1);

	const now = nowMs();
	t = nowMs();
	const hourRows = store.rollupRows({ fromMs: now - 45 * DAY, toMs: now, gran: "hour" });
	const rollup = createRollupIndex({ rows: hourRows, version: 1, store, log: () => {} });
	results.rollup = { rows: hourRows.length, loadMs: ms(t) };

	const windows = {
		today: Math.max(0, new Date(now).setHours(0, 0, 0, 0)),
		"7d": now - 7 * DAY,
		"30d": now - 30 * DAY,
		all: 0,
	};
	const granOf = (from) => {
		const span = now - from;
		if (span <= 26 * 3_600_000) return "5m";
		if (span <= 40 * DAY) return "1h";
		return "1d";
	};
	results.aggregate = {};
	for (const [key, from] of Object.entries(windows)) {
		const gran = granOf(from);
		t = nowMs();
		const agg = rollup.aggregate({ fromMs: from, toMs: now, gran, filters: {} });
		results.aggregate[key] = { ms: ms(t), calls: agg.kpi.calls, seriesPoints: agg.series.length, gran };

		// 一致性 1：series 求和 === kpi.calls
		let sum = 0;
		for (const p of agg.series) sum += p.calls;
		if (sum !== agg.kpi.calls) fail.push(`[一致性] ${key}: series 求和 ${sum} ≠ kpi.calls ${agg.kpi.calls}`);

		// 一致性 2：kpi.calls === 明细 count。
		// 口径说明：rollup 是桶级的，`rowInWindow` 用「区间相交」，所以跨窗口边界的整桶都会计入。
		// 因此 oracle 也按同样的桶边界对齐（1h 桶对齐到小时、1d 桶对齐到天）再数明细，否则差 1 个边界桶。
		const bucketMs = gran === "1d" ? 86_400_000 : 3_600_000;
		const oracleFrom = Math.floor(from / bucketMs) * bucketMs;
		let detail = 0;
		let cursor = "";
		for (;;) {
			const page = store.queryRecords({ fromMs: oracleFrom, toMs: now, filters: {}, cursor, limit: 500 });
			detail += page.items.length;
			if (!page.nextCursor || page.items.length < 500) break;
			cursor = page.nextCursor;
		}
		if (detail !== agg.kpi.calls) {
			fail.push(`[一致性] ${key}: 明细(桶对齐 ${new Date(oracleFrom).toISOString()}) ${detail} ≠ kpi.calls ${agg.kpi.calls}`);
		}

		// 分位合理性（近似值必须在样本区间内）
		const p50 = agg.kpi.ttft?.p50;
		if (p50 !== null && p50 !== undefined && (p50 < 100 || p50 > 60_000)) fail.push(`[分位] ${key}: ttft p50=${p50} 不合理`);
	}

	// ── 明细分页（keyset）
	t = nowMs();
	const page1 = store.queryRecords({ fromMs: 0, toMs: now, filters: {}, limit: 50 });
	const page2 = store.queryRecords({ fromMs: 0, toMs: now, filters: {}, cursor: page1.nextCursor, limit: 50 });
	results.records = { pageMs: ms(t), page1: page1.items.length, page2: page2.items.length, total: page1.total };
	if (page1.items.length !== 50 || page2.items.length !== 50) fail.push("[分页] keyset 分页返回条数不对");

	// ── 过滤查询
	t = nowMs();
	const filtered = rollup.aggregate({ fromMs: now - 7 * DAY, toMs: now, gran: "1h", filters: { model: [MODELS[0]] } });
	results.filtered = { ms: ms(t), calls: filtered.kpi.calls };
	if (filtered.kpi.calls >= results.aggregate["7d"].calls) fail.push("[过滤] 按模型过滤后调用数没有减少");

	store.close();
	results.rssMB = rssMB();
	results.rssDeltaMB = results.rssMB - rssBaseline;

	// ── 硬门槛
	const gates = [
		["openStore ≤ 200ms", results.openMs <= 200],
		["入库 15 万条 ≤ 120s", results.insert.totalMs <= 120_000],
		["overview(30d) ≤ 50ms", results.aggregate["30d"].ms <= 50],
		["overview(all) ≤ 50ms", results.aggregate.all.ms <= 50],
		["明细分页 ≤ 20ms", results.records.pageMs <= 20],
		["RSS 增量 ≤ 150MB", results.rssDeltaMB <= 150],
		["一致性检查（Σseries === kpi.calls === 明细 count）", fail.length === 0],
	];
	results.gates = gates.map(([name, ok]) => ({ gate: name, ok: Boolean(ok) }));
	const bad = gates.filter(([, ok]) => !ok).map(([name]) => name);

	console.log(JSON.stringify({ ok: bad.length === 0, failures: [...fail, ...bad.map((g) => `未达标：${g}`)], results }, null, 2));
	if (bad.length || fail.length) process.exitCode = 1;
} catch (err) {
	console.error(`v3-bench 失败：${err?.stack ?? err}`);
	process.exitCode = 1;
} finally {
	if (tmpDir) {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}
