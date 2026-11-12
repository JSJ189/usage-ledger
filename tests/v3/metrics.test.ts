/**
 * v3 口径函数（`lib/v3/metrics.mjs`）：KPI 的分母、加权、窗口与序列不变量。
 *
 * 每个用例都断言**具体数值**，并且断言「错口径会给出的那个数」不出现
 * （例如成功率若把 aborted/incomplete 算进分母，7/9 会变成 7/12）——
 * v2 的教训是「只断言请求发了」= 等于没测。
 */
import { describe, expect, it } from "vitest";
import { seriesFromRows, statusClass, summarizeRows } from "../../lib/v3/metrics.mjs";
import { HOUR, T0, rollupRow, sumCalls } from "./support/rows";

/** 六态各几条：ok 7 / client 1 / rate 1 / aborted 2 / incomplete 1。 */
function mixedRows() {
	const hour0 = T0;
	const hour1 = T0 + HOUR;
	const hour2 = T0 + 2 * HOUR;
	return [
		rollupRow({ bucket: hour0, status: "ok", calls: 3 }),
		rollupRow({ bucket: hour0, status: "aborted", calls: 2 }),
		rollupRow({ bucket: hour0, status: "incomplete", calls: 1 }),
		rollupRow({ bucket: hour1, status: "ok", calls: 4 }),
		rollupRow({ bucket: hour1, status: "client_error", calls: 1 }),
		rollupRow({ bucket: hour2, status: "rate_limited", calls: 1 }),
	];
}

describe("metrics：成功率分母排除 aborted / incomplete", () => {
	it("12 次调用：answered=9，successRate=7/9，不是 7/12", () => {
		const rows = mixedRows();
		const kpi = summarizeRows(rows);
		expect(kpi.calls).toBe(12);
		expect(kpi.ok).toBe(7);
		expect(kpi.error).toBe(2); // client 1 + rate 1
		expect(kpi.aborted).toBe(2);
		expect(kpi.incomplete).toBe(1);
		expect(kpi.answered).toBe(9);
		expect(kpi.successRate).toBe(0.7778);
		// 六态必须能还原总调用数（漏一态 = 分母悄悄变了）
		expect(kpi.ok + kpi.error + kpi.aborted + kpi.incomplete).toBe(kpi.calls);
		// 错口径（分母含 aborted/incomplete）会得到这个数，必须对不上
		expect(kpi.successRate).not.toBe(0.5833);
	});

	it("同一个窗口把 aborted 改成 ok，成功率上升（输入变 → 输出必须变）", () => {
		const rows = mixedRows();
		const before = summarizeRows(rows).successRate;
		const fixed = rows.map((row) => (row.status === "aborted" ? { ...row, status: "ok" } : row));
		const after = summarizeRows(fixed).successRate;
		expect(after).toBeCloseTo(9 / 11, 4); // ok 9 / answered 11
		expect(after).toBeGreaterThan(before as number);
	});

	it("没有应答（全是 aborted）时 successRate 是 null，不是 0", () => {
		const kpi = summarizeRows([rollupRow({ bucket: T0, status: "aborted", calls: 4 })]);
		expect(kpi.answered).toBe(0);
		expect(kpi.successRate).toBeNull();
		expect(kpi.calls).toBe(4);
	});

	it("statusClass 归一：未知/空 → incomplete（没有结论的调用不能算成功）", () => {
		expect(statusClass("ok")).toBe("ok");
		expect(statusClass("success")).toBe("ok");
		expect(statusClass("429")).toBe("rate_limited");
		expect(statusClass("timeout")).toBe("provider_error");
		expect(statusClass("cancelled")).toBe("aborted");
		expect(statusClass("")).toBe("incomplete");
		expect(statusClass(null)).toBe("incomplete");
		expect(statusClass("weird-status")).toBe("incomplete");
	});
});

