/**
 * 聚合单测：分位、token / 成本 / 速率、按模型汇总、趋势、筛选、分页。
 *
 * 口径必须与 lib/metrics.mjs 顶部注释、README 一致；这些断言就是口径的可执行定义。
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PAGE_SIZE,
	MAX_PAGE_SIZE,
	bucketKey,
	byModel,
	clampPageSize,
	dayKey,
	filterRecords,
	hourKey,
	normalizeBucket,
	normalizeStatus,
	normalizeWindow,
	pageRecords,
	percentileOf,
	percentiles,
	projectRecord,
	resolveWindow,
	series,
	sumCost,
	sumTokens,
	summarize,
	tokPerSec,
	WINDOW_KEYS,
} from "../../lib/metrics.mjs";

const DAY = 86_400_000;

/** 造一条记录（默认字段按真实回填记录形状）。 */
function rec(over = {}) {
	return {
		id: over.id ?? Math.random().toString(36),
		ts: 1791774070834,
		model: "grok-4.7",
		provider: "cliproxyapi",
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 100,
		cacheWriteTokens: 0,
		reasoningTokens: 50,
		totalTokens: 1650,
		costUsd: 0.02,
		durationMs: 4000,
		ttftMs: 800,
		status: "ok",
		stopReason: "stop",
		source: "backfill",
		sources: ["backfill"],
		...over,
	};
}

describe("白名单化与时间窗", () => {
	it("窗口 / 粒度 / 状态的白名单", () => {
		expect(normalizeWindow("7d")).toBe("7d");
		expect(normalizeWindow("bad")).toBe("today");
		expect(normalizeBucket("day")).toBe("day");
		expect(normalizeBucket("bad")).toBe("hour");
		expect(normalizeStatus("error")).toBe("error");
		expect(normalizeStatus("bad")).toBe("all");
		expect(WINDOW_KEYS).toEqual(["today", "7d", "30d", "all"]);
	});

	it("today = 本地当日 00:00 起；7d/30d = 滚动窗口", () => {
		const now = new Date(2026, 9, 27, 15, 30, 0).getTime();
		const today = resolveWindow("today", now);
		expect(new Date(today.fromMs).getHours()).toBe(0);
		expect(today.toMs).toBe(now);
		const week = resolveWindow("7d", now);
		expect(week.fromMs).toBe(now - 7 * DAY);
		const month = resolveWindow("30d", now);
		expect(month.fromMs).toBe(now - 30 * DAY);
	});

	it("all 不限下界", () => {
		const all = resolveWindow("all", 12345);
		expect(all.fromMs).toBe(0);
		expect(all.toMs).toBe(12345);
	});

	it("非法窗口键回落 today", () => {
		expect(resolveWindow("nope", 0).key).toBe("today");
	});
});

describe("分位数（nearest-rank）", () => {
	it("空数组给 null，不造 0", () => {
		expect(percentileOf([], 0.5)).toBeNull();
		expect(percentiles([])).toEqual({ samples: 0, p50: null, p90: null, p99: null, avg: null });
	});

	it("nearest-rank：10 个样本的 p50/p90/p99", () => {
		const sorted = Array.from({ length: 10 }, (_, i) => i + 1);
		expect(percentileOf(sorted, 0.5)).toBe(5);
		expect(percentileOf(sorted, 0.9)).toBe(9);
		expect(percentileOf(sorted, 0.99)).toBe(10);
	});

	it("单个样本时三个分位都等于它", () => {
		const p = percentiles([42]);
		expect(p).toMatchObject({ samples: 1, p50: 42, p90: 42, p99: 42, avg: 42 });
	});

	it("TTFT 的 0 与 null 视为没测到（不参与分位）", () => {
		const p = percentiles([0, null, 100, undefined, 300]);
		expect(p.samples).toBe(2);
		expect(p.p50).toBe(100);
		expect(p.p99).toBe(300);
	});

	it("positiveOnly:false 时保留 0（延迟这类合法 0 用）", () => {
		expect(percentiles([0, 0, 10], { positiveOnly: false }).samples).toBe(3);
	});

	it("非法值（NaN / 字符串 / 负数）不参与统计", () => {
		expect(percentiles([Number.NaN, "abc", -5, 100]).samples).toBe(1);
	});
});

