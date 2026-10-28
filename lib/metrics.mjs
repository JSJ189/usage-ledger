/**
 * 账本聚合（纯函数，无 IO）。
 *
 * 口径（README / 看板 / 测试三处必须一致）：
 *  - **calls** = 账本记录条数（一条 = 一次模型调用）；
 *  - **ok / error / incomplete**：`status` 三态；`incomplete` = 事件没收到 message，
 *    或会话里没有 usage 块（老会话 / 中断），这类记录 token 与成本不可信；
 *  - **successRate** = ok / calls（incomplete 不算成功）；
 *  - **TTFT 分位**：nearest-rank，只统计 `ttftMs > 0` 的样本（回填记录永远没有
 *    TTFT，所以 `ttft.samples` 一般远小于 calls——看板必须把覆盖率显示出来）；
 *  - **平均 tok·s⁻¹** = 每次调用 `outputTokens / (durationMs / 1000)` 的均值，
 *    只算 `durationMs > 0 && outputTokens > 0` 的调用（除零样本直接排除）；
 *  - **成本** = SDK `usage.cost.total` 求和（真实成本，不估算）；没有成本字段的
 *    记录计入 `unpricedCalls`，金额统计里排除。
 */
import { RECORD_STATUS } from "./ledger.mjs";

const DAY_MS = 86_400_000;
/** 窗口键：今日 / 7 天 / 30 天 / 全部。 */
export const WINDOW_KEYS = ["today", "7d", "30d", "all"];
/** 趋势粒度。 */
export const BUCKET_KEYS = ["hour", "day"];
/** 记录表状态筛选。 */
export const STATUS_KEYS = ["all", "ok", "error", "incomplete"];
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

function toNum(v) {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function pad2(n) {
	return String(n).padStart(2, "0");
}

/** 窗口白名单化（非法 → today）。 */
export function normalizeWindow(key) {
	return WINDOW_KEYS.includes(key) ? key : "today";
}

/** 粒度白名单化（非法 → hour）。 */
export function normalizeBucket(key) {
	return BUCKET_KEYS.includes(key) ? key : "hour";
}

/** 状态白名单化（非法 → all）。 */
export function normalizeStatus(key) {
	return STATUS_KEYS.includes(key) ? key : "all";
}

/**
 * 解析时间窗口。`today` = 进程本地时区当日 00:00 起；`7d`/`30d` = 滚动窗口；
 * `all` = 不限下界（fromMs = 0）。
 * @param {unknown} key
 * @param {number} [nowMs]
 */
export function resolveWindow(key, nowMs = Date.now()) {
	const k = normalizeWindow(key);
	if (k === "all") return { key: k, fromMs: 0, toMs: nowMs };
	if (k === "today") {
		const d = new Date(nowMs);
		return { key: k, fromMs: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), toMs: nowMs };
	}
	const days = k === "7d" ? 7 : 30;
	return { key: k, fromMs: nowMs - days * DAY_MS, toMs: nowMs };
}

/** nearest-rank 分位（`sorted` 必须已升序；空数组 → null）。 */
export function percentileOf(sorted, p) {
	if (!Array.isArray(sorted) || sorted.length === 0) return null;
	const rank = Math.ceil(p * sorted.length);
	const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[idx];
}

/**
 * 一组数值的分位摘要。非有限值与非正数（TTFT 的 0 表示「没测到」）会被丢掉。
 * @returns {{samples:number, p50:number|null, p90:number|null, p99:number|null, avg:number|null}}
 */
export function percentiles(values, { positiveOnly = true } = {}) {
	const list = (Array.isArray(values) ? values : [])
		.map((v) => toNum(v))
		.filter((v) => v !== null && (!positiveOnly || v > 0))
		.sort((a, b) => a - b);
	if (!list.length) return { samples: 0, p50: null, p90: null, p99: null, avg: null };
	const sum = list.reduce((a, b) => a + b, 0);
	return {
		samples: list.length,
		p50: percentileOf(list, 0.5),
		p90: percentileOf(list, 0.9),
		p99: percentileOf(list, 0.99),
		avg: sum / list.length,
	};
}

function round(x, digits = 2) {
	if (x === null || !Number.isFinite(x)) return null;
	const f = 10 ** digits;
	return Math.round(x * f) / f;
}

/** token 汇总（缺失按 0 计）。 */
export function sumTokens(records) {
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
	for (const r of records ?? []) {
		tokens.input += toNum(r.inputTokens) ?? 0;
		tokens.output += toNum(r.outputTokens) ?? 0;
		tokens.cacheRead += toNum(r.cacheReadTokens) ?? 0;
		tokens.cacheWrite += toNum(r.cacheWriteTokens) ?? 0;
		tokens.reasoning += toNum(r.reasoningTokens) ?? 0;
		tokens.total += toNum(r.totalTokens) ?? 0;
	}
	return tokens;
}

