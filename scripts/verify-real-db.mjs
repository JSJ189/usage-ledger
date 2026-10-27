/**
 * 真库自检脚本（默认跳过：找不到账本就以 0 退出，CI 上不会红）。
 *
 * 用法：
 *   node scripts/verify-real-db.mjs
 *   node scripts/verify-real-db.mjs --db "E:\EasyCLIProxyAPI-v0.2.25-Windows-amd64\usage-records\usage.db"
 *
 * 它做四件事：
 *  1. 只读打开账本（readOnly + PRAGMA query_only），**不发任何写语句**地断言连接不可写；
 *  2. 跑 summary / models / series / events 四路聚合，打印关键数字；
 *  3. 打印四个路由维度（provider / executor / endpoint / client）的分组结果；
 *  4. 传 `--prices <目录>` 时用三源原文算估算成本（默认跳过，避免联网与提交大文件）；
 *  5. 用 JS 侧 nearest-rank 复算全量 TTFT p50/p90，与 SQL 分位口径对齐（自证分位公式）；
 *  6. 打印「今日」本地日界与命中行数，确认时区口径（本地日界而非 UTC）。
 *
 * 绝不会写账本：没有 UPDATE / DELETE / 库压缩 / 写事务，连写探测都不发。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dirname = fileURLToPath(new URL("..", import.meta.url));

const {
	aggregateCostBuckets,
	aggregateGroups,
	openReadOnlyDb,
	resolveDbPath,
	resolveWindow,
	aggregateSummary,
	aggregateModels,
	aggregateSeries,
	listEvents,
	percentileOf,
	percentilePos,
} = await import(new URL("../index.mjs", import.meta.url).href);

function argOf(flag) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const explicit = argOf("--db");
const pricesDir = argOf("--prices");
const resolved = resolveDbPath(explicit ? { dbPath: explicit } : {});
if (!resolved.ok) {
	console.log(`SKIP: 未找到账本（${resolved.code}）— ${resolved.reasonEn}`);
	console.log("      传入 --db <绝对路径> 可指定账本。");
	process.exit(0);
}
console.log("账本:", resolved.path, `(source=${resolved.source})`);

const db = await openReadOnlyDb(resolved.path);
console.log("只读打开: OK");

// 1. 只读断言（**不发任何写语句**：不建表、不 BEGIN IMMEDIATE、不做库压缩）
//    readOnly 连接由 SQLite 在打开时标记；query_only 让所有写语句在解析前即被拒。
const queryOnly = db.prepare("PRAGMA query_only").get();
const queryOnlyOn = Object.values(queryOnly ?? {})[0] === 1;
console.log(`只读断言: PRAGMA query_only = ${queryOnlyOn ? "1（写语句会被拒）" : "0"}`);
if (!queryOnlyOn) {
	console.error("致命：连接不是只读/query_only，立即中止（本脚本绝不写账本）");
	db.close();
	process.exit(1);
}

// 2. 四路聚合
for (const key of ["today", "7d", "30d"]) {
	const window = resolveWindow(key);
	const started = Date.now();
	const s = aggregateSummary(db, { window, client: "all" });
	const ms = Date.now() - started;
	console.log(`\n[${key}] fromMs=${window.fromMs} (${new Date(window.fromMs).toString().slice(0, 24)}) 耗时 ${ms}ms`);
	console.log(
		`  calls=${s.calls} success=${s.success} rate=${s.successRate === null ? "-" : (s.successRate * 100).toFixed(2) + "%"} failed=${s.failed} canceled=${s.canceled}`,
	);
	console.log(
		`  ttft n=${s.ttft.samples} p50=${s.ttft.p50} p90=${s.ttft.p90} p99=${s.ttft.p99} avg=${s.ttft.avg === null ? "-" : Math.round(s.ttft.avg)}`,
	);
	console.log(
		`  latency avg=${s.latencyAvg === null ? "-" : Math.round(s.latencyAvg)} max=${s.latencyMax} tok/s=${s.tokPerSec === null ? "-" : s.tokPerSec.toFixed(2)} (n=${s.tokPerSecSamples})`,
	);
	console.log(
		`  tokens in=${s.tokens.input} out=${s.tokens.output} reasoning=${s.tokens.reasoning} cacheRead=${s.tokens.cacheRead} cacheCreate=${s.tokens.cacheCreation} total=${s.tokens.total}`,
	);
	const models = aggregateModels(db, { window, client: "all" });
	console.log(`  models=${models.length} top:`);
	for (const m of models.slice(0, 4)) {
		console.log(
			`    ${m.model}: calls=${m.calls} fail=${(m.failRate * 100).toFixed(1)}% ttftP50=${m.ttftP50} tok/s=${m.tokPerSec === null ? "-" : m.tokPerSec.toFixed(1)} total=${m.tokens.total}`,
		);
	}
	const hours = aggregateSeries(db, { window, client: "all" });
	console.log(`  hours=${hours.length} 首=${hours[0]?.hour ?? "-"} 末=${hours.at(-1)?.hour ?? "-"}`);
	const events = listEvents(db, { window, client: "all", limit: 3 });
	console.log(`  events=${events.length} 最新=${events[0]?.timestamp ?? "-"} client=${events[0]?.client ?? "-"}`);
}

// 3. 路由维度（provider / executor / endpoint / client）
for (const dim of ["provider", "executor", "endpoint", "client"]) {
	const groups = aggregateGroups(db, { window: resolveWindow("30d"), client: "all", groupBy: dim });
	console.log(`\n[30d groupBy=${dim}] ${groups.length} 组`);
	for (const g of groups.slice(0, 4)) {
		console.log(
			`  ${String(g.key).padEnd(38)} calls=${String(g.calls).padStart(6)} fail=${g.failRate === null ? "-" : (g.failRate * 100).toFixed(1) + "%"} ttftP50=${g.ttftP50} tok/s=${g.tokPerSec === null ? "-" : g.tokPerSec.toFixed(1)}`,
		);
	}
}

// 4. 估算成本（--prices <dir> 指向 modelsdev.json / litellm.json / openrouter.json 原文；缺省跳过）
if (pricesDir) {
	const prices = await import(new URL("../lib/prices.mjs", import.meta.url).href);
	const read = (name) => {
		try {
			return JSON.parse(readFileSync(join(pricesDir, `${name}.json`), "utf8"));
		} catch {
			return null;
		}
	};
	const entries = [
		...prices.normalizeModelsDev(read("modelsdev")),
		...prices.normalizeLiteLlm(read("litellm")),
		...prices.normalizeOpenRouter(read("openrouter")),
	];
	const models = db
		.prepare("SELECT DISTINCT model FROM usage_events WHERE model != ''")
		.all()
		.map((r) => String(r.model));
	const providers = db
		.prepare("SELECT DISTINCT provider FROM usage_events WHERE provider != ''")
		.all()
		.map((r) => String(r.provider));
	const kept = prices.filterEntriesForModels(entries, models, providers);
	const index = prices.buildPriceIndex(kept);
	console.log(`\n[价格] 归一化条目 ${entries.length}，保留账本模型 ${kept.length} 条（快照体积上限校验 <32KB）`);
	const snapshotBytes = JSON.stringify({ models, providers, entries: kept }).length;
	// 32KB 红线针对的是「仓库里提交的价格原文」；这里是 storage 快照体积的参考值
	console.log(`[价格] 快照体积约 ${snapshotBytes} bytes（storage 快照，不提交仓库）`);
	for (const key of ["today", "7d", "30d"]) {
		const window = resolveWindow(key);
		const buckets = aggregateCostBuckets(db, { window, client: "all" }, index);
		const total = aggregatesCost(buckets.total);
		console.log(
			`[${key}] 估算成本 ≈ $${total.amount === null ? "--" : total.amount.toFixed(4)}（有价 ${total.pricedCalls} / 未知价 ${total.unknownCalls}，未知价占比 ${total.unknownRate === null ? "-" : (total.unknownRate * 100).toFixed(2) + "%"}，多源不一致 ${total.multiSourceCalls} 次 / ${total.multiSourceRatio === null ? "-" : (total.multiSourceRatio * 100).toFixed(2) + "%"}）`,
		);
		const byModel = aggregateGroups(db, { window, client: "all", groupBy: "model", costs: buckets });
		for (const g of byModel) {
			console.log(
				`   ${String(g.key).padEnd(24)} calls=${String(g.calls).padStart(6)} tokens=${String(g.tokens.total).padStart(12)} ≈$${g.cost?.amount === null || g.cost?.amount === undefined ? "--" : g.cost.amount.toFixed(4)} unknown=${g.cost?.unknownCalls ?? "-"} multi=${g.cost?.multiSourceCalls ?? "-"}`,
			);
		}
	}
} else {
	console.log(
		"\n[价格] 跳过：传入 --prices <目录> 可计算估算成本（目录内放 modelsdev.json / litellm.json / openrouter.json）",
	);
}

function aggregatesCost(bucket) {
	const total = bucket.pricedCalls + bucket.unknownCalls;
	return {
		amount: bucket.pricedCalls > 0 ? bucket.amount : null,
		pricedCalls: bucket.pricedCalls,
		unknownCalls: bucket.unknownCalls,
		unknownRate: total > 0 ? bucket.unknownCalls / total : null,
		multiSourceCalls: Number(bucket.multiSourceCalls) || 0,
		multiSourceRatio: total > 0 ? (Number(bucket.multiSourceCalls) || 0) / total : null,
	};
}

// 5. 分位口径自证：SQL 分位 vs JS nearest-rank（全量、ttft>0）
const windowAll = { fromMs: 0 };
const sqlPct = aggregateSummary(db, { window: windowAll, client: "all" }).ttft;
const values = db
	.prepare("SELECT ttft_ms AS v FROM usage_events WHERE ttft_ms IS NOT NULL AND ttft_ms > 0 ORDER BY v")
	.all()
	.map((r) => Number(r.v));
const jsP50 = percentileOf(values, 0.5);
const jsP90 = percentileOf(values, 0.9);
const jsP99 = percentileOf(values, 0.99);
console.log(
	`\n分位自证（全量 ttft>0，n=${values.length}，pos50=${percentilePos(0.5, values.length)}）:`,
	`sql=[${sqlPct.p50},${sqlPct.p90},${sqlPct.p99}] js=[${jsP50},${jsP90},${jsP99}]`,
	sqlPct.p50 === jsP50 && sqlPct.p90 === jsP90 && sqlPct.p99 === jsP99 ? "一致 ✔" : "不一致 ✘",
);

// 6. 时区口径：本地日界 vs UTC 日界
const today = resolveWindow("today");
const localMidnight = today.fromMs;
const utcMidnight = (() => {
	const d = new Date();
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
})();
const countSince = (ms) => db.prepare("SELECT COUNT(*) AS c FROM usage_events WHERE timestamp_ms >= ?").get(ms).c;
console.log(
	`\n时区：本地日界 ${new Date(localMidnight).toISOString()} → ${countSince(localMidnight)} 行；` +
		`UTC 日界 ${new Date(utcMidnight).toISOString()} → ${countSince(utcMidnight)} 行；` +
		`两界指向${localMidnight === utcMidnight ? "同一时刻（本机 TZ=UTC）" : "不同时刻（本地日界生效）"}`,
);

db.close();
console.log("\n完成（全程未对账本发出任何写语句：无 INSERT/UPDATE/DELETE/建表/压缩）。");
console.log("插件目录:", dirname);
