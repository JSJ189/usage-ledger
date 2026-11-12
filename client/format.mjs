/**
 * 用量账本 v3 · 格式化（纯函数，无 DOM、无副作用）
 *
 * 口径约定（与 docs/V3-CONTRACT.md §三 一致）：
 *  - 时间：服务端一律 UTC 毫秒；**展示一律用浏览器本地时区**，本文件不出现任何 toISOString，
 *    避免「表格本地 / 导出 UTC」的历史混用；
 *  - 缺值统一 `--`，绝不把 null 渲染成 0 或 $0；
 *  - 分位是直方图近似，调用方负责在文案里标 `≈`。
 */

const DASH = "--";

/** 数字化；非有限值一律 null（不是 0）。 */
export function numOrNull(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** 紧凑整数：1.2k / 3.40M。 */
export function fmtInt(v) {
	const n = numOrNull(v);
	if (n === null) return DASH;
	const a = Math.abs(n);
	if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
	if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

/** 带千分位的整数（真值行「16,673 次」用，紧凑写法会丢掉精度）。 */
export function fmtCount(v) {
	const n = numOrNull(v);
	if (n === null) return DASH;
	return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 毫秒时长：733ms / 6.33s / 2m04s / 1h02m。0 视为「没有样本」→ `--`。 */
export function fmtMs(v) {
	const n = numOrNull(v);
	if (n === null || n <= 0) return DASH;
	if (n < 1000) return `${Math.round(n)}ms`;
	if (n < 10_000) return `${(n / 1000).toFixed(2)}s`;
	if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
	if (n < 3_600_000) return `${Math.floor(n / 60_000)}m${String(Math.round((n % 60_000) / 1000)).padStart(2, "0")}s`;
	return `${Math.floor(n / 3_600_000)}h${String(Math.round((n % 3_600_000) / 60_000)).padStart(2, "0")}m`;
}

/** 坐标轴刻度：0 是有效刻度，不能像 fmtMs 那样回落到 `--`。 */
export function fmtAxisMs(v) {
	const n = numOrNull(v);
	if (n === null) return DASH;
	if (n === 0) return "0";
	return fmtMs(n);
}

/** 紧凑计数轴刻度（0 有效）。 */
export function fmtAxisNum(v) {
	const n = numOrNull(v);
	if (n === null) return DASH;
	return n === 0 ? "0" : fmtInt(n);
}

/** 比率：0.9808 → 98.1%。null → `--`。 */
export function fmtRate(v) {
	const n = numOrNull(v);
	if (n === null) return DASH;
	return `${(n * 100).toFixed(1)}%`;
}

/** 占比：小值保留两位（0.40%），其余一位。 */
export function fmtShare(v) {
	const n = numOrNull(v);
	if (n === null) return DASH;
	return `${(n * 100).toFixed(n > 0 && n < 0.01 ? 2 : 1)}%`;
}

/** 吞吐（tok·s⁻¹）。 */
export function fmtTokps(v) {
	const n = numOrNull(v);
	if (n === null || n < 0) return DASH;
	return n.toFixed(n < 10 ? 2 : 0);
}

/**
 * 金额（USD）。
 * @param {number|string|null} amount
 * @param {{estimate?: boolean, lowerBound?: boolean}} [opts] estimate → `≈`；lowerBound → `≥`
 */
export function fmtCost(amount, opts = {}) {
	const n = numOrNull(amount);
	if (n === null) return DASH;
	const body = `$${n.toFixed(n < 1 ? 4 : 2)}`;
	if (opts.lowerBound) return `≥${body}`;
	return opts.estimate ? `≈${body}` : body;
}

/** 预计剩余：`~2m30s`。 */
export function fmtEta(v) {
	const n = numOrNull(v);
	if (n === null || n < 0) return DASH;
	if (n < 1000) return "<1s";
	return `~${fmtMs(n).replace(/^--$/, "?")}`;
}

// ─────────────────────────────────────────── 时间（全部本地时区）

const pad2 = (n) => String(n).padStart(2, "0");

function asDate(ts) {
	const n = numOrNull(ts);
	if (n === null || n <= 0) return null;
	const d = new Date(n);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** HH:MM:SS（本地）。 */
export function fmtTimeLocal(ts) {
	const d = asDate(ts);
	if (!d) return DASH;
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** MM-DD HH:MM:SS（本地，明细表单元格）。 */
export function fmtDateTimeLocal(ts) {
	const d = asDate(ts);
	if (!d) return DASH;
	return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** YYYY-MM-DD HH:MM:SS（本地，tooltip / 详情）。 */
export function fmtFullLocal(ts) {
	const d = asDate(ts);
	if (!d) return DASH;
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** YYYY-MM-DD（本地）。 */
export function fmtDateLocal(ts) {
	const d = asDate(ts);
	if (!d) return DASH;
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 横轴刻度标签：1d 桶只写日期，其余写 HH:MM（跨天时带 MM-DD）。 */
export function fmtBucketTick(ts, gran, prevTs) {
	const d = asDate(ts);
	if (!d) return "";
	const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	const day = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
	if (gran === "1d" || gran === "day") return day;
	const prev = asDate(prevTs);
	const crossDay = prev && (prev.getDate() !== d.getDate() || prev.getMonth() !== d.getMonth());
	return crossDay ? `${day} ${hm}` : hm;
}

/** 桶跨度（毫秒）：用于 tooltip 的「10:00–11:00」。 */
export function granMs(gran) {
	if (gran === "5m") return 5 * 60_000;
	if (gran === "1h" || gran === "hour") return 3_600_000;
	if (gran === "6h") return 6 * 3_600_000;
	if (gran === "1d" || gran === "day") return 24 * 3_600_000;
	return 3_600_000;
}

/** 桶区间文案：`10:00–11:00` / `11-04` / `11-04 10:00–11:00`。 */
export function fmtBucketRange(ts, gran) {
	const d = asDate(ts);
	if (!d) return DASH;
	const span = granMs(gran);
	const end = new Date(ts + span);
	const hm = (x) => `${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
	if (gran === "1d" || gran === "day") return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
	return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm(d)}–${hm(end)}`;
}

/** date input 值（本地日历）。 */
export function toDateInput(ts) {
	const d = asDate(ts);
	return d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : "";
}

/** `YYYY-MM-DD` → 当天本地 00:00 的毫秒（end=true 时取当天 23:59:59.999）。 */
export function fromDateInput(value, end = false) {
	const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return null;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
	const t = d.getTime();
	return Number.isFinite(t) ? t : null;
}
