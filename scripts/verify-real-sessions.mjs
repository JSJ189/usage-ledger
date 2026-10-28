#!/usr/bin/env node
/**
 * 真机会话回填自检（只读）：`npm run verify:sessions [天数]`
 *
 * 用真实的 `~/.pi/agent/sessions` 跑一遍与插件完全相同的解析 / 增量 / 去重 / 配对 / 聚合
 * 代码路径，打印：
 *  - 扫到多少文件、读到多少 assistant 调用、覆盖率（已导入 X/M 个会话文件）；
 *  - 去重后账本里多少条、token 合计、**SDK 成本 / 估算成本 / 估算占比**；
 *  - 按模型的 Top N（调用数 / 成本 / 吞吐 / **缓存命中率**）；
 *  - 与「独立复算参考值」的偏差（%，> 2% 时以非 0 退出并指明可能原因）。
 *
 * 参考值来自人工独立复算（Python 直扫会话 JSONL，不经插件代码），只在 7 天窗口有效。
 * 它是**参考值**，不是断言：脚本只报偏差，判定仍由人看。
 *
 * 这个脚本**绝不写**会话目录，也不写插件 dataDir（账本是内存态；价格快照只写在
 * 仓库自己的 `.cps-tmp/`，已被 .gitignore 忽略）。单测不跑它，它只用于人工核对真实数据。
 *
 * 价格来源（估算成本用，三种方式，按优先级）：
 *  1. `--prices <dir>`：读该目录下已经下载好的 `modelsdev.json` / `litellm.json` /
 *     `openrouter.json`（形状同三个公开源），**不联网**；默认目录 `.cps-tmp`；
 *  2. `--fetch`：用 Node 的 fetch 现场抓三个源（慢，需要网络）；
 *  3. 都没有 → 只报 SDK 成本，估算那几栏显示 `--`（不会因此崩）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { byModel, summarize } from "../lib/metrics.mjs";
import { createLedgerStore } from "../lib/ledger.mjs";
import { createSessionImporter, resolveSessionsRoot } from "../lib/sessions.mjs";
import { PRICE_CACHE_FILE, createPriceBook, normalizeSource } from "../lib/prices.mjs";

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
	note: "人工复算（历史快照，只作下界参考）：94 个 7 天内修改过的会话文件，assistant+usage 行中消息 ts 在 7 天内的计 43470 次",
};

const args = process.argv.slice(2);
const daysArg = args.find((a) => /^\d+$/.test(a));
const days = Number(daysArg) > 0 ? Number(daysArg) : 30;
const pricesFlag = args.indexOf("--prices");
const pricesDir = pricesFlag >= 0 ? (args[pricesFlag + 1] ?? ".cps-tmp") : ".cps-tmp";
const fetchPrices = args.includes("--fetch");

/**
 * 准备价格快照：优先用本地已下载的源文件合成 `prices.json`（离线），
 * 其次 `--fetch` 现场抓，最后空快照（只报 SDK 成本）。
 * @returns {Promise<{book: ReturnType<typeof createPriceBook>, mode: string}>}
 */
async function preparePrices() {
	const book = createPriceBook({ dir: pricesDir });
	book.load();
	if (book.status().entries > 0) return { book, mode: `缓存 ${join(pricesDir, PRICE_CACHE_FILE)}` };
	if (existsSync(pricesDir)) {
		const entries = [];
		const sources = [];
		for (const id of ["modelsdev", "litellm", "openrouter"]) {
			const file = join(pricesDir, `${id}.json`);
			try {
				const rows = normalizeSource(id, JSON.parse(readFileSync(file, "utf8")));
				entries.push(...rows);
				sources.push({ id, label: id, ok: rows.length > 0, count: rows.length, ms: 0, error: null });
			} catch {
				sources.push({ id, label: id, ok: false, count: 0, ms: 0, error: "本地源文件缺失或不是合法 JSON" });
			}
		}
		if (entries.length) {
			mkdirSync(pricesDir, { recursive: true });
			writeFileSync(
				join(pricesDir, PRICE_CACHE_FILE),
				`${JSON.stringify({ schema: 1, fetchedAt: Date.now(), sources, entries, lastError: null })}
`,
				"utf8",
			);
			book.load();
			return { book, mode: `本地源文件 ${pricesDir}/（未联网）` };
		}
	}
	if (fetchPrices) {
		await book.refresh();
		return { book, mode: `现场抓取（${book.status().entries} 行）` };
	}
	return { book, mode: "无（只报 SDK 成本；加 --prices <目录> 或 --fetch 可估算）" };
}
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
const { book, mode: priceMode } = await preparePrices();
// 与插件读取侧同一条码路：价格解析按模型记忆化（book.resolve），记录级只做乘法
const records = store.list().map((record) => book.price(record));
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
console.log(`SDK 成本          $${fmt(summary.cost.sdkAmount, 4)}（SDK 给了价的 ${summary.cost.sdkCalls} 次）`);
console.log(`估算成本          $${fmt(summary.cost.estimatedAmount, 4)}（按价格表估算的 ${summary.cost.estimatedCalls} 次）`);
console.log(
	`合计成本          $${fmt(summary.cost.amount, 4)}（有价 ${summary.cost.pricedCalls} 次，无价 ${summary.cost.unpricedCalls} 次）`,
);
console.log(
	`估算占比          ${summary.cost.estimateShare === null ? "--" : `${(summary.cost.estimateShare * 100).toFixed(2)}%`}（价格来源：${priceMode}）`,
);
console.log(`TTFT              ${summary.ttft.samples} 个样本（回填没有 TTFT，符合预期）`);
console.log(
	`吞吐 / 均值 tok·s⁻¹ ${fmt(summary.tokPerSec)} / ${fmt(summary.tokPerSecMean)}（${summary.tokPerSecSamples} 个样本）`,
);
console.log(
	`缓存命中率        ${summary.cacheHitRate === null ? "--" : `${(summary.cacheHitRate * 100).toFixed(2)}%`}（加权；均值 ${summary.cacheHitRateMean === null ? "--" : `${(summary.cacheHitRateMean * 100).toFixed(2)}%`}，${summary.cacheHitSamples} 个样本）`,
);
console.log(`涉及模型 / 路由    ${summary.models} / ${summary.providers}`);
if (result.errors.length) console.log(`错误              ${result.errors.length} 条：${result.errors[0]?.reason ?? ""}`);
console.log("");
console.log("按模型 Top 8（调用数降序）");
console.log(
	"模型                          调用   成功率  延迟       tok/s   token      成本   估算   命中率  占比",
);
for (const row of models.slice(0, 8)) {
	const hit = row.cacheHitRate === null ? "--" : `${(row.cacheHitRate * 100).toFixed(1)}%`;
	console.log(
		`${String(row.model).slice(0, 28).padEnd(30)}${String(row.calls).padStart(5)}  ${(row.successRate === null ? "--" : `${(row.successRate * 100).toFixed(1)}%`).padStart(6)}  ${String(row.latencyAvg === null ? "--" : `${(row.latencyAvg / 1000).toFixed(1)}s`).padStart(8)}  ${fmt(row.tokPerSec).padStart(7)}  ${String(row.tokens.total).padStart(10)}  ${`$${fmt(row.cost.amount, 4)}`.padStart(8)}  ${`$${fmt(row.cost.estimatedAmount, 4)}`.padStart(8)}  ${hit.padStart(7)}  ${row.costShare === null ? "--" : `${(row.costShare * 100).toFixed(1)}%`}`,
	);
}

