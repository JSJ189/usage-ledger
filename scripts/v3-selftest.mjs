#!/usr/bin/env node
/**
 * v3 数据层自检（回归测试）：`node scripts/v3-selftest.mjs`
 *
 * 一次跑完：直方图 / 口径函数 / series 不变量 / store 幂等与去重 / rollup 聚合一致性 /
 * v2 迁移幂等 / 只读连接保护。全部用临时目录，跑完自动清理，不碰真实数据。
 *
 * 退出码：0 全通过；1 有失败（按失败条数打印）。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BINS,
	HIST_BYTES,
	binOf,
	binValue,
	decodeHist,
	emptyHist,
	encodeHist,
	histAdd,
	histTotal,
	mergeHistInto,
	quantile,
} from "../lib/v3/hist.mjs";
import {
	createAccum,
	accumulateRow,
	costBuckets,
	kpiFromAccum,
	normalizeFilter,
	rowMatches,
	seriesFromRows,
	statusClass,
	summarizeRows,
	topFromRows,
} from "../lib/v3/metrics.mjs";
import { openStore, splitEntryKey } from "../lib/v3/store.mjs";
import { createRollupIndex } from "../lib/v3/rollup.mjs";
import { legacyRecordToRow, migrateLegacyV2 } from "../lib/v3/migrate.mjs";

let pass = 0;
const failures = [];

function ok(name, condition, detail = "") {
	if (condition) {
		pass++;
		console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
		return true;
	}
	failures.push(name + (detail ? ` — ${detail}` : ""));
	console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	return false;
}

function approx(actual, expected, tolerance, name) {
	const a = Number(actual);
	const diff = Math.abs(a - expected);
	return ok(name, Number.isFinite(a) && diff <= tolerance, `实际 ${a}，期望 ${expected}±${tolerance}`);
}

const tmpDirs = [];
function tmpDir(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

function makeRow(i, { base = Date.now() - 3 * 86_400_000, combo = 0 } = {}) {
	const models = ["mimo-v2.6-pro", "Deepseek-V4.1-Flash-1017", "grok-4.7"];
	const providers = ["xiaomi", "deepseek", "cliproxyapi"];
	const projects = ["JK项目/知识库", "PDmodel"];
	const ttft = i % 3 === 0 ? null : 500 + ((i * 37) % 9000);
	const gen = 800 + ((i * 53) % 20000);
	return {
		ts: base + i * 60_000,
		entryKey: `e:rel-${combo}.jsonl:m${i}`,
		convId: `conv-${combo}`,
		src: `rel-${combo}.jsonl`,
		model: models[i % models.length],
		provider: providers[i % providers.length],
		project: projects[i % projects.length],
		status: i % 17 === 0 ? "provider_error" : i % 29 === 0 ? "aborted" : "ok",
		origin: "backfill",
		inTok: 100 + (i % 700),
		outTok: 40 + (i % 300),
		cacheRead: i % 5 === 0 ? 0 : 1000 + (i % 5000),
		cacheWrite: 0,
		reasoningTok: 0,
		totalTok: 2000 + (i % 3000),
		costSdk: i % 11 === 0 ? 0.0021 : 0,
		costEst: i % 11 === 0 ? null : 0.0007,
		costSource: i % 11 === 0 ? "sdk" : "estimate",
		priceId: "modelsdev:xiaomi/mimo-v2.6-pro",
		priceVersion: 3,
		ttftMs: ttft,
		genMs: gen,
		e2eMs: ttft === null ? gen : ttft + gen,
		stopReason: "toolUse",
	};
}

// ────────────────────────────────────────────── 1. hist
console.log("\n[1] hist.mjs 对数直方图");
ok("BINS=136", BINS === 136);
ok("HIST_BYTES=272（uint16，见文件头偏差说明）", HIST_BYTES === BINS * 2);
ok("binOf(1)===0", binOf(1) === 0);
ok("binOf(4h)===BINS-1", binOf(4 * 3600_000) === BINS - 1);
ok("binOf 单调", binOf(100) <= binOf(200) && binOf(200) <= binOf(4000));
ok("binValue(0)===1", binValue(0) === 1);
ok("binValue 严格递增", binValue(1) > binValue(0) && binValue(BINS - 1) > binValue(BINS - 2));
{
	const values = [];
	for (let i = 0; i < 5000; i++) values.push(200 + ((i * 7919) % 60_000));
	const hist = emptyHist();
	for (const v of values) histAdd(hist, v);
	const sorted = values.slice().sort((a, b) => a - b);
	const exact = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
	let worst = 0;
	for (const p of [0.5, 0.9, 0.99]) {
		const got = quantile(hist, p);
		const want = exact(p);
		worst = Math.max(worst, Math.abs(got - want) / want);
	}
	ok("分位近似误差 ≤5%", worst <= 0.05, `最大相对误差 ${(worst * 100).toFixed(2)}%`);
	ok("histTotal 计数正确", histTotal(hist) === values.length, `${histTotal(hist)}`);

	const encoded = encodeHist(hist);
	ok("encode/decode 往返", histTotal(decodeHist(encoded)) === values.length);
	const merged = emptyHist();
	mergeHistInto(merged, hist);
	mergeHistInto(merged, hist);
	ok("mergeHistInto 可合并", histTotal(merged) === values.length * 2);
}

// ────────────────────────────────────────────── 2. metrics 口径
console.log("\n[2] metrics.mjs 口径");
ok("statusClass 六态", ["ok", "client_error", "rate_limited", "provider_error", "aborted", "incomplete"].every((s) => statusClass(s) === s));
ok("statusClass('error')→provider_error", statusClass("error") === "provider_error");
{
	const okTtft = emptyHist();
	for (let i = 0; i < 5; i++) histAdd(okTtft, 2000 + i * 100);
	const rows = [
		{ calls: 5, status: "ok", inTok: 100, outTok: 50, cacheRead: 900, cacheWrite: 0, genSum: 5000, genN: 5, outTokTput: 250, rateSum: 50, rateN: 5, cacheN: 5, e2eSum: 7000, e2eN: 5, totalTok: 1050, unpriced: 0, costSdk: 0, costEst: 0.01, ttftHist: okTtft, e2eHist: emptyHist() },
		{ calls: 3, status: "provider_error", inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, genSum: 0, genN: 0, outTokTput: 0, rateSum: 0, rateN: 0, cacheN: 0, e2eSum: 0, e2eN: 0, totalTok: 0, unpriced: 3, costSdk: 0, costEst: 0, ttftHist: emptyHist(), e2eHist: emptyHist() },
		{ calls: 2, status: "aborted", inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, genSum: 0, genN: 0, outTokTput: 0, rateSum: 0, rateN: 0, cacheN: 0, e2eSum: 0, e2eN: 0, totalTok: 0, unpriced: 2, costSdk: 0, costEst: 0, ttftHist: emptyHist(), e2eHist: emptyHist() },
	];
	const acc = createAccum();
	for (const r of rows) accumulateRow(acc, r);
	const kpi = kpiFromAccum(acc);
	approx(kpi.successRate, 0.625, 0.0001, "successRate 排除 aborted/incomplete（5/8）");
	ok("kpi 字段逐字对齐合同 §5.1", ["calls", "ok", "error", "incomplete", "aborted", "successRate", "ttft", "e2e", "tokPerSec", "tokPerSecMean", "cacheHitRate", "tokens", "cost"].every((k) => k in kpi));
	ok("cost.isLowerBound 有未定价就 true", kpi.cost.isLowerBound === true && kpi.cost.unpricedCalls === 5);
	approx(kpi.cacheHitRate, 900 / 1000, 0.0001, "cacheHitRate 加权（ΣcacheRead/ΣpromptTok）");
	approx(kpi.tokPerSec, 250 / (5000 / 1000), 0.01, "tokPerSec 加权（ΣoutTok/ΣgenMs·1000）");
	approx(kpi.ttft.coverage, 5 / 10, 0.0001, "ttft.coverage = 有样本/调用");
}
{
	ok("normalizeFilter 拆逗号", JSON.stringify(normalizeFilter(["a,b", "c"])) === JSON.stringify(["a", "b", "c"]));
	ok("normalizeFilter 空数组→null", normalizeFilter([]) === null);
	ok("rowMatches 空数组=不过滤", rowMatches({ model: "x", provider: "p", project: "pr", status: "ok" }, { models: [] }) === true);
	ok("rowMatches null 不抛错", rowMatches({ model: "x", status: "ok" }, null) === true);
	ok("splitEntryKey 兼容任意前缀", (() => {
		const a = splitEntryKey("s:rel/a.jsonl:1a2b3c");
		const b = splitEntryKey("e:C:\\x\\a.jsonl:1a2b3c");
		return a?.src === "rel/a.jsonl" && a?.id === "1a2b3c" && b?.src === "C:\\x\\a.jsonl" && b?.id === "1a2b3c";
	})());
}

// ────────────────────────────────────────────── 3. series 不变量
console.log("\n[3] seriesFromRows 不变量（两个历史缺陷的回归锚点）");
{
	const now = Date.now();
	const rows = [];
	const hourStartMs = Math.floor(now / 3600_000) * 3600_000;
	for (let h = 0; h < 42; h++) {
		for (let d = 0; d < 12; d++) {
			const ttftHist = emptyHist();
			histAdd(ttftHist, 2000 + d * 100);
			const e2eHist = emptyHist();
			histAdd(e2eHist, 9000);
			rows.push({
				bucket: hourStartMs - (41 - h) * 3600_000,
				modelId: d, providerId: 1, projectId: 1, status: d % 6 === 0 ? "provider_error" : "ok",
				calls: 3, inTok: 100, outTok: 50, cacheRead: 900, cacheWrite: 0, reasoningTok: 0, totalTok: 1050,
				costSdk: 0, costEst: 0.01, unpriced: 0, e2eSum: 9000, e2eN: 3, genSum: 5000, genN: 3,
				outTokTput: 150, rateSum: 30, rateN: 3, cacheN: 3, ttftHist, e2eHist,
			});
		}
	}
	const windowFrom = now - 6 * 3600_000;
	const series = seriesFromRows(rows, { fromMs: windowFrom, toMs: now, gran: "5m" });
	ok("窗口外行不计入（6h 窗口不给 109 个点）", series.length <= 7, `点数 ${series.length}`);
	const seriesCalls = series.reduce((a, b) => a + b.calls, 0);
	const kpi = summarizeRows(rows, { fromMs: windowFrom, toMs: now });
	ok("Σseries.calls === kpi.calls", seriesCalls === kpi.calls, `${seriesCalls} vs ${kpi.calls}`);
	ok("首点不早于窗口", series[0].t >= windowFrom - 3600_000, new Date(series[0].t).toISOString());
	const wide = seriesFromRows(rows, { fromMs: now - 730 * 86_400_000, toMs: now, gran: "1d" });
	ok("超 720 桶自动升粒度/标记截断（不丢数据）", wide.reduce((a, b) => a + b.calls, 0) === rows.reduce((a, b) => a + b.calls, 0) && wide.meta.truncated === true, `points=${wide.length}`);
	ok("series 点带 ttftSamples", "ttftSamples" in wide[0]);
}

// ────────────────────────────────────────────── 4. store
console.log("\n[4] store.mjs 写入 / 幂等 / 去重 / 分页");
{
	const dir = tmpDir("v3-self-store-");
	const store = openStore({ dir });
	const rows = [];
	for (let i = 0; i < 2000; i++) rows.push(makeRow(i, { combo: i % 5 }));
	let t0 = performance.now();
	const first = store.insertBatch(rows, { rollupVersion: 1 });
	const insertMs = performance.now() - t0;
	ok("插入 2000 行", first.inserted === 2000, `${insertMs.toFixed(0)}ms（${(insertMs / 2000 * 1000).toFixed(1)}µs/行）`);
	ok("返回 delta 数组", Array.isArray(first.delta) && first.delta.length > 0, `${first.delta.length} 行`);
	ok("delta 形状符合 §4.9", ["bucket", "modelId", "providerId", "projectId", "status", "calls", "e2eSum", "e2eN", "ttftHist", "e2eHist"].every((k) => k in first.delta[0]));
	ok("stats.calls 走 meta 计数", store.stats().calls === 2000, `${store.stats().calls}`);

	const again = store.insertBatch(rows, { rollupVersion: 2 });
	ok("重复导入幂等（inserted=0）", again.inserted === 0 && store.stats().calls === 2000, `inserted=${again.inserted} calls=${store.stats().calls}`);

	const page = store.queryRecords({ fromMs: 0, toMs: Date.now(), limit: 20 });
	ok("分页 20 条 + nextCursor", page.items.length === 20 && Boolean(page.nextCursor));
	ok("total 走 rollup 求和并标 totalApprox", page.total === 2000 && typeof page.totalApprox === "boolean", `total=${page.total} approx=${page.totalApprox}`);
	const t1 = performance.now();
	const page2 = store.queryRecords({ fromMs: 0, toMs: Date.now(), limit: 20, cursor: page.nextCursor });
	const pageMs = performance.now() - t1;
	ok("游标翻页不重复", page2.items[0].id < page.items[page.items.length - 1].id, `${pageMs.toFixed(1)}ms`);
	const t2 = performance.now();
	store.queryRecords({ fromMs: 0, toMs: Date.now(), limit: 20 });
	ok("total 命中 30s 缓存（≤5ms）", performance.now() - t2 <= 5, `${(performance.now() - t2).toFixed(2)}ms`);
	const broad = store.queryRecords({ fromMs: 0, toMs: Date.now(), limit: 20, q: "tool", maxScanRows: 100 });
	ok("q 过宽返回 too-broad 而不是硬扫", broad.ok === false && broad.code === "too-broad");

	// P0-1 回归：live 被回填认领（曾抛 SQLite 参数绑定错，整批回滚）
	const base = Date.now() - 3600_000;
	store.insertBatch([{ ts: base, convId: "cv-link", model: "m9", provider: "p", status: "ok", origin: "live", e2eMs: 1000 }]);
	let claimOk = true;
	try {
		store.insertBatch([{ ts: base + 500, convId: "cv-link", model: "m9", provider: "p", status: "ok", entryKey: "e:link.jsonl:1" }]);
	} catch (err) {
		claimOk = false;
		console.log("    认领抛错：", err.message);
	}
	ok("P0-1 live 认领不崩", claimOk);

	// live/backfill 去重
	const dbase = Date.now() - 7_200_000;
	const lives = [];
	const backs = [];
	for (let i = 0; i < 10; i++) {
		lives.push({ ts: dbase + i * 60_000, convId: "cv-dd", model: "m8", provider: "p", status: "ok", origin: "live", e2eMs: 900, ttftMs: 200, outTok: 10, inTok: 100 });
		backs.push({ ts: dbase + i * 60_000 + 3500, convId: "cv-dd", model: "m8", provider: "p", status: "ok", origin: "backfill", entryKey: `e:dd.jsonl:${i}`, e2eMs: 900, ttftMs: 200, outTok: 10, inTok: 100 });
	}
	const before = store.stats().calls;
	store.insertBatch(lives);
	const mid = store.stats().calls;
	const dedup = store.insertBatch(backs);
	const after = store.stats().calls;
	ok("live+回填只算一次（10 条不翻倍）", mid - before === 10 && after - mid === 0 && dedup.deduped === 10, `before=${before} mid=${mid} after=${after} deduped=${dedup.deduped}`);
	ok("meta.dedup_live_rows 记账", Number(store.metaGet("dedup_live_rows")) >= 10, String(store.metaGet("dedup_live_rows")));

	const totalCalls = store.stats().calls;
	const rollElem = store.rollupRows({ fromMs: 0, toMs: Date.now(), gran: "hour" });
	const sumRollup = rollElem.reduce((a, b) => a + b.calls, 0);
	ok("Σ rollup_hour.calls === 明细条数", sumRollup === totalCalls, `${sumRollup} vs ${totalCalls}`);

	// 重算某天
	const day = new Date(dbase).toISOString().slice(0, 10);
	const rebuilt = store.rebuildDayRollup(day);
	ok("rebuildDayRollup 可重算", rebuilt.calls >= 0 && rebuilt.day === day, JSON.stringify(rebuilt));

	// 只读连接
	const ro = openStore({ dir, readOnly: true });
	let blocked = false;
	try {
		ro.insertBatch(rows);
	} catch {
		blocked = true;
	}
	ok("只读连接拒绝写入", blocked && ro.stats().calls === totalCalls);
	ro.close();
	store.close();
}

// ────────────────────────────────────────────── 5. rollup 聚合
console.log("\n[5] rollup.mjs 聚合一致性");
{
	// P0 回归：构造参数里的 rows 必须被吃掉（否则线上 KPI 恒为 0）
	const hour = Math.floor(Date.now() / 3600_000) * 3600_000;
	const ttftHist = emptyHist();
	histAdd(ttftHist, 2306);
	const e2eHist = emptyHist();
	histAdd(e2eHist, 9000);
	const idx = createRollupIndex({
		rows: [{ bucket: hour, modelId: 1, providerId: 1, projectId: 1, model: "m", provider: "p", project: "pr", status: "ok", calls: 5, inTok: 50, outTok: 25, cacheRead: 0, cacheWrite: 0, reasoningTok: 0, totalTok: 75, costSdk: 0.05, costEst: 0, unpriced: 0, e2eSum: 5000, e2eN: 5, genSum: 4500, genN: 5, outTokTput: 25, rateSum: 25, rateN: 5, cacheN: 5, ttftHist: {}, e2eHist: {} }],
		version: 7,
	});
	ok("P0 回归：createRollupIndex({rows}) 生效", idx.stats().hourBuckets === 1 && idx.aggregate({ fromMs: Date.now() - 86_400_000, toMs: Date.now(), gran: "1h" }).kpi.calls === 5);
	ok("version 透传", idx.version === 7 && idx.bump() === 8);

	const dir = tmpDir("v3-self-roll-");
	const store = openStore({ dir });
	const rows = [];
	for (let i = 0; i < 100; i++) rows.push(makeRow(i, { base: Date.now() - 2 * 3600_000, combo: i % 3 }));
	store.insertBatch(rows, { rollupVersion: 1 });
	const now = Date.now();
	const loaded = [...store.rollupRows({ fromMs: now - 45 * 86_400_000, toMs: now, gran: "hour" }), ...store.rollupRows({ fromMs: 0, toMs: now, gran: "day" })];
	const index = createRollupIndex({ store, rows: loaded, version: 1 });
	for (const [label, query] of [
		["today", { fromMs: Math.floor(now / 86_400_000) * 86_400_000 - new Date().getTimezoneOffset() * 60_000, toMs: now, gran: "auto" }],
		["24h", { fromMs: now - 86_400_000, toMs: now, gran: "auto" }],
		["7d", { fromMs: now - 7 * 86_400_000, toMs: now, gran: "auto" }],
		["30d", { fromMs: now - 30 * 86_400_000, toMs: now, gran: "auto" }],
		["all", { fromMs: 0, toMs: now, gran: "auto" }],
	]) {
		const agg = index.aggregate(query);
		const sumSeries = agg.series.reduce((a, b) => a + b.calls, 0);
		ok(`${label}: kpi.calls === Σseries.calls === 明细`, agg.kpi.calls === 100 && sumSeries === 100, `kpi=${agg.kpi.calls} series=${sumSeries}`);
	}
	const agg = index.aggregate({ fromMs: 0, toMs: now, gran: "auto" });
	ok("aggregate 返回契约字段", ["kpi", "series", "topModels", "topProjects", "filters", "coverage", "range"].every((k) => k in agg));
	ok("range 带 gran/granRequested/timezone", Boolean(agg.range.gran && agg.range.granRequested && agg.range.timezone), JSON.stringify(agg.range));
	ok("range 带 truncated/granDowngraded 标记", "truncated" in agg.range && "granDowngraded" in agg.range);
	const filtered = index.aggregate({ fromMs: 0, toMs: now, gran: "auto", filters: { models: ["grok-4.7"] } });
	ok("筛选后 calls 变少且 topModels 只剩一个", filtered.kpi.calls > 0 && filtered.kpi.calls < 100 && filtered.topModels.length === 1, `${filtered.kpi.calls}`);
	ok("topFromRows 可排序出项目", topFromRows(loaded, { key: "project", limit: 2 }).length > 0);
	store.close();
}

// ────────────────────────────────────────────── 6. 迁移
console.log("\n[6] migrate.mjs v2 账本迁移");
{
	const dir = tmpDir("v3-self-mig-");
	const store = openStore({ dir });
	const legacyPath = join(dir, "ledger-v2.jsonl");
	const lines = [];
	for (let i = 0; i < 1000; i++) {
		lines.push(
			JSON.stringify({
				ts: Date.now() - i * 60_000,
				conversationId: null,
				projectDir: "--C--Users-11373-Desktop-JK项目-知识库--",
				provider: "xiaomi",
				model: "mimo-v2.6-pro",
				inputTokens: 300,
				outputTokens: 120,
				cacheReadTokens: 9000,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				totalTokens: 9420,
				costUsd: i % 4 === 0 ? 0.0021 : 0,
				durationMs: 8000,
				ttftMs: i % 2 === 0 ? 1800 : null,
				stopReason: "toolUse",
				status: "ok",
				source: "backfill",
				sessionFile: "C:\\Users\\11373\\.pi\\agent\\sessions\\--C--Users-11373-Desktop-JK项目-知识库--\\s1.jsonl",
				entryId: `e${i}`,
			}),
		);
	}
	writeFileSync(legacyPath, `${lines.join("\n")}\n`);
	const row = legacyRecordToRow(JSON.parse(lines[0]));
	ok("legacyRecordToRow 形状", Boolean(row.entryKey && row.ts && row.model && row.status === "ok" && row.costSdk === 0.0021));
	const first = await migrateLegacyV2({ store, legacyPath, batchRows: 200 });
	ok("迁移 1000 行", first.ok && first.rows === 1000, `${first.rows} 行 / ${first.ms}ms`);
	ok("迁移写 migrated_at", Boolean(store.metaGet("migrated_at")));
	ok("旧账本没被删除", existsSync(legacyPath) && readFileSync(legacyPath, "utf8").length > 0);
	const second = await migrateLegacyV2({ store, legacyPath, batchRows: 200 });
	ok("迁移幂等（第二次 0 新增）", second.ok && store.stats().calls === 1000, `calls=${store.stats().calls}`);
	store.close();
}

// ────────────────────────────────────────────── 清理
for (const dir of tmpDirs) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exitCode = 1;
} else {
	console.log("全部通过 ✓");
}
