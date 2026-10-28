/**
 * 回归：柱状图不得越过 0 线（用户实测 BUG：有失败请求时柱子钻到水平线以下）。
 *
 * 旧实现把柱子的 y 取成 `yOf(calls - bad)`、高度却按 `yOf(calls)` 算，
 * 于是底边 = yBadTop + (bottom - yTop) 比 0 线多出 (yBadTop - yTop)，直接漏到基线下。
 */
import { describe, expect, it } from "vitest";
import { callsChart } from "../../client/entry.mjs";

const DICT = {
	empty: "no-data",
	legendCalls: "calls",
	legendFailed: "failed/canceled",
	noSamples: "no-samples",
};

/** 从 SVG 里抠出所有 <rect> 的 y/height，返回它们的最低点。 */
function lowestRectBottom(svg: string): number {
	const rects = [...svg.matchAll(/<rect x="[-\d.]+" y="([-\d.]+)" width="[-\d.]+" height="([\d.]+)"/g)];
	expect(rects.length).toBeGreaterThan(0);
	return Math.max(...rects.map((m) => Number(m[1]) + Number(m[2])));
}

/** 从 SVG 网格线里读出 0 线所在 y（ratio=0 那条）。 */
function baselineY(svg: string): number {
	const lines = [...svg.matchAll(/<line x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="[\d.]+"/g)].map((m) => Number(m[1]));
	expect(lines.length).toBe(3);
	return Math.max(...lines);
}

describe("callsChart 基线回归", () => {
	it("有失败请求时柱底不得低于 0 线（原 BUG 会低 28px）", () => {
		const hours = [
			{ hour: "2026-10-27T09:00:00", calls: 10, bad: 3 },
			{ hour: "2026-10-27T10:00:00", calls: 5, bad: 5 },
			{ hour: "2026-10-27T11:00:00", calls: 8, bad: 0 },
		];
		const svg = callsChart(hours, DICT);
		const base = baselineY(svg);
		const lowest = lowestRectBottom(svg);
		expect(lowest).toBeLessThanOrEqual(base + 0.01);
		// 成功柱必须触到 0 线（不能悬空）
		expect(lowest).toBeCloseTo(base, 1);
	});

	it("全部失败时柱子仍落在 0 线以上，且失败段高度为正", () => {
		const svg = callsChart([{ hour: "2026-10-27T09:00:00", calls: 4, bad: 4 }], DICT);
		const base = baselineY(svg);
		expect(lowestRectBottom(svg)).toBeLessThanOrEqual(base + 0.01);
		const red = [...svg.matchAll(/fill="var\(--red, #ef4444\)"[^>]*/g)];
		expect(red.length).toBe(1);
		const h = Number(/height="([\d.]+)"/.exec(svg.split('fill="var(--red, #ef4444)"')[0].slice(-260))?.[1] ?? 0);
		expect(Number.isFinite(h)).toBe(true);
	});

	it("bad 超过 calls 时按 calls 截断，不出现负高度", () => {
		const svg = callsChart([{ hour: "2026-10-27T09:00:00", calls: 2, bad: 9 }], DICT);
		expect(svg).not.toMatch(/height="-/);
		expect(lowestRectBottom(svg)).toBeLessThanOrEqual(baselineY(svg) + 0.01);
	});
});