describe("token / 成本 / 速率", () => {
	it("token 汇总：缺失按 0 计", () => {
		const t = sumTokens([rec(), rec({ inputTokens: null, outputTokens: null, totalTokens: null })]);
		expect(t.input).toBe(1000);
		expect(t.output).toBe(500);
		expect(t.cacheRead).toBe(200);
		expect(t.reasoning).toBe(100);
		expect(t.total).toBe(1650);
	});

	it("成本：只求和有值的，没有成本字段的单独计数（不伪装成 $0）", () => {
		const c = sumCost([rec({ costUsd: 0.02 }), rec({ costUsd: 0 }), rec({ costUsd: null })]);
		expect(c.amount).toBeCloseTo(0.02, 6);
		expect(c.pricedCalls).toBe(2);
		expect(c.unpricedCalls).toBe(1);
		expect(c.totalCalls).toBe(3);
	});

	it("全都没有成本时 amount 是 null（前端显示 --）", () => {
		expect(sumCost([rec({ costUsd: null })]).amount).toBeNull();
		expect(sumCost([]).amount).toBeNull();
	});

	it("tok/s：outputTokens/(durationMs/1000) 的均值", () => {
		const rate = tokPerSec([rec({ outputTokens: 500, durationMs: 4000 }), rec({ outputTokens: 1000, durationMs: 2000 })]);
		expect(rate.samples).toBe(2);
		expect(rate.avg).toBe(Math.round(((500 / 4 + 1000 / 2) / 2) * 100) / 100);
	});

	it("tok/s 除零样本被排除：duration 0 / null、output 0 / null", () => {
		const rate = tokPerSec([
			rec({ durationMs: 0 }),
			rec({ durationMs: null }),
			rec({ outputTokens: 0 }),
			rec({ outputTokens: null }),
			rec({ outputTokens: 100, durationMs: 1000 }),
		]);
		expect(rate.samples).toBe(1);
		expect(rate.avg).toBe(100);
	});

	it("没有任何可用样本时 tok/s 是 null", () => {
		expect(tokPerSec([]).avg).toBeNull();
		expect(tokPerSec([rec({ durationMs: 0 })]).avg).toBeNull();
	});
});

describe("summarize：一眼看全", () => {
	it("调用数 / 成功 / 失败 / 未收全 与成功率", () => {
		const s = summarize([
			rec({ status: "ok" }),
			rec({ status: "ok" }),
			rec({ status: "error" }),
			rec({ status: "incomplete", ttftMs: null }),
		]);
		expect(s.calls).toBe(4);
		expect(s.ok).toBe(2);
		expect(s.failed).toBe(1);
		expect(s.incomplete).toBe(1);
		expect(s.successRate).toBe(0.5);
	});

	it("TTFT 只有 1 个样本 → 覆盖率 25%，并单独给出样本数", () => {
		const s = summarize([rec(), rec({ ttftMs: null }), rec({ ttftMs: null }), rec({ ttftMs: 0 })]);
		expect(s.ttft.samples).toBe(1);
		expect(s.ttft.coverage).toBe(0.25);
		expect(s.ttft.p50).toBe(800);
	});

	it("空账本：成功率 null、成本 null、计数 0（不造 0% / $0）", () => {
		const s = summarize([]);
		expect(s.calls).toBe(0);
		expect(s.successRate).toBeNull();
		expect(s.cost.amount).toBeNull();
		expect(s.ttft.p50).toBeNull();
		expect(s.ttft.coverage).toBeNull();
	});

	it("延迟统计与最大值", () => {
		const s = summarize([rec({ durationMs: 1000 }), rec({ durationMs: 5000 }), rec({ durationMs: null })]);
		expect(s.latencySamples).toBe(2);
		expect(s.latencyAvg).toBe(3000);
		expect(s.latencyMax).toBe(5000);
	});

	it("模型 / provider 去重计数", () => {
		const s = summarize([
			rec({ model: "a", provider: "p1" }),
			rec({ model: "a", provider: "p2" }),
			rec({ model: "b", provider: "p1" }),
			rec({ model: null, provider: null }),
		]);
		expect(s.models).toBe(2);
		expect(s.providers).toBe(2);
	});
});

