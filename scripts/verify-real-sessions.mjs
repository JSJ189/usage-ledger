#!/usr/bin/env node
/**
 * 真机会话回填自检（只读）：`npm run verify:sessions [天数]`
 *
 * 用真实的 `~/.pi/agent/sessions` 跑一遍与插件完全相同的解析 / 增量 / 去重 / 配对 / 聚合
 * 代码路径，打印：
 *  - 扫到多少文件、读到多少 assistant 调用、覆盖率（已导入 X/M 个会话文件）；
 *  - 去重后账本里多少条、总成本（SDK usage.cost.total 求和）、token 合计；
 *  - 按模型的 Top N（调用数 / 成本 / 平均 tok·s⁻¹）；
 *  - 与「独立复算参考值」的偏差（%，> 2% 时以非 0 退出并指明可能原因）。
 *
 * 参考值来自人工独立复算（Python 直扫会话 JSONL，不经插件代码），只在 7 天窗口有效。
 * 它是**参考值**，不是断言：脚本只报偏差，判定仍由人看。
 *
 * 这个脚本**绝不写**会话目录，也不写插件 dataDir（账本是内存态）。
 * 单测不跑它（单测只碰临时目录的 fixture），它只用于人工核对真实数据。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { byModel, summarize } from "../lib/metrics.mjs";
import { createLedgerStore } from "../lib/ledger.mjs";
import { createSessionImporter, resolveSessionsRoot } from "../lib/sessions.mjs";

/** 偏差容忍度：超过就以非 0 退出。 */
const TOLERANCE = 0.02;
const DAY_MS = 86_400_000;

/**
 * 人工独立复算参考值（7 天窗口，Python 直扫 `~/.pi/agent/sessions`，不经过本仓库代码）。
 * `models` 是抽查用的锚点，不要求全模型对齐。
 */
const REFERENCE = {
	days: 7,
	calls: 43470,
	tokens: 5_454_922_553,
	cost: 349.7777,
	models: { "grok-4.7": 4240 },
	note: "人工复算：94 个 7 天内修改过的会话文件，assistant+usage 行中消息 ts 在 7 天内的计 43470 次",
};

const days = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 30;
const { root, source } = resolveSessionsRoot({ env: process.env });

/** 等价的 `host.fs` 替身：Node 原生只读实现（宿主的免费版没有自带 fs 时用它跑脚本）。 */
const fsApi = {
	requestAccess: async () => true,
	listPath: async (absDir) =>
		readdirSync(absDir, { withFileTypes: true }).map((e) => ({
			name: e.name,
			type: e.isDirectory() ? "dir" : "file",
		})),
	readPath: async (absPath) => readFileSync(absPath),
	readTextPath: async (absPath, maxBytes) => {
		const buf = readFileSync(absPath);
		return buf.subarray(0, Number(maxBytes) || buf.length).toString("utf8");
	},
	statPath: async (absPath) => {
		const st = statSync(absPath);
		return {
			name: absPath.split(/[/\\]/).pop() ?? absPath,
			type: st.isDirectory() ? "dir" : "file",
			size: st.isDirectory() ? 0 : st.size,
			mtime: Number(st.mtimeMs) || 0,
		};
	},
};

const state = { version: 1, files: {} };
const importer = createSessionImporter({
	fsApi,
	rootInfo: { root, source },
	state,
	days,
	maxFilesPerRun: 5000,
	persist: () => {},
	log: (level, ...args) => console.log(`[${level}]`, ...args),
});

const startedAt = Date.now();
const result = await importer.run();
const store = createLedgerStore({});
store.addMany(result.records);
const records = store.list();
// 与人工复算同口径：只算「消息 ts 落在最近 N 天」的调用（文件 mtime 窗口只决定扫哪些文件）
const windowFrom = startedAt - days * DAY_MS;
const inWindow = records.filter((r) => (r.ts ?? 0) >= windowFrom);
const summary = summarize(inWindow);
const models = byModel(inWindow);
const fmt = (n, d = 2) => (n === null || n === undefined ? "--" : Number(n).toFixed(d));
const coverage = result.coverage ?? { imported: result.files, eligible: result.files, remaining: 0 };