/** 成本汇总：真实成本求和 + 覆盖情况（没有成本字段的调用单独计数）。 */
export function sumCost(records) {
	let amount = null;
	let pricedCalls = 0;
	let unpricedCalls = 0;
	for (const r of records ?? []) {
		const cost = toNum(r.costUsd);
		if (cost === null) {
			unpricedCalls++;
			continue;
		}
		pricedCalls++;
		amount = (amount ?? 0) + cost;
	}
	return {
		amount: amount === null ? null : round(amount, 6),
		pricedCalls,
		unpricedCalls,
		totalCalls: pricedCalls + unpricedCalls,
	};
}

/**
 * 每次调用的输出速率（tok/s），除零样本自动排除。
 * @returns {{avg:number|null, samples:number}}
 */
export function tokPerSec(records) {
	let sum = 0;
	let samples = 0;
	for (const r of records ?? []) {
		const out = toNum(r.outputTokens);
		const dur = toNum(r.durationMs);
		if (out === null || out <= 0 || dur === null || dur <= 0) continue;
		sum += out / (dur / 1000);
		samples++;
	}
	return { avg: samples ? round(sum / samples, 2) : null, samples };
}

/**
 * 汇总一组记录。
 * @param {object[]} records
 */
export function summarize(records) {
	const list = Array.isArray(records) ? records : [];
	const calls = list.length;
	const ok = list.filter((r) => r.status === RECORD_STATUS.ok).length;
	const error = list.filter((r) => r.status === RECORD_STATUS.error).length;
	const incomplete = list.filter((r) => r.status === RECORD_STATUS.incomplete).length;
	const ttft = percentiles(list.map((r) => r.ttftMs));
	const latency = percentiles(list.map((r) => r.durationMs));
	const rate = tokPerSec(list);
	const models = new Set();
	const providers = new Set();
	for (const r of list) {
		if (r.model) models.add(r.model);
		if (r.provider) providers.add(r.provider);
	}
	return {
		calls,
		ok,
		failed: error,
		incomplete,
		successRate: calls ? round(ok / calls, 4) : null,
		ttft: {
			samples: ttft.samples,
			p50: ttft.p50,
			p90: ttft.p90,
			p99: ttft.p99,
			avg: round(ttft.avg, 1),
			/** TTFT 覆盖率：回填的历史记录没有 TTFT，必须让用户看见这个比例。 */
			coverage: calls ? round(ttft.samples / calls, 4) : null,
		},
		latencyAvg: round(latency.avg, 1),
		latencyMax: latency.samples ? Math.max(...list.map((r) => toNum(r.durationMs) ?? 0)) : null,
		latencySamples: latency.samples,
		tokPerSec: rate.avg,
		tokPerSecSamples: rate.samples,
		tokens: sumTokens(list),
		cost: sumCost(list),
		models: models.size,
		providers: providers.size,
	};
}

/** 模型名归一（空 → `(unknown)`）。 */
export function modelKey(record) {
	const model = typeof record?.model === "string" ? record.model.trim() : "";
	return model || "(unknown)";
}

/**
 * 按模型汇总（用户第一诉求）：每行一个 model，带 token / 成本 / TTFT / 占比。
 * 排序：调用数降序 → 成本降序 → 名称升序（稳定，测试可断言）。
 */
export function byModel(records) {
	const list = Array.isArray(records) ? records : [];
	const groups = new Map();
	for (const record of list) {
		const key = modelKey(record);
		let bucket = groups.get(key);
		if (!bucket) {
			bucket = [];
			groups.set(key, bucket);
		}
		bucket.push(record);
	}
	const totalCalls = list.length;
	const totalCost = sumCost(list).amount;
	const rows = [];
	for (const [model, bucket] of groups) {
		const summary = summarize(bucket);
		const costAmount = summary.cost.amount;
		rows.push({
			model,
			calls: summary.calls,
			ok: summary.ok,
			failed: summary.failed,
			incomplete: summary.incomplete,
			successRate: summary.successRate,
			ttft: summary.ttft,
			latencyAvg: summary.latencyAvg,
			tokPerSec: summary.tokPerSec,
			tokens: summary.tokens,
			cost: summary.cost,
			callShare: totalCalls ? round(summary.calls / totalCalls, 4) : null,
			costShare:
				costAmount !== null && totalCost !== null && totalCost > 0 ? round(costAmount / totalCost, 4) : null,
			providers: [...new Set(bucket.map((r) => r.provider).filter(Boolean))].sort(),
		});
	}
	rows.sort(
		(a, b) => b.calls - a.calls || (b.cost.amount ?? -1) - (a.cost.amount ?? -1) || a.model.localeCompare(b.model),
	);
	return rows;
}

