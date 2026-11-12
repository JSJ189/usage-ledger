/**
 * v3 内存 rollup 索引（`lib/v3/rollup.mjs`）：`overview` 的唯一数据源。
 *
 * 这里锁的是「最贵的那类 bug」——构造时没吃掉 `opts.rows`（线上所有窗口 KPI 恒为 0）、
 * 以及 `aggregate()` 与 `summarizeRows()` 两条路径口径漂移（图表和 KPI 对不上）。
 */
import { describe, expect, it } from "vitest";
import { createRollupIndex } from "../../lib/v3/rollup.mjs";
import { summarizeRows } from "../../lib/v3/metrics.mjs";
import { HOUR, T0, rollupRow, sumCalls } from "./support/rows";

const NOW = T0 + 3 * HOUR;

/** 4 个桶、11 次调用：m1 9 次（ok 8 / aborted 1）、m2 2 次（provider_error）。 */
function seed() {
	return [
		rollupRow({ bucket: T0, status: "ok", calls: 3 }),
		rollupRow({ bucket: T0, status: "aborted", calls: 1 }),
		rollupRow({ bucket: T0 - HOUR, status: "ok", calls: 5 }),
		rollupRow({ bucket: T0 - 2 * HOUR, status: "provider_error", calls: 2, model: "m2", modelId: 2 }),
	];
}

function newIndex(rows: Array<Record<string, unknown>>) {
	return createRollupIndex({ rows, version: 7, now: () => NOW, log: () => {} });
}

describe("rollup：构造时加载 rows", () => {
	it("createRollupIndex({rows}) 真有数据：全窗口 11 次 / 4 个小时桶 / version 7", () => {
		const index = newIndex(seed());
		const agg = index.aggregate({ fromMs: T0 - 2 * HOUR, toMs: T0 + HOUR - 1, gran: "1h" });
		expect(agg.kpi.calls).toBe(11);
		expect(index.stats().hourBuckets).toBe(4);
		expect(index.version).toBe(7);
	});

	it("不传 rows 时同一个窗口是 0（证明上面的 11 真来自 opts.rows）", () => {
		const empty = newIndex([]);
		expect(empty.aggregate({ fromMs: T0 - 2 * HOUR, toMs: T0 + HOUR - 1, gran: "1h" }).kpi.calls).toBe(0);
	});

	it("时间窗不同 → calls 不同（today 4 次，全窗 11 次）", () => {
		const index = newIndex(seed());
		const today = index.aggregate({ fromMs: T0, toMs: T0 + HOUR - 1, gran: "1h" });
		const all = index.aggregate({ fromMs: T0 - 2 * HOUR, toMs: T0 + HOUR - 1, gran: "1h" });
		expect(today.kpi.calls).toBe(4);
		expect(all.kpi.calls).toBe(11);
		expect(today.kpi.calls).not.toBe(all.kpi.calls);
		// 窗口越窄，序列桶也越少：3 → 1
		expect(all.series.length).toBe(3);
		expect(today.series.length).toBe(1);
	});
});

describe("rollup：aggregate 与 summarizeRows 口径一致", () => {
	it("三个窗口的 kpi 逐字段相等", () => {
		const rows = seed();
		const index = newIndex(rows);
		const windows = [
			{ fromMs: T0 - 2 * HOUR, toMs: T0 + HOUR - 1 },
			{ fromMs: T0, toMs: T0 + HOUR - 1 },
			{ fromMs: T0 - 24 * HOUR, toMs: T0 + HOUR - 1 },
		];
		for (const win of windows) {
			const agg = index.aggregate({ ...win, gran: "1h" });
			expect(agg.kpi, JSON.stringify(win)).toEqual(summarizeRows(rows, win));
			// 图表与 KPI 必须对得上，否则「切窗口画面不变」这类缺陷会复发
			expect(sumCalls(agg.series), JSON.stringify(win)).toBe(agg.kpi.calls);
		}
	});
});

describe("rollup：筛选与 Top-N", () => {
	it("statuses=['ok'] → 8 次，序列和与 KPI 同步收缩", () => {
		const index = newIndex(seed());
		const agg = index.aggregate({
			fromMs: T0 - 2 * HOUR,
			toMs: T0 + HOUR - 1,
			gran: "1h",
			filters: { statuses: ["ok"] },
		});
		expect(agg.kpi.calls).toBe(8);
		expect(agg.kpi.aborted).toBe(0);
		expect(sumCalls(agg.series)).toBe(8);
	});

	it("models=['m2'] → 2 次，且只出现在 m2 的 Top 行里", () => {
		const index = newIndex(seed());
		const agg = index.aggregate({
			fromMs: T0 - 2 * HOUR,
			toMs: T0 + HOUR - 1,
			gran: "1h",
			filters: { models: ["m2"] },
		});
		expect(agg.kpi.calls).toBe(2);
		expect(agg.topModels.map((item: { name: string }) => item.name)).toEqual(["m2"]);
	});

	it("Top-N 按 calls 降序、share 之和 = 1", () => {
		const index = newIndex(seed());
		const agg = index.aggregate({ fromMs: T0 - 2 * HOUR, toMs: T0 + HOUR - 1, gran: "1h" });
		expect(agg.topModels.map((item: { name: string; calls: number }) => [item.name, item.calls])).toEqual([
			["m1", 9],
			["m2", 2],
		]);
		const shares = agg.topModels.reduce((sum: number, item: { share: number }) => sum + item.share, 0);
		expect(shares).toBeCloseTo(1, 3);
		expect(agg.filters.models).toEqual(["m1", "m2"]);
		expect(agg.filters.statuses).toContain("aborted");
	});
});

describe("rollup：增量与替换", () => {
	it("applyDelta 合并新行 → calls 增加，序列和跟着变", () => {
		const index = newIndex(seed());
		const before = index.aggregate({ fromMs: T0 - 2 * HOUR, toMs: T0 + HOUR - 1, gran: "1h" });
		index.applyDelta([rollupRow({ bucket: T0, status: "ok", calls: 2 })]);
		const after = index.aggregate({ fromMs: T0 - 2 * HOUR, toMs: T0 + HOUR - 1, gran: "1h" });
		expect(before.kpi.calls).toBe(11);
		expect(after.kpi.calls).toBe(13);
		expect(sumCalls(after.series)).toBe(13);
		expect(index.stats().lastDeltaAt).toBe(NOW);
	});

	it("replaceAll([]) 清空索引（导入重扫后整表替换的路径）", () => {
		const index = newIndex(seed());
		expect(index.aggregate({ fromMs: T0 - 2 * HOUR, toMs: T0 + HOUR - 1, gran: "1h" }).kpi.calls).toBe(11);
		index.replaceAll([]);
		expect(index.aggregate({ fromMs: T0 - 2 * HOUR, toMs: T0 + HOUR - 1, gran: "1h" }).kpi.calls).toBe(0);
		expect(index.stats().hourBuckets).toBe(0);
	});
});