describe("metrics：cacheHitRate 加权 + 样本数只算有缓存采集的调用", () => {
	it("Σ cacheRead / Σ promptTok = 50/1100，不是各次命中率的算术平均 0.25", () => {
		const rows = [
			rollupRow({ bucket: T0, inTok: 50, cacheRead: 50, cacheN: 1 }),
			rollupRow({ bucket: T0, inTok: 1000, cacheRead: 0, cacheN: 0 }),
		];
		const kpi = summarizeRows(rows);
		expect(kpi.cacheHitRate).toBe(0.0455);
		expect(kpi.cacheHitRate).not.toBe(0.25);
		expect(kpi.cacheHitSamples).toBe(1); // 第二行没有缓存字段 → 不进样本数
		expect(kpi.tokens.input).toBe(1050);
		expect(kpi.tokens.cacheRead).toBe(50);
	});

	it("完全没有缓存采集 → 命中率 null（不是 0）", () => {
		const kpi = summarizeRows([rollupRow({ bucket: T0, inTok: 100, cacheRead: 0, cacheN: 0 })]);
		expect(kpi.cacheHitRate).toBe(0);
		expect(kpi.cacheHitSamples).toBe(0);
	});
});

describe("metrics：tokPerSec 加权（总输出 / 总生成秒）", () => {
	it("100 tok / 11 s = 9.09，不是两次速率的算术平均 27.5", () => {
		const rows = [
			rollupRow({ bucket: T0, calls: 1, genMs: 1000, e2eMs: 1800 }),
			rollupRow({ bucket: T0, calls: 1, genMs: 10_000, e2eMs: 11_000 }),
		];
		const kpi = summarizeRows(rows);
		expect(kpi.tokPerSec).toBe(9.09);
		expect(kpi.tokPerSec).not.toBe(27.5);
		// rateSum/rateN 给「单次调用平均多快」，与加权值是两个数
		expect(kpi.tokPerSecMean).toBe(27.5);
		expect(kpi.tokPerSecMeanExact).toBe(true);
		expect(kpi.tokPerSecSamples).toBe(2);
	});
});

describe("metrics：seriesFromRows 窗口、补 0 与 Σ 不变量", () => {
	it("窗口外的行不计入，Σ series.calls === kpi.calls", () => {
		const rows = [
			...mixedRows(),
			rollupRow({ bucket: T0 - 3 * HOUR, status: "ok", calls: 100 }),
		];
		const fromMs = T0;
		const toMs = T0 + 3 * HOUR - 1;
		const series = seriesFromRows(rows, { fromMs, toMs, gran: "1h" });
		const kpi = summarizeRows(rows, { fromMs, toMs });

		expect(kpi.calls).toBe(12); // 那 100 次在窗口外
		expect(series.length).toBe(3);
		expect(series.map((point) => point.calls)).toEqual([6, 5, 1]);
		expect(series[0].ok).toBe(3);
		expect(series[0].aborted).toBe(2);
		expect(series[1].ok).toBe(4);
		expect(series[1].error).toBe(1);
		expect(sumCalls(series)).toBe(kpi.calls);
	});

	it("没有数据的小时补 0 桶（不是跳过空洞）", () => {
		const rows = [
			rollupRow({ bucket: T0, status: "ok", calls: 2 }),
			rollupRow({ bucket: T0 + 2 * HOUR, status: "ok", calls: 3 }),
		];
		const series = seriesFromRows(rows, { fromMs: T0, toMs: T0 + 3 * HOUR - 1, gran: "1h" });
		expect(series.map((point) => point.calls)).toEqual([2, 0, 3]);
		expect(sumCalls(series)).toBe(5);
	});

	it("每个窗口/粒度组合都维持 Σ series.calls === kpi.calls", () => {
		const rows = mixedRows();
		const cases: Array<{ fromMs: number; toMs: number; gran: string }> = [
			{ fromMs: T0, toMs: T0 + 3 * HOUR - 1, gran: "1h" },
			{ fromMs: T0, toMs: T0 + 1 * HOUR - 1, gran: "1h" },
			{ fromMs: T0 - 6 * HOUR, toMs: T0 + 6 * HOUR, gran: "1h" },
			{ fromMs: T0 - 6 * HOUR, toMs: T0 + 6 * HOUR, gran: "1d" },
			{ fromMs: T0, toMs: T0 + 3 * HOUR - 1, gran: "5m" },
		];
		for (const opts of cases) {
			const series = seriesFromRows(rows, opts);
			const kpi = summarizeRows(rows, opts);
			expect(sumCalls(series), JSON.stringify(opts)).toBe(kpi.calls);
		}
	});

	it("请求 5m 但只有小时行 → 降级到 1h 并标记 granDowngraded", () => {
		const series = seriesFromRows(mixedRows(), { fromMs: T0, toMs: T0 + 3 * HOUR - 1, gran: "5m" });
		expect(series.meta.gran).toBe("1h");
		expect(series.meta.granRequested).toBe("5m");
		expect(series.meta.granDowngraded).toBe(true);
		expect(series.length).toBe(3);
	});
});

