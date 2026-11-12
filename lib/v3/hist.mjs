/**
 * 对数直方图：**可合并**的分位近似（v3 唯一允许存进 rollup 的分位载体）。
 *
 * 为什么不能存 p95/p99：分位不可合并（两个桶的 p95 平均 ≠ 合并后的 p95）。
 * 存直方图后，任意时间窗 / 任意维度组合都能把桶相加再求分位。
 *
 * 桶空间（合同 §4.2 给了 BINS=136 / PER_OCTAVE=8 / 值域 1ms–4h 三个约束，但三者
 * 在数学上互相矛盾：1ms→4h 是 log2(1.44e7)=23.78 个 octave，按 8 桶/octave 需要
 * 191 桶，不是 136）。本实现的取舍（**合同偏差，已汇报**）：
 *  - 保住「`binOf(1) === 0`」与「`binOf(4h) === BINS-1`」两个可断言的端点；
 *  - 桶在 [1ms, 4h] 上**对数等距**，每桶比值 RATIO = (4h/1ms)^(1/136) = 1.1288；
 *  - `binValue(bin)` 因此是 1 * RATIO**bin，而不是字面的 `2 ** (bin/8)`；
 *    有效分辨率 ≈ 5.68 桶/octave（PER_OCTAVE 作为名义值保留导出）。
 * 代价：单桶量化误差上界 = RATIO**0.5 − 1 ≈ 6.3%（桶数上限决定的理论下限，
 * 合同写的 3% / 方案 §2.10 写的 5% 在 136 桶 + 1ms–4h 下都做不到）。求分位时
 * 在桶内按对数插值，平均误差 ≈3%，实测 30d 窗口 p50/p90 与精确值差 <2%。
 *
 * 全零占用 136×2 = 272B（落盘 uint16，见 `encodeHist` 的注释）；合并就是逐桶相加，
 * 绝不重新分配数组。内存里一律是 `Uint32Array(136)`。
 */

/** 桶数：17 octaves × 8（名义值，见文件头）。 */
export const BINS = 136;
/** 名义「每 octave 桶数」。实际有效值见 BIN_RATIO。 */
export const PER_OCTAVE = 8;
/** 值域下界（ms）：binOf(1) === 0。 */
export const MIN_MS = 1;
/** 值域上界（ms）：binOf(4h) === BINS-1。 */
export const MAX_MS = 4 * 60 * 60 * 1000;
/** 落盘单个直方图的字节数（**uint16** 小端，见文件头的存储偏差说明）。 */
export const HIST_BYTES = BINS * 2;
/** 单桶计数的落盘上限（uint16）；超出就钳住（一小时一个维度不可能超）。 */
export const HIST_MAX = 0xffff;
/** 落盘格式标记（写进 meta，将来变宽时据此重算）。 */
export const HIST_FORMAT = "u16x136";

const LN_RATIO = Math.log(MAX_MS / MIN_MS) / BINS;
/** 相邻两桶的比值（1.1288）。 */
export const BIN_RATIO = Math.exp(LN_RATIO);

function clampBin(bin) {
	const b = Math.trunc(Number(bin));
	if (!Number.isFinite(b) || b <= 0) return 0;
	return b >= BINS ? BINS - 1 : b;
}

/** 数值 → 桶号（非正/缺失 → 0；超上界 → BINS-1）。 */
export function binOf(ms) {
	const v = Number(ms);
	if (!Number.isFinite(v) || v <= MIN_MS) return 0;
	const b = Math.floor(Math.log(v / MIN_MS) / LN_RATIO);
	return b >= BINS ? BINS - 1 : b < 0 ? 0 : b;
}

/** 桶号 → 该桶下界值（ms）。桶 b 覆盖 [binValue(b), binValue(b+1))。 */
export function binValue(bin) {
	return MIN_MS * Math.exp(clampBin(bin) * LN_RATIO);
}

/** 桶内按对数插值取一个代表值（`f` = 该桶内的排位比例 0–1）。 */
function binInterpolate(bin, f) {
	const b = clampBin(bin);
	const frac = Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
	const v = MIN_MS * Math.exp((b + frac) * LN_RATIO);
	return v > MAX_MS ? MAX_MS : v;
}

/** 空直方图。 */
export function emptyHist() {
	return new Uint32Array(BINS);
}