/** 本地小时键 `YYYY-MM-DDTHH:00:00`（与看板 fmtHour 同口径）。 */
export function hourKey(ms) {
	const d = new Date(toNum(ms) ?? 0);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:00:00`;
}

/** 本地日期键 `YYYY-MM-DD`。 */
export function dayKey(ms) {
	const d = new Date(toNum(ms) ?? 0);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 按粒度取桶键。 */
export function bucketKey(ms, bucket = "hour") {
	return normalizeBucket(bucket) === "day" ? dayKey(ms) : hourKey(ms);
}

/**
 * 趋势序列。每个桶：`{hour, calls, bad, ok, ttftP50, ttftP90, ttftSamples, tokens, costUsd}`。
 * 桶键放在 `hour` 字段里（`callsChart` / `ttftChart` 只认 `hour`，粒度靠键的形态区分）。
 */
export function series(records, { bucket = "hour" } = {}) {
	const b = normalizeBucket(bucket);
	const buckets = new Map();
	for (const record of Array.isArray(records) ? records : []) {
		if (toNum(record.ts) === null) continue;
		const key = bucketKey(record.ts, b);
		let items = buckets.get(key);
		if (!items) {
			items = [];
			buckets.set(key, items);
		}
		items.push(record);
	}
	const out = [];
	for (const [key, items] of buckets) {
		const summary = summarize(items);
		out.push({
			hour: key,
			bucket: b,
			calls: summary.calls,
			bad: summary.failed,
			ok: summary.ok,
			incomplete: summary.incomplete,
			ttftP50: summary.ttft.p50,
			ttftP90: summary.ttft.p90,
			ttftSamples: summary.ttft.samples,
			tokens: summary.tokens,
			costUsd: summary.cost.amount,
		});
	}
	out.sort((a, b2) => String(a.hour).localeCompare(String(b2.hour)));
	return out;
}

/** 过滤：模型（精确）/ 状态 / 关键字（模型或 provider 子串，大小写不敏感）。 */
export function filterRecords(records, { model = "", status = "all", q = "" } = {}) {
	const statusKey = normalizeStatus(status);
	const modelText = typeof model === "string" ? model.trim() : "";
	const query = typeof q === "string" ? q.trim().toLowerCase() : "";
	return (Array.isArray(records) ? records : []).filter((r) => {
		if (modelText && modelKey(r) !== modelText) return false;
		if (statusKey !== "all" && r.status !== statusKey) return false;
		if (query) {
			const haysto = `${r.model ?? ""} ${r.provider ?? ""} ${r.stopReason ?? ""}`.toLowerCase();
			if (!haysto.includes(query)) return false;
		}
		return true;
	});
}

/** 页大小白名单化（1–200，默认 20）。 */
export function clampPageSize(value) {
	const n = Math.trunc(Number(value));
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
	return Math.min(MAX_PAGE_SIZE, Math.max(1, n));
}

/**
 * 分页（按 ts 降序，最新在前）。
 * @returns {{items:object[], page:number, pageSize:number, pages:number, total:number}}
 */
export function pageRecords(records, { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
	const size = clampPageSize(pageSize);
	const sorted = [...(Array.isArray(records) ? records : [])].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
	const pages = Math.max(1, Math.ceil(sorted.length / size));
	const current = Math.min(pages, Math.max(1, Math.trunc(Number(page) || 1)));
	const start = (current - 1) * size;
	return { items: sorted.slice(start, start + size), page: current, pageSize: size, pages, total: sorted.length };
}

/** 记录表的展示投影（去掉内部字段，前端不用猜）。 */
export function projectRecord(record) {
	return {
		id: record.id,
		ts: record.ts,
		model: modelKey(record),
		provider: record.provider ?? null,
		thinkingLevel: record.thinkingLevel ?? null,
		conversationId: record.conversationId ?? null,
		projectDir: record.projectDir ?? null,
		inputTokens: toNum(record.inputTokens) ?? 0,
		outputTokens: toNum(record.outputTokens) ?? 0,
		cacheReadTokens: toNum(record.cacheReadTokens) ?? 0,
		cacheWriteTokens: toNum(record.cacheWriteTokens) ?? 0,
		reasoningTokens: toNum(record.reasoningTokens) ?? 0,
		totalTokens: toNum(record.totalTokens) ?? 0,
		costUsd: toNum(record.costUsd),
		durationMs: toNum(record.durationMs),
		ttftMs: toNum(record.ttftMs),
		stopReason: record.stopReason ?? null,
		status: record.status ?? RECORD_STATUS.ok,
		source: record.source ?? "backfill",
		sources: Array.isArray(record.sources) ? record.sources : [],
	};
}