describe("metrics：720 桶上限自动升粒度，且不丢数据", () => {
	/** 30 天，每小时一条 calls=1 的行（共 720 行）。 */
	const rows30d = Array.from({ length: 720 }, (_, i) =>
		rollupRow({ bucket: T0 - i * HOUR, status: "ok", calls: 1 }),
	);
	const fromMs = T0 - 30 * 24 * HOUR;
	// 窗口上界取「最后一个小时之前」：`rowInWindow` 是 [from, to) 语义，
	// 若 toMs = T0，恰好落在 T0 的那一行不算进窗口（这一点本身有用例锁定）。
	const toMs = T0 + HOUR - 1;

	it("1h 请求超限 → 升到 6h，桶数 121，总数仍是 720", () => {
		const series = seriesFromRows(rows30d, { fromMs, toMs, gran: "1h", maxBuckets: 720 });
		expect(series.meta.gran).toBe("6h");
		expect(series.meta.truncated).toBe(false);
		expect(series.length).toBe(121);
		expect(sumCalls(series)).toBe(720);
		expect(summarizeRows(rows30d, { fromMs, toMs }).calls).toBe(720);
		// 每个 6h 桶最多装 6 条小时行 → 证明是「合并」而不是「截断」
		for (const point of series) expect(point.calls).toBeLessThanOrEqual(6);
	});

	it("上限压到 40 → 一路升到 1d：31 桶、truncated=false、总数依然 720", () => {
		const series = seriesFromRows(rows30d, { fromMs, toMs, gran: "1h", maxBuckets: 40 });
		expect(series.meta.gran).toBe("1d");
		expect(series.meta.truncated).toBe(false);
		expect(series.length).toBe(31);
		expect(sumCalls(series)).toBe(720);
	});

	it("1d 仍超限 → truncated=true，但多出的天并进末桶，一次调用都不丢", () => {
		const series = seriesFromRows(rows30d, { fromMs, toMs, gran: "1h", maxBuckets: 24 });
		expect(series.meta.gran).toBe("1d");
		expect(series.meta.truncated).toBe(true);
		expect(series.length).toBe(24);
		expect(sumCalls(series)).toBe(720);
		expect(series[series.length - 1].calls).toBeGreaterThan(24);
	});
});

describe("metrics：分位来自直方图合并", () => {
	it("两行 p50 不同，合并后的 p50 落在两者之间且样本数是两行之和", () => {
		const rows = [
			rollupRow({ bucket: T0, calls: 5, ttftMs: 400, e2eMs: 1000 }),
			rollupRow({ bucket: T0, calls: 5, ttftMs: 4000, e2eMs: 5000 }),
		];
		const merged = summarizeRows(rows);
		expect(merged.ttft.samples).toBe(10);
		expect(merged.ttft.p50).toBeGreaterThan(400);
		expect(merged.ttft.p90).toBeGreaterThan(4000);
		expect(merged.ttft.approx).toBe(true);
		expect(merged.ttft.coverage).toBe(1);
	});
});