describe("byModel：按模型汇总（用户第一诉求）", () => {
	it("每个模型一行，调用数降序，成本与占比正确", () => {
		const rows = byModel([
			rec({ model: "a", costUsd: 0.01, outputTokens: 100 }),
			rec({ model: "a", costUsd: 0.01, outputTokens: 100 }),
			rec({ model: "b", costUsd: 0.02, outputTokens: 200 }),
		]);
		expect(rows.map((r) => r.model)).toEqual(["a", "b"]);
		expect(rows[0].calls).toBe(2);
		expect(rows[0].cost.amount).toBeCloseTo(0.02, 6);
		expect(rows[0].callShare).toBeCloseTo(0.6667, 4);
		expect(rows[0].costShare).toBeCloseTo(0.5, 4);
		expect(rows[1].costShare).toBeCloseTo(0.5, 4);
	});

	it("调用数相同时按成本降序，再按名称升序（稳定排序）", () => {
		const rows = byModel([
			rec({ model: "z", costUsd: 0.01 }),
			rec({ model: "y", costUsd: 0.05 }),
			rec({ model: "x", costUsd: 0.05 }),
		]);
		expect(rows.map((r) => r.model)).toEqual(["x", "y", "z"]);
	});

	it("空模型名归到 (unknown)，不丢数据", () => {
		const rows = byModel([rec({ model: null }), rec({ model: "  " })]);
		expect(rows.length).toBe(1);
		expect(rows[0].model).toBe("(unknown)");
		expect(rows[0].calls).toBe(2);
	});

	it("每行带自己的 TTFT 分位与 token 明细", () => {
		const rows = byModel([
			rec({ model: "a", ttftMs: 1000, outputTokens: 10 }),
			rec({ model: "a", ttftMs: 3000, outputTokens: 20 }),
			rec({ model: "b", ttftMs: null }),
		]);
		expect(rows[0].ttft.p50).toBe(1000);
		expect(rows[0].ttft.p90).toBe(3000);
		expect(rows[0].tokens.output).toBe(30);
		expect(rows[1].ttft.samples).toBe(0);
	});

	it("providers 列表去重（同一模型可能走多条路由）", () => {
		const rows = byModel([rec({ provider: "p1" }), rec({ provider: "p2" }), rec({ provider: "p1" })]);
		expect(rows[0].providers).toEqual(["p1", "p2"]);
	});

	it("全部没有成本时 costShare 是 null（不显示 0%）", () => {
		const rows = byModel([rec({ costUsd: null })]);
		expect(rows[0].costShare).toBeNull();
	});
});

describe("趋势序列", () => {
	it("hourKey / dayKey 用本地时间", () => {
		const ms = new Date(2026, 9, 27, 9, 41, 0).getTime();
		expect(hourKey(ms)).toBe("2026-10-27T09:00:00");
		expect(dayKey(ms)).toBe("2026-10-27");
		expect(bucketKey(ms, "day")).toBe("2026-10-27");
		expect(bucketKey(ms, "hour")).toBe("2026-10-27T09:00:00");
	});

	it("按小时分桶：calls / bad / ttft 分位 / token / 成本", () => {
		const t0 = new Date(2026, 9, 27, 9, 5, 0).getTime();
		const t1 = new Date(2026, 9, 27, 9, 50, 0).getTime();
		const t2 = new Date(2026, 9, 27, 10, 1, 0).getTime();
		const out = series([
			rec({ ts: t0, ttftMs: 1000, costUsd: 0.01 }),
			rec({ ts: t1, status: "error", ttftMs: null, costUsd: 0.02 }),
			rec({ ts: t2, ttftMs: 2000, costUsd: 0.03 }),
		]);
		expect(out.length).toBe(2);
		expect(out[0].hour).toBe("2026-10-27T09:00:00");
		expect(out[0].calls).toBe(2);
		expect(out[0].bad).toBe(1);
		expect(out[0].ttftSamples).toBe(1);
		expect(out[0].costUsd).toBeCloseTo(0.03, 6);
		expect(out[1].hour).toBe("2026-10-27T10:00:00");
	});

	it("按天分桶，桶键是日期", () => {
		const d1 = new Date(2026, 9, 26, 23, 0, 0).getTime();
		const d2 = new Date(2026, 9, 27, 1, 0, 0).getTime();
		const out = series([rec({ ts: d1 }), rec({ ts: d2 })], { bucket: "day" });
		expect(out.map((b) => b.hour)).toEqual(["2026-10-26", "2026-10-27"]);
	});

	it("按桶键升序排列（图表 x 轴依赖它）", () => {
		const t = (h) => new Date(2026, 9, 27, h, 0, 0).getTime();
		const out = series([rec({ ts: t(12) }), rec({ ts: t(9) }), rec({ ts: t(10) })]);
		expect(out.map((b) => b.hour.slice(11, 13))).toEqual(["09", "10", "12"]);
	});

	it("没有 ts 的记录不进趋势（不塞到 1970）", () => {
		expect(series([rec({ ts: null })]).length).toBe(0);
	});

	it("空数据给空数组（图走空态文案）", () => {
		expect(series([])).toEqual([]);
	});
});

