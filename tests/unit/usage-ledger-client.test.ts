// @vitest-environment jsdom
/**
 * 客户端看板单测（jsdom）：挂载 → 渲染 → 筛选 / 分页 / 动作 → 清理。
 *
 * 这里不校验像素，只锁住「真实渲染路径不炸」与几个硬约束：
 *  - 指标卡 / 双图 SVG / 按模型表 / 记录表都真的渲染出来，数字格式对；
 *  - 点模型行 = 只看该模型，点记录行 = 展开 token 拆分；
 *  - 窗口 / 粒度 / 状态 / 分页都真的换了查询参数；
 *  - live-only 降级给「授权并导入历史」按钮，点了会 POST /api/grant；
 *  - 空账本与接口失败都给明确文案、不抛错；
 *  - cleanup 后容器清空、样式与监听不留残骸。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

interface FetchCall {
	url: string;
	method: string;
}

const state = {
	calls: [] as FetchCall[],
	failMode: "ok" as "ok" | "empty" | "network" | "live-only",
	coverage: null as null | { imported: number; eligible: number; remaining: number },
	truncated: false,
};

const RECORD_TS = new Date(2026, 9, 27, 1, 2, 3).getTime();

function summaryPayload() {
	return {
		ok: true,
		meta: { window: "today", mode: "full", cached: false },
		summary: {
			calls: 1234,
			ok: 1213,
			failed: 18,
			incomplete: 3,
			successRate: 1213 / 1234,
			ttft: { samples: 800, p50: 6333, p90: 14_918, p99: 34_519, avg: 7900, coverage: 800 / 1234 },
			latencyAvg: 13_500,
			latencyMax: 40_000,
			latencySamples: 1200,
			tokPerSec: 42.5,
			tokPerSecMean: 51.2,
			tokPerSecSamples: 1200,
			cacheHitRate: 0.42,
			cacheHitRateMean: 0.55,
			cacheHitSamples: 900,
			tokens: {
				input: 1_500_000,
				output: 90_000,
				cacheRead: 900_000,
				cacheWrite: 0,
				reasoning: 12_000,
				total: 2_502_000,
			},
			cost: {
				amount: 12.3456,
				sdkAmount: 10.3456,
				estimatedAmount: 2,
				estimateShare: 2 / 12.3456,
				pricedCalls: 1200,
				unpricedCalls: 34,
				totalCalls: 1234,
			},
			models: 3,
			providers: 2,
		},
		models: [
			{
				model: "gemini-3.8-flash-high",
				calls: 900,
				ok: 890,
				failed: 8,
				incomplete: 2,
				successRate: 890 / 900,
				ttft: { samples: 600, p50: 6498, p90: 9000, p99: 12_000 },
				latencyAvg: 12_000,
				tokPerSec: 1014.9,
				tokPerSecMean: 980.5,
				cacheHitRate: 0.8,
				cacheHitRateMean: 0.7,
				cacheHitSamples: 800,
				tokens: { input: 1e6, output: 5e4, cacheRead: 8e5, cacheWrite: 0, reasoning: 0, total: 1_850_000 },
				cost: {
					amount: 10.5,
					sdkAmount: 10.5,
					estimatedAmount: 0,
					estimateShare: 0,
					pricedCalls: 890,
					unpricedCalls: 10,
					totalCalls: 900,
				},
				callShare: 900 / 1234,
				costShare: 10.5 / 12.3456,
				providers: ["antigravity"],
			},
			{
				model: "grok-4.7",
				calls: 334,
				ok: 323,
				failed: 8,
				incomplete: 3,
				successRate: 0.967,
				ttft: { samples: 200, p50: 1200, p90: 2000, p99: 3000 },
				latencyAvg: 4000,
				tokPerSec: 120,
				tokens: { input: 500_000, output: 40_000, cacheRead: 100_000, cacheWrite: 0, reasoning: 1000, total: 640_000 },
				cost: { amount: 1.8456, pricedCalls: 310, unpricedCalls: 24, totalCalls: 334 },
				callShare: 334 / 1234,
				costShare: 0.15,
				providers: ["cliproxyapi"],
			},
		],
		prices: {
			status: {
				available: true,
				stale: false,
				fetchedAt: RECORD_TS,
				entries: 1234,
				sources: [
					{ id: "modelsdev", label: "models.dev", ok: true, count: 1000, ms: 10, error: null },
					{ id: "litellm", label: "LiteLLM", ok: false, count: 0, ms: 0, error: "HTTP 500" },
				],
				failed: ["LiteLLM"],
				lastError: null,
			},
			models: [
				{
					model: "gemini-3.8-flash-high",
					via: "official",
					priceId: "modelsdev:google/gemini-3.8-flash",
					source: "modelsdev",
					provider: "google",
					input: 0.75,
					output: 3.75,
					cacheRead: 0.075,
					cacheWrite: null,
					candidates: 3,
				},
			],
		},
	};
}

function seriesPayload() {
	return {
		ok: true,
		meta: { window: "today", bucket: "hour" },
		series: [
			{ hour: "2026-10-27T01:00:00", calls: 10, bad: 1, ttftP50: 400, ttftP90: 900, ttftSamples: 9 },
			{ hour: "2026-10-27T02:00:00", calls: 20, bad: 0, ttftP50: 600, ttftP90: 1200, ttftSamples: 20 },
		],
	};
}

function recordsPayload() {
	return {
		ok: true,
		meta: { window: "today" },
		records: [
			{
				id: "r42",
				ts: RECORD_TS,
				model: "gemini-3.8-flash-high",
				provider: "antigravity",
				thinkingLevel: "high",
				conversationId: "conv-1",
				projectDir: "--proj--",
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 800,
				cacheWriteTokens: 0,
				reasoningTokens: 20,
				totalTokens: 1500,
				costUsd: 0.0123,
				costSource: "estimate",
				costEstimateUsd: 0.0123,
				priceId: "modelsdev:google/gemini-3.8-flash",
				priceNote: "cacheWrite≈input",
				promptTokens: 1800,
				cacheHitRate: 800 / 1800,
				durationMs: 12_000,
				ttftMs: 4000,
				stopReason: "stop",
				status: "ok",
				source: "live",
				sources: ["live", "backfill"],
			},
			{
				id: "r43",
				ts: RECORD_TS - 60_000,
				model: "grok-4.7",
				provider: "cliproxyapi",
				thinkingLevel: null,
				inputTokens: 10,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				totalTokens: 10,
				costUsd: null,
				costSource: null,
				promptTokens: 10,
				cacheHitRate: 0,
				durationMs: null,
				ttftMs: null,
				stopReason: "error",
				status: "error",
				source: "backfill",
				sources: ["backfill"],
			},
		],
		page: 1,
		pages: 3,
		pageSize: 20,
		total: 45,
	};
}

function metaPayload() {
	const liveOnly = state.failMode === "live-only";
	return {
		ok: true,
		meta: {
			window: "all",
			ledgerPath: "C:\\Users\\me\\.pi-web-ui\\plugin-data\\usage-ledger\\ledger.jsonl",
			ledger: { records: 45, bad: 0, writeErrors: 0, persistence: true },
			sessionsRoot: "C:\\Users\\me\\.pi\\agent\\sessions",
			fsReady: !liveOnly,
			mode: liveOnly ? "live-only" : "full",
			backfill: {
				files: 12,
				records: 45,
				finishedAt: RECORD_TS,
				errors: [],
				coverage: state.coverage,
				truncated: state.truncated,
			},
			coverage: state.coverage,
			importing: state.truncated,
			backfillError: null,
			grant: liveOnly
				? {
						required: true,
						reason: "会话目录未授权",
						reasonEn: "Sessions directory not authorized",
						hint: "在看板点「授权并导入历史」",
						hintEn: "Click authorize in the dashboard",
					}
				: { required: false, reason: "", reasonEn: "", hint: "", hintEn: "" },
		},
	};
}

function payloadFor(url: string) {
	if (state.failMode === "network") return null;
	if (state.failMode === "empty") {
		if (url.includes("/api/summary")) {
			return {
				ok: true,
				meta: {
					window: "today",
					ledger: { records: 0 },
					backfill: null,
					mode: "full",
					grant: { required: false },
					sessionsRoot: "/tmp/sessions",
				},
				summary: {
					calls: 0,
					ok: 0,
					failed: 0,
					incomplete: 0,
					successRate: null,
					ttft: { samples: 0, p50: null, p90: null, p99: null, avg: null, coverage: null },
					latencyAvg: null,
					latencyMax: null,
					latencySamples: 0,
					tokPerSec: null,
					tokPerSecSamples: 0,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
					cost: { amount: null, pricedCalls: 0, unpricedCalls: 0, totalCalls: 0 },
					models: 0,
					providers: 0,
				},
				models: [],
			};
		}
		if (url.includes("/api/series")) return { ok: true, meta: {}, series: [] };
		if (url.includes("/api/records")) {
			return { ok: true, meta: {}, records: [], page: 1, pages: 1, pageSize: 20, total: 0 };
		}
		return metaPayload();
	}
	if (url.includes("/api/summary")) return summaryPayload();
	if (url.includes("/api/series")) return seriesPayload();
	if (url.includes("/api/records")) return recordsPayload();
	return metaPayload();
}

function stubFetch() {
	const mock = vi.fn(async (url: string, init?: RequestInit) => {
		state.calls.push({ url: String(url), method: String(init?.method ?? "GET") });
		const body = payloadFor(String(url));
		if (body === null) throw new Error("boom");
		return { ok: true, status: 200, json: async () => body };
	});
	vi.stubGlobal("fetch", mock);
	return mock;
}

// 语言跟随 documentElement.lang（宿主切语言也走这条路）：固定中文以便断言文案
document.documentElement.lang = "zh-CN";

const clientEntry = await import("../../client/entry.mjs");
const { callsChart, ttftChart, dict, fmtCost, fmtMs, fmtShare, renderCards } = clientEntry;

function mountDashboard() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	// 插件只看 HTTP 接口与宿主动作桥，不需要 ctx 通道
	const cleanup = clientEntry.default.mount(container);
	return { container, cleanup };
}

afterEach(() => {
	vi.unstubAllGlobals();
	state.calls.length = 0;
	state.failMode = "ok";
	state.coverage = null;
	state.truncated = false;
	document.body.innerHTML = "";
	document.getElementById("usage-ledger-styles")?.remove();
});

describe("客户端看板渲染", () => {
	it("渲染指标卡 / 双图 / 按模型表 / 记录表，并打全 4 个接口", async () => {
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-cards")).toBeTruthy());
		const html = container.innerHTML;
		// 指标卡：调用 1.2k / 成功率 98.3% / TTFT p50 6.33s
		expect(html).toContain("1.2k");
		expect(html).toContain("98.3%");
		expect(html).toContain("6.33s");
		expect(html).toContain("14.9s"); // p90
		expect(html).toContain("$12.35"); // 真实成本
		expect(html).toContain("SDK usage.cost.total");
		// 两张手写 SVG 图
		expect(container.querySelectorAll("svg.cps-svg").length).toBe(2);
		expect(container.querySelectorAll("svg.cps-svg rect").length).toBeGreaterThan(0);
		expect(container.querySelectorAll("svg.cps-svg polyline").length).toBeGreaterThan(0);
		// 按模型表 + 记录表
		expect(container.querySelectorAll("tr[data-model]").length).toBe(2);
		expect(container.querySelectorAll("tr[data-rid]").length).toBe(2);
		expect(html).toContain("gemini-3.8-flash-high");
		expect(html).toContain("$10.50");
		expect(html).toContain("$0.0123");
		expect(html).toContain("10-27 01:02:03");
		expect(html).toContain("成功");
		// 状态行：账本条数 / 会话目录 / 上次回填
		expect(html).toContain("账本");
		expect(html).toContain("C:\\Users\\me\\.pi\\agent\\sessions");
		expect(state.calls.map((c) => c.url.split("?")[0]).sort()).toEqual([
			"/plugins-api/usage-ledger/api/meta",
			"/plugins-api/usage-ledger/api/records",
			"/plugins-api/usage-ledger/api/series",
			"/plugins-api/usage-ledger/api/summary",
		]);
		cleanup();
		expect(container.childElementCount).toBe(0);
		container.remove();
	});

	it("TTFT 覆盖率与「只能实时采集」说明必须可见（不许把样本少说成很快）", async () => {
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-cards")).toBeTruthy());
		const html = container.innerHTML;
		expect(html).toContain("TTFT 覆盖");
		expect(html).toContain("64.8%"); // 800/1234
		expect(html).toContain("TTFT 只能实时采集");
		cleanup();
		container.remove();
	});

	it("缺 TTFT / 缺成本的记录显示 --，不伪装成 0 或 $0", async () => {
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector("tr[data-rid='r43']")).toBeTruthy());
		const row43 = container.querySelector("tr[data-rid='r43']") as HTMLElement;
		const cells = [...row43.querySelectorAll("td")].map((td) => td.textContent ?? "");
		expect(cells).toContain("--"); // 首字 / 耗时 / 成本
		expect(cells.join(" ")).not.toContain("$0.0000");
		cleanup();
		container.remove();
	});

	it("点击记录行展开 token 拆分与来源，再点收起", async () => {
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector("tr[data-rid='r42']")).toBeTruthy());
		(container.querySelector("tr[data-rid='r42']") as HTMLElement).click();
		await vi.waitFor(() => expect(container.querySelector(".cps-detail")).toBeTruthy());
		const detail = container.querySelector(".cps-detail")?.textContent ?? "";
		expect(detail).toContain("1.5k");
		expect(detail).toContain("实时+回填");
		expect(detail).toContain("r42");
		(container.querySelector("tr[data-rid='r42']") as HTMLElement).click();
		await vi.waitFor(() => expect(container.querySelector(".cps-detail")).toBeNull());
		cleanup();
		container.remove();
	});

	it("点模型行 → 只看该模型（查询带 model=）并出现清除 chip", async () => {
		const mock = stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector("tr[data-model]")).toBeTruthy());
		mock.mockClear();
		(container.querySelector("tr[data-model='grok-4.7']") as HTMLElement).click();
		await vi.waitFor(() => expect(mock).toHaveBeenCalled());
		expect(String(mock.mock.calls[0][0])).toContain("model=grok-4.7");
		await vi.waitFor(() => expect(container.querySelector(".cps-chip")).toBeTruthy());
		expect(container.querySelector(".cps-chip")?.textContent).toContain("只看 grok-4.7");
		mock.mockClear();
		(container.querySelector(".cps-chip") as HTMLElement).click();
		await vi.waitFor(() => expect(mock).toHaveBeenCalled());
		expect(String(mock.mock.calls[0][0])).toContain("model=&");
		cleanup();
		container.remove();
	});

	it("窗口 / 粒度 / 状态 / 分页都真的换了查询参数", async () => {
		const mock = stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-cards")).toBeTruthy());

		mock.mockClear();
		(container.querySelector('[data-act="window"][data-value="7d"]') as HTMLElement).click();
		await vi.waitFor(() => expect(mock).toHaveBeenCalled());
		expect(String(mock.mock.calls[0][0])).toContain("window=7d");

		mock.mockClear();
		(container.querySelector('[data-act="bucket"][data-value="day"]') as HTMLElement).click();
		await vi.waitFor(() => expect(mock).toHaveBeenCalled());
		expect(String(mock.mock.calls[0][0])).toContain("bucket=day");

		mock.mockClear();
		(container.querySelector('[data-act="status"][data-value="error"]') as HTMLElement).click();
		await vi.waitFor(() => expect(mock).toHaveBeenCalled());
		expect(mock.mock.calls.some((c) => String(c[0]).includes("status=error"))).toBe(true);

		mock.mockClear();
		(container.querySelector('[data-act="page"][data-value="2"]') as HTMLElement).click();
		await vi.waitFor(() => expect(mock).toHaveBeenCalled());
		expect(mock.mock.calls.some((c) => String(c[0]).includes("page=2"))).toBe(true);
		cleanup();
		container.remove();
	});

	it("回填按钮走 POST /api/backfill", async () => {
		const mock = stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-cards")).toBeTruthy());
		mock.mockClear();
		const backfillBtn = container.querySelector('[data-act="backfill"]') as HTMLButtonElement;
		expect(backfillBtn).toBeTruthy();
		await vi.waitFor(() => expect(backfillBtn.disabled).toBe(false));
		backfillBtn.click();
		await vi.waitFor(() => expect(mock).toHaveBeenCalled());
		const post = mock.mock.calls.find((c) => (c[1] as RequestInit)?.method === "POST");
		expect(String(post?.[0])).toContain("/api/backfill");
		cleanup();
		container.remove();
	});

	it("空账本：给明确空态（跑一次对话或授权导入历史），不画卡片", async () => {
		state.failMode = "empty";
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.textContent).toContain("还没有记录"));
		expect(container.textContent).toContain("跑一次对话");
		expect(container.textContent).toContain("导入历史");
		expect(container.querySelector(".cps-empty")).toBeTruthy();
		cleanup();
		container.remove();
	});

	it("live-only 降级：显示原因与授权按钮，点了 POST /api/grant", async () => {
		state.failMode = "live-only";
		const mock = stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-notice")).toBeTruthy());
		const notice = container.querySelector(".cps-notice") as HTMLElement;
		expect(notice.textContent).toContain("会话目录未授权");
		expect(notice.textContent).toContain("在看板点");
		const grantBtn = container.querySelector('[data-act="grant"]') as HTMLElement;
		expect(grantBtn).toBeTruthy();
		mock.mockClear();
		grantBtn.click();
		await vi.waitFor(() => expect(mock).toHaveBeenCalled());
		const post = mock.mock.calls.find((c) => (c[1] as RequestInit)?.method === "POST");
		expect(String(post?.[0])).toContain("/api/grant");
		cleanup();
		container.remove();
	});

	it("接口网络失败：给空态文案并带上错误原因，不抛异常", async () => {
		state.failMode = "network";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("boom");
			}),
		);
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.textContent).toContain("boom"));
		expect(container.querySelector(".cps-notice")).toBeTruthy();
		expect(container.querySelector('[data-act="refresh"]')).toBeTruthy();
		cleanup();
		container.remove();
	});

	it("重试按钮重新拉数据", async () => {
		state.failMode = "network";
		const mock = vi.fn(async () => {
			throw new Error("boom");
		});
		vi.stubGlobal("fetch", mock);
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-notice")).toBeTruthy());
		mock.mockClear();
		(container.querySelector('[data-act="refresh"]') as HTMLElement).click();
		await vi.waitFor(() => expect(mock).toHaveBeenCalled());
		cleanup();
		container.remove();
	});
});

describe("纯函数：图表与格式化", () => {
	it("空数据给空态文案，不造 SVG", () => {
		expect(callsChart([], dict("zh"))).not.toContain("<svg");
		expect(ttftChart([], dict("zh"))).not.toContain("<svg");
	});

	it("单点与极值：坐标全是有限数，没有 NaN", () => {
		const one = [{ hour: "2026-10-27T01:00:00", calls: 1, bad: 1, ttftP50: 5, ttftP90: 5, ttftSamples: 1 }];
		for (const svg of [callsChart(one, dict("zh")), ttftChart(one, dict("zh"))]) {
			expect(svg).toContain("<svg");
			expect(svg).not.toMatch(/NaN|Infinity|undefined/);
		}
		const extreme = [
			{ hour: "2026-10-27T00:00:00", calls: 219_944, bad: 219_944, ttftP50: 0, ttftP90: 0, ttftSamples: 0 },
			{ hour: "2026-10-27T01:00:00", calls: 0, bad: 0, ttftP50: 219_944, ttftP90: 219_944, ttftSamples: 1 },
		];
		for (const svg of [callsChart(extreme, dict("zh")), ttftChart(extreme, dict("zh"))]) {
			expect(svg).not.toMatch(/NaN|Infinity|undefined/);
		}
		const zeroTtft = [{ hour: "2026-10-27T02:00:00", calls: 3, bad: 0, ttftP50: 0, ttftP90: 0, ttftSamples: 0 }];
		expect(ttftChart(zeroTtft, dict("zh"))).not.toContain("<svg");
	});

	it("按天桶的 x 轴标签是日期（不带时分）", () => {
		const svg = callsChart([{ hour: "2026-10-27", calls: 3, bad: 0 }], dict("zh"));
		expect(svg).toContain("10-27");
		expect(svg).not.toContain("2026-10-27T");
	});

	it("金额与毫秒格式化：缺失是 --，0 是 0", () => {
		expect(fmtCost(null)).toBe("--");
		expect(fmtCost(undefined)).toBe("--");
		expect(fmtCost(0)).toBe("$0.0000");
		expect(fmtCost(0.0123)).toBe("$0.0123");
		expect(fmtCost(12.3456)).toBe("$12.35");
		expect(fmtMs(0)).toBe("--");
		expect(fmtMs(null)).toBe("--");
		expect(fmtMs(733)).toBe("733ms");
		expect(fmtMs(6333)).toBe("6.33s");
	});

	it("占比格式化：缺失是 --、0 是 0.0%", () => {
		expect(fmtShare(null)).toBe("--");
		expect(fmtShare(0)).toBe("0.0%");
		expect(fmtShare(0.004)).toBe("0.40%");
		expect(fmtShare(0.5)).toBe("50.0%");
	});

	it("renderCards：没有 summary 时不渲染（不造空卡）", () => {
		expect(renderCards(null, dict("zh"))).toBe("");
	});

	it("renderCards：全 0 / 全 null 的账本给 -- 而不是 0% 或 $0", () => {
		const d = dict("zh");
		const html = renderCards(
			{
				calls: 0,
				ok: 0,
				failed: 0,
				incomplete: 0,
				successRate: null,
				ttft: { samples: 0, p50: null, p90: null, p99: null, coverage: null },
				latencyAvg: null,
				tokPerSec: null,
				tokPerSecSamples: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
				cost: { amount: null, pricedCalls: 0, unpricedCalls: 0 },
				models: 0,
			},
			d,
		);
		expect(html).toContain("--");
		expect(html).not.toContain("$0.0000");
		expect(html).not.toContain("0.0%");
	});

	it("中英文字典的键必须一一对应（宿主切语言不会缺字）", () => {
		const zh = dict("zh");
		const en = dict("en");
		expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
	});

	it("字典覆盖 2.0 的关键文案（数据源 / TTFT 说明 / 授权）", () => {
		for (const lang of ["zh", "en"]) {
			const d = dict(lang);
			expect(d.subtitle).toContain("pi-web-ui");
			expect(d.ttftNote).toMatch(/TTFT/);
			expect(d.grant).toBeTruthy();
			expect(d.empty).toBeTruthy();
		}
	});
});

describe("文件覆盖率必须可见（2.0.1）", () => {
	it("顶部显示「已导入 X/M 个会话文件」，导入中给「导入中…」与停止按钮", async () => {
		state.coverage = { imported: 3, eligible: 12, remaining: 9 };
		state.truncated = true;
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() =>
			expect(container.querySelector(".cps-meta")?.textContent ?? "").toContain("已导入 3/12 个会话文件"),
		);
		const metaLine = container.querySelector(".cps-meta")?.textContent ?? "";
		expect(metaLine).toContain("导入中…");
		const stop = container.querySelector("[data-act='stopImport']");
		expect(stop?.textContent).toContain("停止导入");
		cleanup();
		container.remove();
	});

	it("导完了就不再写「导入中…」，也不留停止按钮", async () => {
		state.coverage = { imported: 12, eligible: 12, remaining: 0 };
		state.truncated = false;
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() =>
			expect(container.querySelector(".cps-meta")?.textContent ?? "").toContain("已导入 12/12 个会话文件"),
		);
		const metaLine = container.querySelector(".cps-meta")?.textContent ?? "";
		expect(metaLine).not.toContain("导入中…");
		expect(container.querySelector("[data-act='stopImport']")).toBeNull();
		cleanup();
		container.remove();
	});

	it("点「停止导入」会 POST /api/backfill/stop", async () => {
		state.coverage = { imported: 3, eligible: 12, remaining: 9 };
		state.truncated = true;
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector("[data-act='stopImport']")).toBeTruthy(), { timeout: 3000 });
		(container.querySelector("[data-act='stopImport']") as HTMLElement).click();
		await vi.waitFor(() =>
			expect(state.calls.some((c) => c.url.includes("/api/backfill/stop") && c.method === "POST")).toBe(true),
		);
		cleanup();
		container.remove();
	});
});

// ─────────────────────────────────────────── 2.1.0：命中率 / 速度口径 / 价格表

describe("2.1.0 看板：缓存命中率、速度口径、价格表", () => {
	it("指标卡新增「缓存命中率」，带样本数；速度卡写明「总输出 ÷ 总耗时」并把均值放 tooltip", async () => {
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-cards")).toBeTruthy());
		const html = container.innerHTML;
		expect(html).toContain("缓存命中率");
		expect(html).toContain("42.0%"); // 加权命中率
		expect(html).toContain("样本 900");
		expect(html).toContain("总输出 ÷ 总耗时");
		// 均值只能出现在 tooltip 里，不能顶掉主值
		const tokCard = [...container.querySelectorAll(".cps-card")].find((el) => el.textContent?.includes("tok·s⁻¹"));
		expect(tokCard?.getAttribute("title") ?? "").toContain("均值 51");
		cleanup();
		container.remove();
	});

	it("成本卡同时显示 SDK 合计与「其中估算」占比", async () => {
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-cards")).toBeTruthy());
		const html = container.innerHTML;
		expect(html).toContain("$12.35");
		expect(html).toContain("其中估算");
		const costCard = [...container.querySelectorAll(".cps-card")].find((el) =>
			(el.getAttribute("title") ?? "").includes("SDK 成本"),
		);
		expect(costCard?.getAttribute("title") ?? "").toContain("估算");
		expect(costCard?.getAttribute("title") ?? "").toContain("$10.35");
		cleanup();
		container.remove();
	});

	it("按模型表有「命中率」列，记录表的缓存列是「读/写 · 命中%」", async () => {
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector("tr[data-model]")).toBeTruthy());
		const modelHead = container.querySelector("table.cps-models thead")?.textContent ?? "";
		expect(modelHead).toContain("命中率");
		const firstModelRow = container.querySelector("tr[data-model] td:nth-child(9)")?.textContent ?? "";
		expect(firstModelRow).toContain("80.0%");
		const cacheCell = container.querySelector("tr[data-rid] td:nth-child(6)")?.textContent ?? "";
		expect(cacheCell).toContain("800/0");
		expect(cacheCell).toContain("44.4%"); // 800 / (1000+800+0)
		cleanup();
		container.remove();
	});

	it("价格面板列出命中的价格行、候选数与失败源，并可点刷新", async () => {
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector("table.cps-prices")).toBeTruthy());
		const html = container.innerHTML;
		expect(html).toContain("价格表");
		expect(html).toContain("modelsdev:google/gemini-3.8-flash");
		expect(html).toContain("官方行");
		expect(html).toContain("LiteLLM:—"); // 失败的源显式标出来
		const btn = [...container.querySelectorAll("[data-act='refreshPrices']")][0] as HTMLElement;
		expect(btn).toBeTruthy();
		btn.click();
		await vi.waitFor(() =>
			expect(state.calls.some((c) => c.url.includes("/api/prices/refresh") && c.method === "POST")).toBe(true),
		);
		cleanup();
		container.remove();
	});

	it("估算成本的记录用 ≈ 前缀，展开明细能看到价格行", async () => {
		stubFetch();
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector("tr[data-rid]")).toBeTruthy());
		const html = container.innerHTML;
		expect(html).toContain("≈$0.0123");
		(container.querySelector("tr[data-rid]") as HTMLElement).click();
		await vi.waitFor(() => expect(container.querySelector(".cps-detail")).toBeTruthy());
		const detail = container.querySelector(".cps-detail")?.textContent ?? "";
		expect(detail).toContain("modelsdev:google/gemini-3.8-flash");
		expect(detail).toContain("估算成本");
		cleanup();
		container.remove();
	});
});