console.log("");
console.log(`会话根目录        ${root}（来源 ${source}，回填 ${days} 天）`);
console.log(
	`扫到 / 跳过的文件  ${result.files} 个（未变化 ${result.skipped.unchanged}，过老 ${result.skipped.tooOld}，过大 ${result.skipped.tooLarge}）`,
);
console.log(
	`文件覆盖率        已导入 ${coverage.imported}/${coverage.eligible} 个会话文件${coverage.remaining > 0 ? `（还剩 ${coverage.remaining} 个没扫，truncated=true）` : ""}`,
);
console.log(
	`读到的调用        ${result.records.length} 条（去重后账本 ${records.length} 条，其中 ts 在 ${days} 天内 ${inWindow.length} 条）`,
);
console.log(`窗口内调用         ${summary.calls}（成功 ${summary.ok} / 失败 ${summary.failed} / 未收全 ${summary.incomplete}）`);
console.log(
	`token 合计         ${summary.tokens.total}（输入 ${summary.tokens.input} / 输出 ${summary.tokens.output} / 缓存读 ${summary.tokens.cacheRead} / 缓存写 ${summary.tokens.cacheWrite} / 推理 ${summary.tokens.reasoning}）`,
);
console.log(`总成本（真实）     $${fmt(summary.cost.amount, 4)}（有价 ${summary.cost.pricedCalls} 次，无价 ${summary.cost.unpricedCalls} 次）`);
console.log(`TTFT              ${summary.ttft.samples} 个样本（回填没有 TTFT，符合预期）`);
console.log(`平均 tok·s⁻¹      ${fmt(summary.tokPerSec)}（${summary.tokPerSecSamples} 个样本）`);
console.log(`涉及模型 / 路由    ${summary.models} / ${summary.providers}`);
if (result.errors.length) console.log(`错误              ${result.errors.length} 条：${result.errors[0]?.reason ?? ""}`);
console.log("");
console.log("按模型 Top 8（调用数降序）");
console.log("模型                          调用   成功率   TTFT   延迟       tok/s   token      成本    占比");
for (const row of models.slice(0, 8)) {
	console.log(
		`${String(row.model).slice(0, 28).padEnd(30)}${String(row.calls).padStart(5)}  ${(row.successRate === null ? "--" : `${(row.successRate * 100).toFixed(1)}%`).padStart(6)}  ${"--".padStart(6)}  ${String(row.latencyAvg === null ? "--" : `${(row.latencyAvg / 1000).toFixed(1)}s`).padStart(8)}  ${fmt(row.tokPerSec).padStart(7)}  ${String(row.tokens.total).padStart(10)}  ${`$${fmt(row.cost.amount, 4)}`.padStart(9)}  ${row.costShare === null ? "--" : `${(row.costShare * 100).toFixed(1)}%`}`,
	);
}

// ── 与独立复算对照
const pct = (actual, expected) => (expected ? ((actual - expected) / expected) * 100 : null);
const devCalls = pct(summary.calls, REFERENCE.calls);
const devTokens = pct(summary.tokens.total, REFERENCE.tokens);
const devCost = pct(summary.cost.amount ?? 0, REFERENCE.cost);
const devLine = (label, actual, expected, dev, unit = "") =>
	`${label.padEnd(12)}${String(actual).padStart(14)}${unit}  参考 ${String(expected).padStart(14)}${unit}  偏差 ${dev === null ? "--" : `${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%`}`;

console.log("");
if (days !== REFERENCE.days) {
	console.log(`与独立复算对照  参考值只覆盖 ${REFERENCE.days} 天窗口，当前 ${days} 天 → 跳过对照`);
	console.log(`耗时 ${Date.now() - startedAt}ms`);
	process.exit(0);
}

const modelCalls = new Map(models.map((row) => [row.model, row.calls]));
console.log(`与独立复算对照（${REFERENCE.note}）`);
console.log(devLine("调用数", summary.calls, REFERENCE.calls, devCalls));
console.log(devLine("token", summary.tokens.total, REFERENCE.tokens, devTokens));
console.log(devLine("成本", fmt(summary.cost.amount, 4), REFERENCE.cost.toFixed(4), devCost, " "));
for (const [model, expected] of Object.entries(REFERENCE.models)) {
	const actual = modelCalls.get(model) ?? 0;
	console.log(devLine(`调用 ${model}`, actual, expected, pct(actual, expected)));
}

const deviations = [devCalls, devTokens, devCost].map((d) => (d === null ? 0 : Math.abs(d)));
const worst = Math.max(...deviations);
console.log(`最大偏差      ${Math.max(...deviations).toFixed(2)}%（容忍 ${(TOLERANCE * 100).toFixed(0)}%）`);

if (worst > TOLERANCE * 100) {
	// 归因：先看有没有少扫文件，再怀疑去重
	const causes = [];
	if (coverage.eligible > 0 && coverage.imported < coverage.eligible) {
		causes.push(`文件覆盖不足：只导入了 ${coverage.imported}/${coverage.eligible} 个会话文件，先跑满回填再复测`);
	}
	if (result.truncated) causes.push("本批次没扫完（truncated=true），结果不完整");
	if (!causes.length) {
		causes.push(
			`文件覆盖看起来是满的，偏差更可能来自去重/配对（误合并或漏配对）：账本 ${records.length} 条 vs 读到 ${result.records.length} 条`,
		);
	}
	console.log("");
	console.log("❌ 偏差超限：");
	for (const cause of causes) console.log(`   - ${cause}`);
	console.log(`耗时 ${Date.now() - startedAt}ms`);
	process.exit(1);
}

console.log("");
console.log("✅ 与独立复算一致（偏差在容忍范围内）");
console.log(`耗时 ${Date.now() - startedAt}ms`);
