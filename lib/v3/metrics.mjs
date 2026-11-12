/**
 * v3 口径函数（**纯函数，不碰 IO**）。输入永远是 rollup 行数组（≤几千行）。
 *
 * 口径来源：合同 §三「口径约定」+ §5.1 的字段名（逐字对齐，index.mjs 直接用）。
 *  - `calls` = 明细行数（六态之和）；`successRate` = ok /（ok+client+rate+provider），
 *    **排除 aborted / incomplete**；
 *  - `inTok` = 非缓存输入；`promptTok` = inTok + cacheRead + cacheWrite；
 *    `cacheHitRate` = Σ cacheRead / Σ promptTok（加权）；
 *  - `tokPerSec` = Σ outTok /（Σ genMs/1000）（加权）；`tokPerSecMean` = 每次调用速率的
 *    算术均值（靠 rollup 的 `rateSum/rateN`，这是本实现对合同 schema 的**唯一扩展**）；
 *  - 分位一律来自直方图合并（`approx: true`），绝不平均已算好的 p50/p95；
 *  - 成本四态：`sdk` / `estimate` / `unpriced`（缺价单独计数，金额里排除、标「≥ 下限」）。
 *
 * 硬约束（合同 §一.3）：禁止 `Math.max(...arr)` / `push(...arr)`，全部用 `for` 循环。
 */
import { BINS, HIST_BYTES, decodeHist, emptyHist, histTotal, mergeHistInto, quantile } from "./hist.mjs";

/** 六个状态（顺序固定：UI 图例 / filters.statuses 都用它）。 */
export const STATUSES = ["ok", "client_error", "rate_limited", "provider_error", "aborted", "incomplete"];
/** 计入成功率分母的「有应答」状态。 */
export const ANSWERED_STATUSES = ["ok", "client_error", "rate_limited", "provider_error"];
/** 归算「错误」的状态（series.error / topN.errorRate）。 */
export const ERROR_STATUSES = ["client_error", "rate_limited", "provider_error"];

const STATUS_ALIASES = {
	ok: "ok",
	success: "ok",
	stop: "ok",
	tooluse: "ok",
	length: "ok",
	client_error: "client_error",
	clienterror: "client_error",
	invalid_request: "client_error",
	bad_request: "client_error",
	"4xx": "client_error",
	rate_limited: "rate_limited",
	rate_limit: "rate_limited",
	ratelimit: "rate_limited",
	"429": "rate_limited",
	provider_error: "provider_error",
	error: "provider_error",
	server_error: "provider_error",
	timeout: "provider_error",
	"5xx": "provider_error",
	aborted: "aborted",
	abort: "aborted",
	cancel: "aborted",
	cancelled: "aborted",
	canceled: "aborted",
	interrupted: "aborted",
	incomplete: "incomplete",
	pending: "incomplete",
	deferred: "incomplete",
	unknown: "incomplete",
};

/** 状态归一六态（未知/空 → `incomplete`：没有结论的调用不能算 success 也不能算失败）。 */
export function statusClass(status) {
	const key = String(status ?? "")
		.trim()
		.toLowerCase();
	return STATUS_ALIASES[key] ?? "incomplete";
}

