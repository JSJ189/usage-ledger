#!/usr/bin/env node
/**
 * 真机会话回填自检（只读）：`npm run verify:sessions [天数]`
 *
 * 用真实的 `~/.pi/agent/sessions` 跑一遍与插件完全相同的解析 / 增量 / 去重 / 聚合
 * 代码路径，打印：
 *  - 扫到多少文件、读到多少 assistant 调用；
 *  - 去重后账本里多少条、总成本（SDK usage.cost.total 求和）、token 合计；
 *  - 按模型的 Top N（调用数 / 成本 / 平均 tok·s⁻¹）。
 *
 * 这个脚本**绝不写**会话目录，也不写插件 dataDir（账本是内存态）。
 * 单测不跑它（单测只碰临时目录的 fixture），它只用于人工核对真实数据。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { byModel, summarize } from "../lib/metrics.mjs";
import { createLedgerStore } from "../lib/ledger.mjs";
import { createSessionImporter, resolveSessionsRoot } from "../lib/sessions.mjs";

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
const summary = summarize(records);
const models = byModel(records);
const fmt = (n, d = 2) => (n === null || n === undefined ? "--" : Number(n).toFixed(d));

console.log("");
console.log(`会话根目录        ${root}（来源 ${source}，回填 ${days} 天）`);
console.log(`扫到 / 跳过的文件  ${result.files} 个（未变化 ${result.skipped.unchanged}，过老 ${result.skipped.tooOld}，过大 ${result.skipped.tooLarge}）`);
console.log(`读到的调用        ${result.records.length} 条（去重后账本 ${records.length} 条）`);
console.log(`窗口内调用         ${summary.calls}（成功 ${summary.ok} / 失败 ${summary.failed} / 未收全 ${summary.incomplete}）`);
console.log(`token 合计         ${summary.tokens.total}（输入 ${summary.tokens.input} / 输出 ${summary.tokens.output} / 缓存读 ${summary.tokens.cacheRead} / 缓存写 ${summary.tokens.cacheWrite} / 推理 ${summary.tokens.reasoning}）`);
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
console.log("");
console.log(`耗时 ${Date.now() - startedAt}ms`);