// ── 与独立复算对照
const pct = (actual, expected) => (expected ? ((actual - expected) / expected) * 100 : null);
const devCalls = pct(summary.calls, REFERENCE.calls);
const devTokens = pct(summary.tokens.total, REFERENCE.tokens);
// 参考值是纯 SDK 成本（2.0 时代没有估算），必须拿 sdkAmount 对照，否则会把估算算成「偏差」
const devCost = pct(summary.cost.sdkAmount ?? 0, REFERENCE.cost);
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
console.log(devLine("SDK 成本", fmt(summary.cost.sdkAmount, 4), REFERENCE.cost.toFixed(4), devCost, " "));
console.log(devLine("估算成本", fmt(summary.cost.estimatedAmount, 4), 0, null, " "));
console.log(devLine("合计成本", fmt(summary.cost.amount, 4), REFERENCE.cost.toFixed(4), null, " "));
for (const [model, expected] of Object.entries(REFERENCE.models)) {
	const actual = modelCalls.get(model) ?? 0;
	console.log(devLine(`调用 ${model}`, actual, expected, pct(actual, expected)));
}

// 判定口径（必须写清，否则会误报）：
//  - REFERENCE 是**历史快照**。滚动 7 天/30 天窗口每天都在长，正偏差（现在的数比快照大）
//    是正常的，不能当失败；
//  - 真正要拦的是**少算**：负偏差超过容忍度、或文件没导完、或本批 truncated，
//    那说明有数据漏了；
//  - 需要旧行为（正负都拦）时加 `--strict`。
const strict = args.includes("--strict");
const costDev = devCost;
const undercount = costDev !== null && costDev < -TOLERANCE * 100;
const overcount = costDev !== null && costDev > TOLERANCE * 100;
const coverageGap = coverage.eligible > 0 && coverage.imported < coverage.eligible;
const worst = costDev === null ? 0 : Math.abs(costDev);
console.log(`最大偏差      ${worst.toFixed(2)}%（容忍 ${(TOLERANCE * 100).toFixed(0)}%）`);

const failures = [];
if (undercount) failures.push(`SDK 成本比参考值少 ${Math.abs(costDev).toFixed(2)}%，疑似漏数据（覆盖 ${coverage.imported}/${coverage.eligible}，truncated=${result.truncated}）`);
if (coverageGap) failures.push(`文件覆盖不足：只导入了 ${coverage.imported}/${coverage.eligible} 个会话文件，先跑满回填再复测`);
if (result.truncated) failures.push("本批次没扫完（truncated=true），结果不完整");
if (strict && overcount) failures.push(`--strict 下正偏差 ${costDev.toFixed(2)}% 也判失败`);

if (failures.length) {
	console.log("");
	console.log("❌ 校验失败：");
	for (const f of failures) console.log(`   - ${f}`);
	console.log(`耗时 ${Date.now() - startedAt}ms`);
	process.exit(1);
}

if (overcount) {
	console.log(`⚠️ 正偏差 ${costDev.toFixed(2)}%：参考值是历史快照，滚动窗口已增长，不作失败判定（要拦加 --strict）`);
}

console.log("");
console.log("✅ 与独立复算一致（无少算；覆盖完整）");
console.log(`耗时 ${Date.now() - startedAt}ms`);