// ──────────────────────────────────────────────────────── 时间与粒度

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function toNum(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function toNum0(v) {
	const n = toNum(v);
	return n === null ? 0 : n;
}

function pad2(n) {
	return String(n).padStart(2, "0");
}

/** 本地小时起点（UTC 毫秒）。 */
export function hourStart(ms) {
	const d = new Date(toNum(ms) ?? 0);
	d.setMinutes(0, 0, 0);
	return d.getTime();
}

/** 本地 6 小时起点。 */
export function sixHourStart(ms) {
	const d = new Date(toNum(ms) ?? 0);
	d.setHours(Math.floor(d.getHours() / 6) * 6, 0, 0, 0);
	return d.getTime();
}

/** 本地当天 00:00（UTC 毫秒）。 */
export function dayStart(ms) {
	const d = new Date(toNum(ms) ?? 0);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 本地日期键 `YYYY-MM-DD`。 */
export function dayKeyOf(ms) {
	const d = new Date(toNum(ms) ?? 0);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `YYYY-MM-DD` → 本地当天 00:00 的 UTC 毫秒（非法 → 0）。 */
export function dayKeyToMs(day) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? "").trim());
	if (!m) return 0;
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** 本地小时键 `YYYY-MM-DDTHH:00:00`（人读调试用）。 */
export function hourKeyOf(ms) {
	const d = new Date(toNum(ms) ?? 0);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:00:00`;
}

/** 支持的粒度（合同 §5），`auto` 由 `autoGran` 解析。 */
export const GRANS = ["5m", "15m", "1h", "6h", "1d"];

/** 粒度归一：`auto|5m|15m|1h|6h|1d|hour|day` → 上一个列里的规范值。 */
export function normalizeGran(gran, { fromMs = 0, toMs = Date.now() } = {}) {
	const key = String(gran ?? "")
		.trim()
		.toLowerCase();
	if (key === "auto" || key === "" || key === "undefined") return autoGran(fromMs, toMs);
	if (key === "hour" || key === "h" || key === "1hour") return "1h";
	if (key === "day" || key === "d" || key === "24h") return "1d";
	if (GRANS.includes(key)) return key;
	return autoGran(fromMs, toMs);
}

/**
 * range 跨度 → 粒度（方案 §2.4.2 的 Datadog 阶梯，收敛到 ≤720 点）。
 * 注意：`5m` 需要 5 分钟桶，而 rollup 只有小时/天两级（合同 §三）——`seriesFromRows`
 * 检测到行粒度比请求的粗时会**降级**到行粒度并在 `meta.granDowngraded` 里标出来，
 * 绝不把一小时的数据塞进 12 个假 5 分钟桶。
 */
export function autoGran(fromMs, toMs) {
	const from = toNum(fromMs) ?? 0;
	const to = toNum(toMs) ?? Date.now();
	const span = Math.max(0, to - from);
	if (span <= 26 * HOUR_MS) return "5m";
	if (span <= 45 * DAY_MS) return "1h";
	if (span <= 120 * DAY_MS) return "6h";
	return "1d";
}

/** 该粒度下 `ms` 所在桶的起点。 */
export function bucketStartOf(ms, gran) {
	const g = normalizeGran(gran);
	if (g === "1d") return dayStart(ms);
	if (g === "6h") return sixHourStart(ms);
	if (g === "5m") {
		const v = toNum(ms) ?? 0;
		const off = new Date(v).getTimezoneOffset() * 60_000;
		return Math.floor((v - off) / 300_000) * 300_000 + off;
	}
	if (g === "15m") {
		const v = toNum(ms) ?? 0;
		const off = new Date(v).getTimezoneOffset() * 60_000;
		return Math.floor((v - off) / 900_000) * 900_000 + off;
	}
	return hourStart(ms);
}

/** 下一个桶起点（天桶按本地日历推进，处理夏令时）。 */
export function nextBucketStart(t, gran) {
	const g = normalizeGran(gran);
	if (g === "1d") {
		const d = new Date(t);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
	}
	if (g === "6h") return t + 6 * HOUR_MS;
	if (g === "5m") return t + 300_000;
	if (g === "15m") return t + 900_000;
	return t + HOUR_MS;
}

// ──────────────────────────────────────────────────────── rollup 行归一

/**
 * 把「库里读出来的行 / worker 推来的 delta / 内存索引行」统一成 camelCase 数值形状。
 * 直方图统一成 `Uint32Array(BINS)` 的两份拷贝（`ttftHist` / `e2eHist`）。
 * 入参容忍 snake_case 别名（`model_id` `cost_sdk` `ttft_hist` …），方便迁移与调试。
 */
export function normalizeRollupRow(row) {
	if (!row || typeof row !== "object") return null;
	// 热路径（每次 overview 要过几千行）：全部直连取值，不用闭包 / rest 参数 / 临时数组
	const out = {
		bucket: row.bucket ?? row.day ?? 0,
		modelId: toNum0(row.modelId ?? row.model_id),
		providerId: toNum0(row.providerId ?? row.provider_id),
		projectId: toNum0(row.projectId ?? row.project_id),
		model: row.model ?? null,
		provider: row.provider ?? null,
		project: row.project ?? null,
		status: statusClass(row.status),
		calls: toNum0(row.calls),
		inTok: toNum0(row.inTok ?? row.in_tok),
		outTok: toNum0(row.outTok ?? row.out_tok),
		cacheRead: toNum0(row.cacheRead ?? row.cache_read),
		cacheWrite: toNum0(row.cacheWrite ?? row.cache_write),
		reasoningTok: toNum0(row.reasoningTok ?? row.reasoning_tok),
		totalTok: toNum0(row.totalTok ?? row.total_tok),
		costSdk: toNum0(row.costSdk ?? row.cost_sdk),
		costEst: toNum0(row.costEst ?? row.cost_est),
		unpriced: toNum0(row.unpriced),
		e2eSum: toNum0(row.e2eSum ?? row.e2e_sum),
		e2eN: toNum0(row.e2eN ?? row.e2e_n),
		genSum: toNum0(row.genSum ?? row.gen_sum),
		genN: toNum0(row.genN ?? row.gen_n),
		outTokTput: toNum0(row.outTokTput ?? row.out_tok_tput),
		rateSum: toNum0(row.rateSum ?? row.rate_sum),
		rateN: toNum0(row.rateN ?? row.rate_n),
		cacheN: toNum0(row.cacheN ?? row.cache_n),
		ttftHist: histOf(row.ttftHist ?? row.ttft_hist ?? row.hist?.ttft),
		e2eHist: histOf(row.e2eHist ?? row.e2e_hist ?? row.hist?.e2e),
	};
	// 稀疏表示：一个「小时 × 维度 × 状态」桶里非零的分位桶通常只有 1–3 个，
	// 累加时只遍历这些（136 → 3），单趟聚合才可能进 10ms 量级。
	const ttftPairs = sparsePairs(out.ttftHist);
	const e2ePairs = sparsePairs(out.e2eHist);
	out.ttftPairs = ttftPairs;
	out.e2ePairs = e2ePairs;
	out.ttftN = pairsTotal(ttftPairs);
	out.e2eN = pairsTotal(e2ePairs);
	return out;
}

/** 直方图 → 稀疏桶对 `[bin, count, bin, count, ...]`（只含非零桶）。 */
export function sparsePairs(hist) {
	if (!hist) return EMPTY_PAIRS;
	let n = 0;
	for (let i = 0; i < BINS; i++) if (hist[i]) n++;
	if (!n) return EMPTY_PAIRS;
	const out = new Int32Array(n * 2);
	let at = 0;
	for (let i = 0; i < BINS; i++) {
		const c = hist[i];
		if (!c) continue;
		out[at++] = i;
		out[at++] = c;
	}
	return out;
}

const EMPTY_PAIRS = new Int32Array(0);

function pairsTotal(pairs) {
	let total = 0;
	for (let i = 1; i < pairs.length; i += 2) total += pairs[i];
	return total;
}

/** 任意 hist 载体 → 新的 Uint32Array（拷贝，避免共享可变状态）。 */
function histOf(src) {
	const target = emptyHist();
	if (!src) return target;
	// SQLite 读回的 BLOB 是 Uint8Array（字节），内存里的直方图是 Uint32Array（桶计数）
	const per = src.BYTES_PER_ELEMENT ?? 0;
	if (per === 1 && src.length >= HIST_BYTES) return decodeHist(src);
	if (typeof src.length === "number") {
		const n = Math.min(target.length, src.length);
		for (let i = 0; i < n; i++) target[i] = toNum0(src[i]);
		return target;
	}
	return target;
}

/** rollup 行的复合键（粒度 + 维度 + 状态）。 */
export function rollupKeyOf(row) {
	// 容忍 snake_case / 未归一的原始行：先归一，否则不同维度会塌成同一个 key
	const r = row && row.ttftPairs ? row : normalizeRollupRow(row);
	if (!r) return "";
	return `${r.bucket}|${r.modelId}|${r.providerId}|${r.projectId}|${r.status}`;
}

function round(x, digits = 2) {
	const n = toNum(x);
	if (n === null || !Number.isFinite(n)) return null;
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

/** 稀疏桶对 → 累加器（只碰非零桶）。 */
function mergePairs(target, pairs) {
	for (let i = 0; i < pairs.length; i += 2) {
		const v = (target[pairs[i]] || 0) + pairs[i + 1];
		target[pairs[i]] = v > 0 ? v : 0;
	}
	return target;
}

// ──────────────────────────────────────────────────────── 累加器

/** 空累加器（所有可合并量）。rollup.mjs 的单趟聚合也用它。 */
export function createAccum() {
	return {
		calls: 0,
		ok: 0,
		client: 0,
		rate: 0,
		provider: 0,
		aborted: 0,
		incomplete: 0,
		inTok: 0,
		outTok: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoningTok: 0,
		totalTok: 0,
		costSdk: 0,
		costEst: 0,
		unpriced: 0,
		e2eSum: 0,
		e2eN: 0,
		genSum: 0,
		genN: 0,
		outTokTput: 0,
		rateSum: 0,
		rateN: 0,
		cacheN: 0,
		ttft: emptyHist(),
		e2e: emptyHist(),
	};
}

/** 把一行 rollup 累加进 `acc`（纯加法，不分配直方图）。 */
export function accumulateRow(acc, row) {
	if (!row) return acc;
	acc.calls += row.calls;
	switch (row.status) {
		case "ok":
			acc.ok += row.calls;
			break;
		case "client_error":
			acc.client += row.calls;
			break;
		case "rate_limited":
			acc.rate += row.calls;
			break;
		case "provider_error":
			acc.provider += row.calls;
			break;
		case "aborted":
			acc.aborted += row.calls;
			break;
		default:
			acc.incomplete += row.calls;
			break;
	}
	acc.inTok += row.inTok;
	acc.outTok += row.outTok;
	acc.cacheRead += row.cacheRead;
	acc.cacheWrite += row.cacheWrite;
	acc.reasoningTok += row.reasoningTok;
	acc.totalTok += row.totalTok;
	acc.costSdk += row.costSdk;
	acc.costEst += row.costEst;
	acc.unpriced += row.unpriced;
	acc.e2eSum += row.e2eSum;
	acc.e2eN += row.e2eN;
	acc.genSum += row.genSum;
	acc.genN += row.genN;
	acc.outTokTput += row.outTokTput;
	acc.rateSum += row.rateSum;
	acc.rateN += row.rateN;
	acc.cacheN += row.cacheN;
	if (row.ttftPairs) mergePairs(acc.ttft, row.ttftPairs);
	else mergeHistInto(acc.ttft, row.ttftHist);
	if (row.e2ePairs) mergePairs(acc.e2e, row.e2ePairs);
	else mergeHistInto(acc.e2e, row.e2eHist);
	return acc;
}

export function accumulateRows(rows) {
	const acc = createAccum();
	if (!Array.isArray(rows)) return acc;
	for (let i = 0; i < rows.length; i++) accumulateRow(acc, rows[i]);
	return acc;
}

/** 成本四态（§5.1 `kpi.cost`）。 */
export function costBuckets(rows) {
	const list = Array.isArray(rows) ? rows : [];
	let sdkAmount = 0;
	let estimatedAmount = 0;
	let unpricedCalls = 0;
	for (let i = 0; i < list.length; i++) {
		const r = list[i];
		if (!r) continue;
		sdkAmount += r.costSdk;
		estimatedAmount += r.costEst;
		unpricedCalls += r.unpriced;
	}
	const amount = sdkAmount + estimatedAmount;
	return {
		amount: round(amount, 6),
		sdkAmount: round(sdkAmount, 6),
		estimatedAmount: round(estimatedAmount, 6),
		unpricedCalls,
		estimateShare: amount > 0 ? round(estimatedAmount / amount, 4) : null,
		isLowerBound: unpricedCalls > 0,
	};
}

/**
 * 缓存命中率汇总。
 *  - `weighted` = Σ cacheRead / Σ promptTok（合同 §三 的定义，分母含全部 promptTok）；
 *  - `samples` = 带缓存字段的调用数（`cacheN`，真实数据里回填行才有）；
 *  - `saveRate` = Σ cacheRead / Σ promptTok 的**同值**代理：缓存替掉的「原价输入占比」。
 *    金额级省钱率需要每条记录的 cachRead 单价，rollup 里没有，v3 不做（见方案 §2.8
 *    「cacheSave 与命中率分开两个数」——本实现只给 token 级代理，不假装是金额）。
 */
export function cacheStats(rows) {
	const list = Array.isArray(rows) ? rows : [];
	let readSum = 0;
	let promptSum = 0;
	let samples = 0;
	for (let i = 0; i < list.length; i++) {
		const r = list[i];
		if (!r) continue;
		readSum += r.cacheRead;
		promptSum += r.inTok + r.cacheRead + r.cacheWrite;
		samples += r.cacheN;
	}
	const weighted = promptSum > 0 ? round(readSum / promptSum, 4) : null;
	return { weighted, samples, saveRate: weighted };
}

/**
 * 吞吐（tok·s⁻¹）。
 *  - `weighted` = Σ outTokTput /（Σ genSum/1000）：回答「这段时间整体多快」；
 *  - `mean` = 每次调用速率的算术均值（`rateSum/rateN`），回答「单次调用平均多快」；
 *    老数据没有 `rateSum` 时退化为 `weighted`（并在 `meanExact:false` 标出来）。
 */
export function throughput(rows) {
	const list = Array.isArray(rows) ? rows : [];
	let outSum = 0;
	let genSum = 0;
	let rateSum = 0;
	let rateN = 0;
	let genN = 0;
	for (let i = 0; i < list.length; i++) {
		const r = list[i];
		if (!r) continue;
		outSum += r.outTokTput;
		genSum += r.genSum;
		rateSum += r.rateSum;
		rateN += r.rateN;
		genN += r.genN;
	}
	const weighted = genSum > 0 ? round(outSum / (genSum / 1000), 2) : null;
	const exact = rateN > 0;
	return {
		weighted,
		mean: exact ? round(rateSum / rateN, 2) : weighted,
		meanExact: exact,
		samples: exact ? rateN : genN,
	};
}

/**
 * 累加器 → KPI（字段名逐字对齐合同 §5.1 `kpi`）。
 * `throughput/cacheStats/costBuckets` 的入参是「同一批行」，这里直接用 acc 算，
 * 免得为了一个 KPI 再扫一遍行（rollup.mjs 的单趟聚合就靠它）。
 */
export function kpiFromAccum(acc) {
	const answered = acc.ok + acc.client + acc.rate + acc.provider;
	const ttftSamples = histTotal(acc.ttft);
	const e2eSamples = histTotal(acc.e2e);
	const weighted = acc.genSum > 0 ? round(acc.outTokTput / (acc.genSum / 1000), 2) : null;
	const meanExact = acc.rateN > 0;
	const promptTok = acc.inTok + acc.cacheRead + acc.cacheWrite;
	const costAmount = acc.costSdk + acc.costEst;
	return {
		calls: acc.calls,
		ok: acc.ok,
		error: acc.client + acc.rate + acc.provider,
		incomplete: acc.incomplete,
		aborted: acc.aborted,
		answered,
		successRate: answered > 0 ? round(acc.ok / answered, 4) : null,
		ttft: {
			p50: quantile(acc.ttft, 0.5),
			p90: quantile(acc.ttft, 0.9),
			p99: quantile(acc.ttft, 0.99),
			samples: ttftSamples,
			coverage: acc.calls > 0 ? round(ttftSamples / acc.calls, 4) : null,
			approx: true,
		},
		e2e: {
			p50: quantile(acc.e2e, 0.5),
			p90: quantile(acc.e2e, 0.9),
			p99: quantile(acc.e2e, 0.99),
			samples: e2eSamples,
			coverage: acc.calls > 0 ? round(e2eSamples / acc.calls, 4) : null,
			approx: true,
		},
		tokPerSec: weighted,
		tokPerSecMean: meanExact ? round(acc.rateSum / acc.rateN, 2) : weighted,
		tokPerSecMeanExact: meanExact,
		tokPerSecSamples: meanExact ? acc.rateN : acc.genN,
		cacheHitRate: promptTok > 0 ? round(acc.cacheRead / promptTok, 4) : null,
		cacheHitSamples: acc.cacheN,
		cacheSaveRate: promptTok > 0 ? round(acc.cacheRead / promptTok, 4) : null,
		tokens: {
			input: acc.inTok,
			output: acc.outTok,
			cacheRead: acc.cacheRead,
			cacheWrite: acc.cacheWrite,
			reasoning: acc.reasoningTok,
			total: acc.totalTok > 0 ? acc.totalTok : acc.inTok + acc.outTok + acc.cacheRead + acc.cacheWrite,
		},
		cost: {
			amount: round(costAmount, 6),
			sdkAmount: round(acc.costSdk, 6),
			estimatedAmount: round(acc.costEst, 6),
			unpricedCalls: acc.unpriced,
			estimateShare: costAmount > 0 ? round(acc.costEst / costAmount, 4) : null,
			isLowerBound: acc.unpriced > 0,
		},
	};
}

/**
 * 一组 rollup 行 → KPI（= 累加 + `kpiFromAccum`）。
 * `opts.fromMs/toMs` 给了就再按「区间相交」筛一遍（保 `Σ series.calls === calls` 不变量）。
 */
export function summarizeRows(rows, opts = {}) {
	const list = Array.isArray(rows) ? rows : [];
	const acc = createAccum();
	for (let i = 0; i < list.length; i++) {
		const row = list[i];
		if (!row || !rowInWindow(row, opts)) continue;
		accumulateRow(acc, row);
	}
	return kpiFromAccum(acc);
}

/** 行是否与 [fromMs,toMs] 区间相交（未给窗口 → 恒真）。 */
export function rowInWindow(row, opts = {}) {
	const fromMs = toNum(opts.fromMs);
	const toMs = toNum(opts.toMs);
	if (fromMs === null || toMs === null) return true;
	if (!row) return false;
	const rowStart = typeof row.bucket === "string" ? dayKeyToMs(row.bucket) : toNum0(row.bucket);
	const rowEnd = nextBucketStart(rowStart, rowGranOf(row));
	return rowEnd > fromMs && rowStart < toMs;
}

/** 粒度从细到粗的顺序（升粒度用）。 */
const GRAN_LADDER = ["5m", "15m", "1h", "6h", "1d"];

function granRank(gran) {
	const idx = GRAN_LADDER.indexOf(normalizeGranNoAuto(gran));
	return idx < 0 ? GRAN_LADDER.length - 1 : idx;
}

function normalizeGranNoAuto(gran) {
	const key = String(gran ?? "")
		.trim()
		.toLowerCase();
	if (key === "hour" || key === "h") return "1h";
	if (key === "day" || key === "d") return "1d";
	return GRAN_LADDER.includes(key) ? key : "1h";
}

/** 取更粗的那个粒度。 */
function coarserGran(a, b) {
	return granRank(a) >= granRank(b) ? normalizeGranNoAuto(a) : normalizeGranNoAuto(b);
}

/** 下一个更粗的粒度（已到 1d → null）。 */
function nextCoarserGran(gran) {
	const idx = granRank(gran);
	return idx >= GRAN_LADDER.length - 1 ? null : GRAN_LADDER[idx + 1];
}

/** 一行 rollup 自身的粒度：天桶（字符串键）→ 1d，数值桶 → 1h。 */
function rowGranOf(row) {
	return typeof row?.bucket === "string" ? "1d" : "1h";
}

/**
 * 趋势序列（**必须按 range/gran 补 0 桶**，合同 §5.1）。
 *
 * 三条硬不变量：
 *  1. `Σ series[i].calls === summarizeRows(同一批 rows).calls`——窗口外的行**不计入**，
 *     跨窗口边界的桶按「区间相交」计入并夹到首/末桶，**绝不新建窗口外的桶**；
 *  2. 枚举出的桶数超过 `maxBuckets` 时**自动升粒度**（5m→15m→1h→6h→1d）重算，
 *     而不是截断；只有已到 `1d` 且仍超限时才把多出来的天并进末桶（`meta.truncated=true`）；
 *  3. 请求粒度比行粒度细（例如行只有小时桶却要 5m）→ **降级到行粒度**并标
 *     `meta.granDowngraded`，绝不把一小时的量塞进假 5 分钟桶。
 *
 * 返回值是点数组；额外元挂在数组的 `meta` 属性上（不可枚举，不影响 JSON）：
 * `{gran, granRequested, granDowngraded, truncated, maxBuckets, buckets, rowGran}`。
 *
 * @param {object[]} rows rollup 行
 * @param {{fromMs:number, toMs:number, gran?:string, maxBuckets?:number}} opts
 */
export function seriesFromRows(rows, opts = {}) {
	const fromMs = toNum(opts.fromMs) ?? 0;
	const toMs = toNum(opts.toMs) ?? Date.now();
	const list = Array.isArray(rows) ? rows : [];
	const plan = seriesPlan({ fromMs, toMs, gran: opts.gran, rowGran: opts.rowGran, maxBuckets: opts.maxBuckets });
	const starts = plan.starts;
	const out = [];
	if (!starts.length) {
		attachMeta(out, plan);
		return out;
	}
	const buckets = new Map();
	for (let i = 0; i < starts.length; i++) buckets.set(starts[i], createAccum());
	for (let i = 0; i < list.length; i++) {
		const raw = list[i];
		if (!raw) continue;
		const row = normalizeIfNeeded(raw);
		const rowStart = typeof row.bucket === "string" ? dayKeyToMs(row.bucket) : toNum0(row.bucket);
		const rowEnd = nextBucketStart(rowStart, rowGranOf(row));
		if (rowEnd <= fromMs || rowStart >= toMs) continue;
		const acc = buckets.get(clampBucket(bucketStartOf(rowStart, plan.gran), plan));
		if (acc) accumulateRow(acc, row);
	}
	for (let i = 0; i < starts.length; i++) out.push(seriesPointFromAccum(buckets.get(starts[i]), starts[i]));
	attachMeta(out, plan);
	return out;
}

/**
 * 序列桶计划：决定**有效粒度**（请求比行细 → 降级）、桶枚举（超 `maxBuckets` → 升粒度），
 * 以及首/末桶（跨界行夹到它们身上，绝不新建窗口外的桶）。
 * `seriesFromRows` 与 `rollup.aggregate` 共用这一份，保证两条路径口径一致。
 * @returns {{starts:number[], gran:string, granRequested:string, granDowngraded:boolean,
 *            truncated:boolean, maxBuckets:number, rowGran:string}}
 */
export function seriesPlan(opts = {}) {
	const fromMs = toNum(opts.fromMs) ?? 0;
	const toMs = toNum(opts.toMs) ?? Date.now();
	const requested = normalizeGran(opts.gran, { fromMs, toMs });
	const maxBuckets = Math.max(1, Math.trunc(toNum(opts.maxBuckets) ?? 720));
	const rowGran = opts.rowGran ? normalizeGranNoAuto(opts.rowGran) : "1h";
	const effective = coarserGran(requested, rowGran);
	const granDowngraded = granRank(effective) > granRank(requested);
	let gran = effective;
	let enumd = enumerateBuckets(gran, fromMs, toMs, maxBuckets);
	let truncated = false;
	while (enumd.capped) {
		const next = nextCoarserGran(gran);
		if (!next) {
			truncated = true;
			break;
		}
		gran = next;
		enumd = enumerateBuckets(gran, fromMs, toMs, maxBuckets);
	}
	return {
		starts: enumd.starts,
		gran,
		granRequested: requested,
		granDowngraded,
		truncated,
		maxBuckets,
		rowGran: normalizeGranNoAuto(rowGran),
	};
}

/** 把桶起点夹进计划的首/末桶（跨界行并进边界桶）。 */
export function clampBucket(t, plan) {
	if (!plan.starts.length) return t;
	if (t < plan.starts[0]) return plan.starts[0];
	const last = plan.starts[plan.starts.length - 1];
	return t > last ? last : t;
}

/** 一个桶累加器 → 序列点。 */
export function seriesPointFromAccum(acc, t) {
	return {
		t,
		calls: acc.calls,
		ok: acc.ok,
		error: acc.client + acc.rate + acc.provider,
		incomplete: acc.incomplete,
		aborted: acc.aborted,
		cost: round(acc.costSdk + acc.costEst, 6),
		ttftP50: quantile(acc.ttft, 0.5),
		ttftP90: quantile(acc.ttft, 0.9),
		ttftSamples: histTotal(acc.ttft),
		e2eP50: quantile(acc.e2e, 0.5),
		outTok: acc.outTok,
	};
}

/** 按计划枚举好的桶建「空累加器表」（rollup.aggregate 单趟聚合用）。 */
export function emptyBucketAccums(plan) {
	const map = new Map();
	for (let i = 0; i < plan.starts.length; i++) map.set(plan.starts[i], createAccum());
	return map;
}

function attachMeta(arr, meta) {
	const info = {
		gran: meta.gran,
		granRequested: meta.granRequested,
		granDowngraded: meta.granDowngraded === true,
		truncated: meta.truncated === true,
		maxBuckets: meta.maxBuckets,
		buckets: arr.length,
		rowGran: meta.rowGran,
	};
	Object.defineProperty(arr, "meta", { value: info, enumerable: false, configurable: true, writable: true });
	for (const key of ["gran", "granRequested", "granDowngraded", "truncated"]) {
		Object.defineProperty(arr, key, { value: info[key], enumerable: false, configurable: true, writable: true });
	}
	return arr;
}

/** 枚举 [fromMs, toMs] 覆盖的桶起点（`capped` = 还有更多桶但被 `limit` 截住）。 */
function enumerateBuckets(gran, fromMs, toMs, limit) {
	const starts = [];
	let t = bucketStartOf(fromMs, gran);
	let capped = false;
	while (t <= toMs) {
		if (starts.length >= limit) {
			capped = true;
			break;
		}
		starts.push(t);
		t = nextBucketStart(t, gran);
	}
	return { starts, capped };
}

/** 行已归一（有 Uint32Array 直方图）就不再拷一遍。 */
function normalizeIfNeeded(row) {
	const hist = row.ttftHist;
	if (ArrayBuffer.isView(hist) && hist.BYTES_PER_ELEMENT === 4 && row.e2eHist) return row;
	return normalizeRollupRow(row);
}

/** 一个维度的累加器 → Top-N 的一行。 */
export function topItemFromAccum(name, acc, totalCalls) {
	const cost = acc.costSdk + acc.costEst;
	const errors = acc.client + acc.rate + acc.provider;
	return {
		name,
		calls: acc.calls,
		share: totalCalls > 0 ? round(acc.calls / totalCalls, 4) : null,
		cost: round(cost, 6),
		tokPerSec: acc.genSum > 0 ? round(acc.outTokTput / (acc.genSum / 1000), 2) : null,
		ttftP50: quantile(acc.ttft, 0.5),
		errorRate: acc.calls > 0 ? round(errors / acc.calls, 4) : null,
		tokens: { input: acc.inTok, output: acc.outTok, cacheRead: acc.cacheRead },
		unpricedCalls: acc.unpriced,
	};
}

/** Top-N 排序（确定性：calls 降序 → 成本降序 → 名称升序）。 */
export function sortTopRows(items, limit = 8) {
	const out = items.slice();
	out.sort((a, b) => b.calls - a.calls || b.cost - a.cost || a.name.localeCompare(b.name));
	return out.slice(0, Math.max(1, Math.trunc(limit)));
}

/**
 * Top-N（按模型或项目）。
 * @param {{key?:'model'|'project', limit?:number}} opts
 */
export function topFromRows(rows, opts = {}) {
	const key = opts.key === "project" ? "project" : "model";
	const limit = Math.max(1, Math.trunc(toNum(opts.limit) ?? 8));
	const list = Array.isArray(rows) ? rows : [];
	const groups = new Map();
	for (let i = 0; i < list.length; i++) {
		const row = list[i];
		if (!row) continue;
		const name = (key === "project" ? row.project : row.model) ?? "";
		const label = String(name).trim() || "(unknown)";
		let acc = groups.get(label);
		if (!acc) {
			acc = createAccum();
			groups.set(label, acc);
		}
		accumulateRow(acc, row);
	}
	let totalCalls = 0;
	for (const acc of groups.values()) totalCalls += acc.calls;
	const items = [];
	for (const [name, acc] of groups) items.push(topItemFromAccum(name, acc, totalCalls));
	return sortTopRows(items, limit);
}

/** 可用筛选项（窗口内出现过的名字）。 */
export function filterOptionsFromRows(rows) {
	const models = new Set();
	const providers = new Set();
	const projects = new Set();
	const list = Array.isArray(rows) ? rows : [];
	for (let i = 0; i < list.length; i++) {
		const row = list[i];
		if (!row) continue;
		if (row.model) models.add(row.model);
		if (row.provider) providers.add(row.provider);
		if (row.project) projects.add(row.project);
	}
	const sortNames = (set) => {
		const arr = [];
		for (const v of set) arr.push(v);
		arr.sort((a, b) => a.localeCompare(b));
		return arr;
	};
	return {
		models: sortNames(models),
		providers: sortNames(providers),
		projects: sortNames(projects),
		statuses: STATUSES.slice(),
	};
}

/** 过滤条件归一：字符串或数组 → 去空数组；空 → null（不启用该维度）。 */
export function normalizeFilter(value) {
	if (value === null || value === undefined) return null;
	const list = Array.isArray(value) ? value : String(value).split(",");
	const out = [];
	for (let i = 0; i < list.length; i++) {
		// 每个元素再拆一次逗号（`["a,b"]` 与 `"a,b"` 等价）
		for (const piece of String(list[i] ?? "").split(",")) {
			const v = piece.trim();
			if (!v || v === "all") continue;
			if (!out.includes(v)) out.push(v);
		}
	}
	return out.length ? out : null;
}

/** rollup 行是否命中筛选（names 维度 + status）。 */
export function rowMatches(row, filters = {}) {
	if (!filters || typeof filters !== 'object') return true;
	// 空数组 = 该维度不过滤（避免有人直接传 `[]` 时把结果全滤空）
	const models = filters.models && filters.models.length ? filters.models : null;
	if (models && !models.includes(row.model ?? "")) return false;
	const providers = filters.providers && filters.providers.length ? filters.providers : null;
	if (providers && !providers.includes(row.provider ?? "")) return false;
	const projects = filters.projects && filters.projects.length ? filters.projects : null;
	if (projects && !projects.includes(row.project ?? "")) return false;
	const statuses = filters.statuses && filters.statuses.length ? filters.statuses : null;
	if (statuses && !statuses.includes(row.status)) return false;
	return true;
}

export default {
	STATUSES,
	statusClass,
	summarizeRows,
	seriesFromRows,
	topFromRows,
	costBuckets,
	cacheStats,
	throughput,
	normalizeRollupRow,
	rollupKeyOf,
	filterOptionsFromRows,
	normalizeFilter,
	rowMatches,
	normalizeGran,
	autoGran,
	bucketStartOf,
	nextBucketStart,
	hourStart,
	sixHourStart,
	dayStart,
	dayKeyOf,
	dayKeyToMs,
	hourKeyOf,
};
