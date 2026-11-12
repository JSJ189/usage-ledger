/**
 * v3 用例的造数工具：**一套概念一种拼写**，metrics / rollup / store / live 共用。
 *
 * 两类数据形状（合同 §4.9）：
 *  1. `rollupRow()` —— 已聚合的 rollup 行（metrics / rollup 用例的输入）；
 *  2. `detailRow()` —— 单次调用的明细行（store 写库、live 用例的种子数据）。
 *
 * 时间基准固定成 2026-11-12 10:00（本地时区），避免用例依赖「跑测试的当天」。
 */
import { emptyHist, histAdd } from "../../../lib/v3/hist.mjs";

/** 用例基准时刻（本地 2026-11-12 10:00）。 */
export const T0 = new Date(2026, 10, 12, 10, 0, 0).getTime();
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface RollupSpec {
	bucket: number | string;
	status?: string;
	calls?: number;
	model?: string;
	modelId?: number;
	ttftMs?: number;
	e2eMs?: number;
	genMs?: number;
	inTok?: number;
	cacheRead?: number;
	/** 带缓存字段的调用数（0 = 这一行没有缓存采集，不该进 cacheHit 的样本数）。 */
	cacheN?: number;
	extra?: Record<string, unknown>;
}

/** 一条 rollup 行：所有可合并量按 `calls` 线性放大，直方图按样本逐条累加。 */
export function rollupRow(spec: RollupSpec): Record<string, unknown> {
	const calls = spec.calls ?? 1;
	const ttftMs = spec.ttftMs ?? 800;
	const e2eMs = spec.e2eMs ?? 2000;
	const genMs = spec.genMs ?? e2eMs - ttftMs;
	const inTok = spec.inTok ?? 100;
	const outTok = 50;
	const cacheRead = spec.cacheRead ?? 0;
	const ttftHist = emptyHist();
	const e2eHist = emptyHist();
	for (let i = 0; i < calls; i++) histAdd(ttftHist, ttftMs);
	for (let i = 0; i < calls; i++) histAdd(e2eHist, e2eMs);
	return {
		bucket: spec.bucket,
		model: spec.model ?? "m1",
		provider: "p1",
		project: "proj",
		modelId: spec.modelId ?? 1,
		providerId: 1,
		projectId: 1,
		status: spec.status ?? "ok",
		calls,
		inTok: inTok * calls,
		outTok: outTok * calls,
		cacheRead: cacheRead * calls,
		cacheWrite: 0,
		reasoningTok: 0,
		totalTok: (inTok + outTok + cacheRead) * calls,
		costSdk: 0.01 * calls,
		costEst: 0,
		unpriced: 0,
		e2eSum: e2eMs * calls,
		e2eN: calls,
		genSum: genMs * calls,
		genN: calls,
		outTokTput: outTok * calls,
		rateSum: (outTok / (genMs / 1000)) * calls,
		rateN: calls,
		cacheN: spec.cacheN ?? calls,
		ttftHist,
		e2eHist,
		...spec.extra,
	};
}

export interface DetailSpec {
	/** 同一 `id` = 同一条调用（`entryKey` 由它派生，用来测幂等）。 */
	id: number;
	ts: number;
	status?: string;
	model?: string;
	convId?: string;
}

/** 一条明细行（可写库的形状，§4.9）。 */
export function detailRow(spec: DetailSpec): Record<string, unknown> {
	return {
		entryKey: `e:sessions/seed.jsonl:m${spec.id}`,
		ts: spec.ts,
		convId: spec.convId ?? `conv-${spec.id % 3}`,
		model: spec.model ?? "m1",
		provider: "p1",
		project: "proj",
		status: spec.status ?? "ok",
		inTok: 100,
		outTok: 50,
		cacheRead: 10,
		cacheWrite: 0,
		totalTok: 160,
		costSdk: 0.002,
		ttftMs: 700,
		genMs: 1100,
		e2eMs: 1800,
		stopReason: "stop",
	};
}

/** 序列里所有点的 calls 之和（`Σ series.calls === kpi.calls` 不变量用）。 */
export function sumCalls(series: Array<{ calls: number }>): number {
	let total = 0;
	for (const point of series) total += point.calls;
	return total;
}