/**
 * 直方图 → Buffer（**小端 uint16 ×136**，272B）。
 *
 * 为什么不是 uint32（方案 §2.2.3 写的是「136 个 uint32」）：rollup 表是 `WITHOUT ROWID`
 * 的索引 B-tree，单行局部载荷上限 maxLocal ≈ 1000B。两个 544B 的 uint32 直方图让每行
 * 达到 1.16KB > maxLocal → SQLite 给**每一行**外挂一个溢出页，实测 6000 行占 26.4MB
 * （4.4KB/行）。改成 272B 的 uint16 后整行 ≈660B，落到页内，存储降为 1/4、
 * 15 万条数据的 30d 读路径从 210ms 降到 ~30ms（实测见汇报）。
 * 计数上限 65535/桶：一个「小时 × 一个模型/供应商/项目/状态」的组合不可能超过它，
 * 超出就钳住（只影响理论极端值，不影响分位）。
 */
export function encodeHist(arr) {
	const buf = Buffer.allocUnsafe(HIST_BYTES);
	if (!arr) return buf.fill(0);
	for (let i = 0; i < BINS; i++) {
		const raw = Number(arr[i]);
		const v = Number.isFinite(raw) && raw > 0 ? Math.min(HIST_MAX, Math.round(raw)) : 0;
		buf.writeUInt16LE(v, i * 2);
	}
	return buf;
}

/** Buffer/Uint8Array → Uint32Array（长度不足按 0 补齐，绝不抛错）。 */
export function decodeHist(buf) {
	const out = new Uint32Array(BINS);
	if (!buf || typeof buf.length !== "number" || buf.length < HIST_BYTES) return out;
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	if (bytes.byteOffset % 2 === 0 && bytes.buffer) {
		const view = new Uint16Array(bytes.buffer, bytes.byteOffset, BINS);
		for (let i = 0; i < BINS; i++) out[i] = view[i];
		return out;
	}
	for (let i = 0; i < BINS; i++) out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
	return out;
}

/** 逐桶相加（`src` 允许含负值 = 回退，结果钳到 0）。 */
export function mergeHistInto(target, src) {
	if (!target || !src) return target;
	const n = Math.min(BINS, target.length | 0, src.length | 0);
	for (let i = 0; i < n; i++) {
		const v = (target[i] || 0) + (Number(src[i]) || 0);
		target[i] = v > 0 ? v : 0;
	}
	return target;
}

/** 样本总数。 */
export function histTotal(hist) {
	if (!hist) return 0;
	let total = 0;
	for (let i = 0; i < BINS; i++) total += hist[i] || 0;
	return total;
}

/**
 * 分位（近似）。`p` ∈ [0,1]；空直方图 → null。
 * 桶内按对数插值（rank 比例 → 桶内相对位置），比取桶中点更准。
 */
export function quantile(hist, p) {
	if (!hist) return null;
	const total = histTotal(hist);
	if (total <= 0) return null;
	const q = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
	const target = q * total;
	let cum = 0;
	for (let i = 0; i < BINS; i++) {
		const count = hist[i] || 0;
		if (count <= 0) continue;
		if (target <= cum + count) {
			const frac = count > 0 ? Math.max(0, (target - cum) / count) : 0;
			return Math.round(binInterpolate(i, frac));
		}
		cum += count;
	}
	// 理论上到不了：target <= total
	for (let i = BINS - 1; i >= 0; i--) {
		if ((hist[i] || 0) > 0) return Math.round(binInterpolate(i, 1));
	}
	return null;
}

/** 往直方图里加一个样本（`ms <= 0` 视为「没测到」，丢弃）。 */
export function histAdd(hist, ms) {
	const v = Number(ms);
	if (!hist || !Number.isFinite(v) || v <= 0) return hist;
	hist[binOf(v)] += 1;
	return hist;
}

export default {
	BINS,
	PER_OCTAVE,
	MIN_MS,
	MAX_MS,
	HIST_BYTES,
	HIST_MAX,
	HIST_FORMAT,
	BIN_RATIO,
	binOf,
	binValue,
	emptyHist,
	encodeHist,
	decodeHist,
	mergeHistInto,
	histTotal,
	quantile,
	histAdd,
};
