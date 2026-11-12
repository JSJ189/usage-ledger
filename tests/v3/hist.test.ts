/**
 * v3 直方图（`lib/v3/hist.mjs`）：分位近似的地基。
 *
 * 锁住的四件事（都是「错了会静默给出错数字」的那类）：
 *  1. 两个可断言端点：`binOf(1) === 0`、`binOf(4h) === BINS-1`；
 *  2. 编解码往返无损（落盘是 uint16×136，不是内存里的 uint32）；
 *  3. 分位误差上界：2 万条真实分布样本，p50/p90/p99 相对误差 < 5%（合同 §2.10）；
 *  4. 合并语义：逐桶相加，`histAdd` 丢弃非正样本（「没测到」不能算 0ms）。
 */
import { describe, expect, it } from "vitest";
import {
	BINS,
	BIN_RATIO,
	HIST_BYTES,
	MAX_MS,
	MIN_MS,
	binOf,
	binValue,
	decodeHist,
	emptyHist,
	encodeHist,
	histAdd,
	histTotal,
	mergeHistInto,
	quantile,
} from "../../lib/v3/hist.mjs";

const HOUR_MS = 3_600_000;

describe("hist：桶空间端点", () => {
	it("binOf(1) === 0、binOf(4h) === BINS-1（合同 §4.2 的可断言端点）", () => {
		expect(binOf(MIN_MS)).toBe(0);
		expect(binOf(4 * HOUR_MS)).toBe(BINS - 1);
		expect(BINS).toBe(136);
		expect(HIST_BYTES).toBe(272);
	});

	it("越界与脏输入都夹到端点，绝不返回越界桶号", () => {
		expect(binOf(0)).toBe(0);
		expect(binOf(-5)).toBe(0);
		expect(binOf(Number.NaN)).toBe(0);
		expect(binOf(undefined)).toBe(0);
		expect(binOf(MAX_MS + 1)).toBe(BINS - 1);
		expect(binOf(1e12)).toBe(BINS - 1);
		for (const ms of [1, 2, 7, 1000, 60_000, HOUR_MS, MAX_MS]) {
			const bin = binOf(ms);
			expect(bin).toBeGreaterThanOrEqual(0);
			expect(bin).toBeLessThan(BINS);
			// 桶必须包含这个值：[binValue(bin), binValue(bin)+1)。末桶是开区间
			// （顶到 MAX_MS 的值全归 bin 135），所以只对非末桶断言上界。
			expect(binValue(bin)).toBeLessThanOrEqual(ms);
			if (bin < BINS - 1) expect(binValue(bin + 1)).toBeGreaterThan(ms);
			else expect(binValue(bin)).toBeLessThanOrEqual(MAX_MS);
		}
	});

	it("相邻桶比值 = BIN_RATIO（1.1288），单调递增", () => {
		expect(binValue(1) / binValue(0)).toBeCloseTo(BIN_RATIO, 6);
		expect(binValue(BINS - 1) / binValue(BINS - 2)).toBeCloseTo(BIN_RATIO, 6);
		expect(binValue(BINS - 1)).toBeLessThanOrEqual(MAX_MS);
	});
});

describe("hist：编解码往返", () => {
	it("uint16×136 往返逐桶相等，字节数固定 272", () => {
		const hist = emptyHist();
		hist[0] = 3;
		hist[1] = 1;
		hist[77] = 12_345;
		hist[BINS - 1] = 65_535;
		const buf = encodeHist(hist);
		expect(buf.length).toBe(HIST_BYTES);
		// 小端 uint16：[1] = 0x3039
		expect(buf.readUInt16LE(77 * 2)).toBe(12_345);
		const back = decodeHist(buf);
		expect(back.length).toBe(BINS);
		expect(Array.from(back)).toEqual(Array.from(hist));
		expect(histTotal(back)).toBe(3 + 1 + 12_345 + 65_535);
	});

	it("非 2 字节对齐的 Buffer 走逐字节分支，结果与对齐路径一致", () => {
		const hist = emptyHist();
		hist[5] = 7;
		hist[100] = 9;
		const padded = Buffer.concat([Buffer.from([0xff]), encodeHist(hist)]);
		const misaligned = padded.subarray(1);
		expect(misaligned.byteOffset % 2).toBe(1);
		expect(Array.from(decodeHist(misaligned))).toEqual(Array.from(hist));
	});

	it("长度不足 / 空值解码成全 0，绝不抛错", () => {
		expect(histTotal(decodeHist(null))).toBe(0);
		expect(histTotal(decodeHist(Buffer.alloc(10)))).toBe(0);
		expect(histTotal(emptyHist())).toBe(0);
	});
});

describe("hist：分位误差（2 万样本，< 5%）", () => {
	it("p50 / p90 / p99 与精确值相对误差都小于 5%", () => {
		// 真实形状：500ms 起步、每 3ms 一档、走完 500 档再回环（覆盖 500–1997ms）
		const samples: number[] = [];
		const hist = emptyHist();
		for (let i = 0; i < 20_000; i++) {
			const ms = 500 + (i % 500) * 3;
			samples.push(ms);
			histAdd(hist, ms);
		}
		samples.sort((a, b) => a - b);
		const exact = (p: number) => samples[Math.min(samples.length - 1, Math.max(0, Math.ceil(p * samples.length) - 1))];
		const rel = (approx: number | null, precise: number) => Math.abs((approx as number) - precise) / precise;

		expect(histTotal(hist)).toBe(20_000);
		for (const p of [0.5, 0.9, 0.99]) {
			const approx = quantile(hist, p);
			expect(approx).not.toBeNull();
			expect(rel(approx, exact(p))).toBeLessThan(0.05);
		}
		// 单调性：p50 <= p90 <= p99
		expect(quantile(hist, 0.5)!).toBeLessThanOrEqual(quantile(hist, 0.9)!);
		expect(quantile(hist, 0.9)!).toBeLessThanOrEqual(quantile(hist, 0.99)!);
	});

	it("空直方图 → null；单点直方图的分位落在样本所在的那个桶里", () => {
		expect(quantile(emptyHist(), 0.5)).toBeNull();
		expect(quantile(null, 0.5)).toBeNull();
		const one = emptyHist();
		histAdd(one, 1500);
		const bin = binOf(1500);
		for (const p of [0.5, 0.9, 0.99]) {
			const q = quantile(one, p)!;
			// 桶内插值不会跑到别的桶：这是「合并后再求分位」不越界的前提
			expect(binOf(q)).toBe(bin);
			expect(q).toBeGreaterThan(0);
		}
	});
});

describe("hist：合并与丢弃", () => {
	it("mergeHistInto 逐桶相加；histAdd 丢弃 0 / 负数 / NaN", () => {
		const target = emptyHist();
		const src = emptyHist();
		histAdd(target, 1000);
		histAdd(src, 1000);
		histAdd(src, 1000);
		mergeHistInto(target, src);
		expect(target[binOf(1000)]).toBe(3);

		const before = histTotal(target);
		histAdd(target, 0);
		histAdd(target, -1);
		histAdd(target, Number.NaN);
		histAdd(target, null);
		expect(histTotal(target)).toBe(before);
	});
});