describe("筛选与分页", () => {
	it("按模型精确匹配", () => {
		const list = [rec({ model: "a" }), rec({ model: "b" })];
		expect(filterRecords(list, { model: "a" }).length).toBe(1);
		expect(filterRecords(list, { model: "A" }).length).toBe(0);
		expect(filterRecords(list, { model: "" }).length).toBe(2);
	});

	it("按状态筛选，all 不过滤", () => {
		const list = [rec({ status: "ok" }), rec({ status: "error" }), rec({ status: "incomplete" })];
		expect(filterRecords(list, { status: "error" }).length).toBe(1);
		expect(filterRecords(list, { status: "incomplete" }).length).toBe(1);
		expect(filterRecords(list, { status: "all" }).length).toBe(3);
		expect(filterRecords(list, { status: "bad" }).length).toBe(3);
	});

	it("关键字搜模型 / provider / 停止原因（大小写不敏感）", () => {
		const list = [rec({ model: "Grok-4.7" }), rec({ provider: "deepseek", model: "x" })];
		expect(filterRecords(list, { q: "grok" }).length).toBe(1);
		expect(filterRecords(list, { q: "DEEPSEEK" }).length).toBe(1);
		expect(filterRecords(list, { q: "zzz" }).length).toBe(0);
	});

	it("页大小夹取 1–200，默认 20", () => {
		expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
		expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
		expect(clampPageSize(-3)).toBe(DEFAULT_PAGE_SIZE);
		expect(clampPageSize(1)).toBe(1);
		expect(clampPageSize(9999)).toBe(MAX_PAGE_SIZE);
		expect(clampPageSize("15")).toBe(15);
	});

	it("分页按时间倒序，页码越界自动夹取", () => {
		const list = Array.from({ length: 25 }, (_, i) => rec({ id: `r${i}`, ts: 1000 + i }));
		const page1 = pageRecords(list, { page: 1, pageSize: 10 });
		expect(page1.pages).toBe(3);
		expect(page1.items.length).toBe(10);
		expect(page1.items[0].id).toBe("r24");
		const page3 = pageRecords(list, { page: 3, pageSize: 10 });
		expect(page3.items.length).toBe(5);
		expect(pageRecords(list, { page: 99, pageSize: 10 }).page).toBe(3);
		expect(pageRecords(list, { page: 0, pageSize: 10 }).page).toBe(1);
	});

	it("空列表仍然给 1 页（前端不会算出第 0 页）", () => {
		const empty = pageRecords([], { page: 2, pageSize: 10 });
		expect(empty.pages).toBe(1);
		expect(empty.page).toBe(1);
		expect(empty.total).toBe(0);
	});

	it("projectRecord 只留展示字段，缺失值补 0 / null", () => {
		const p = projectRecord(rec({ inputTokens: null, costUsd: null, model: "" }));
		expect(p.inputTokens).toBe(0);
		expect(p.costUsd).toBeNull();
		expect(p.model).toBe("(unknown)");
		expect(p.ttftMs).toBe(800);
		expect(p.sources).toEqual(["backfill"]);
	});
});
