// @vitest-environment jsdom
/**
 * usage-ledger 客户端看板单测（jsdom）：挂载 → 渲染 → 筛选 → 清理。
 *
 * 这里不校验像素，只锁住「真实渲染路径不炸」与几个硬约束：
 *  - 指标卡 / 双图 SVG / 模型表 / 事件表都真的被渲染出来；
 *  - 事件行可点开 token 拆分；
 *  - 窗口与客户端筛选真的换了查询参数；
 *  - 降级（账本缺失）时给明确空态文案，不抛错；
 *  - cleanup 后容器清空、样式与监听不留残骸（除宿主共享的 style 之外不碰 document 其它节点）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

interface FetchCall {
	url: string;
}

const state = {
	calls: [] as FetchCall[],
	failMode: "ok" as "ok" | "no-db" | "network",
};

function payloadFor(url: string) {
	if (state.failMode === "network") return null;
	if (state.failMode === "no-db") {
		// 与服务端 discoverLedger 的空态同形状：code + candidates + hint
		return {
			ok: false,
			code: "db-not-found",
			reason: "未找到代理用量账本 usage.db（已试 3 个位置）",
			reasonEn: "No proxy usage ledger found (tried 3 locations)",
			hint: "在设置里填 usage.db 绝对路径",
			hintEn: "Set the absolute path to usage.db in settings",
			candidates: [
				"C:\\Users\\me\\.pi\\agent\\cliproxyapi.json",
				"C:\\Users\\me\\AppData\\Local\\CLIProxyAPI",
				"C:\\Users\\me\\.local\\share\\cliproxyapi",
			],
			meta: { dbPath: "", window: "today", client: "all", generatedAt: Date.now(), cached: false },
		};
	}
	if (url.includes("/api/summary")) {
		return {
			ok: true,
			meta: {
				dbPath: "E:\\EasyCLIProxyAPI-v0.2.25-Windows-amd64\\usage-records\\usage.db",
				window: "today",
				client: "all",
				groupBy: "model",
				generatedAt: Date.now(),
				cached: false,
				price: {
					available: true,
					stale: false,
					fetchedAt: Date.now() - 3600_000,
					sourceLabels: ["models.dev", "LiteLLM"],
					failedSources: [],
					entryCount: 6,
					lastError: null,
					refreshFailedAt: null,
					overridesError: null,
				},
			},
			groupBy: "model",
			summary: {
				calls: 1234,
				failed: 21,
				canceled: 3,
				bad: 21,
				success: 1213,
				successRate: 1213 / 1234,
				latencyAvg: 13_500,
				latencyMax: 40_000,
				tokPerSec: 42.5,
				tokPerSecSamples: 1200,
				tokens: {
					input: 1_500_000,
					output: 90_000,
					reasoning: 12_000,
					cacheRead: 900_000,
					cacheCreation: 0,
					total: 2_502_000,
				},
				ttft: { samples: 1201, p50: 6333, p90: 14918, p99: 34_519, avg: 7_900 },
				cost: {
					amount: 12.3456,
					pricedCalls: 1200,
					unknownCalls: 34,
					totalCalls: 1234,
					unknownRatio: 34 / 1234,
					unknownRate: 34 / 1234,
				},
			},
			groups: [
				{
					key: "gemini-3.8-flash-high",
					model: "gemini-3.8-flash-high",
					calls: 900,
					failed: 10,
					canceled: 1,
					bad: 10,
					success: 890,
					successRate: 890 / 900,
					latencyAvg: 12_000,
					latencyMax: 30_000,
					tokPerSec: 1014.9,
					tokPerSecSamples: 890,
					tokens: { input: 1e6, output: 5e4, reasoning: 0, cacheRead: 8e5, cacheCreation: 0, total: 1850000 },
					failRate: 10 / 900,
					ttftP50: 6498,
					ttftP90: 9000,
					ttftSamples: 880,
					cost: {
						amount: 10.5,
						pricedCalls: 890,
						unknownCalls: 10,
						totalCalls: 900,
						unknownRatio: 10 / 900,
						unknownRate: 10 / 900,
					},
				},
			],
		};
	}
	if (url.includes("/api/series")) {
		return {
			ok: true,
			meta: { dbPath: "x", window: "today", client: "all", generatedAt: Date.now(), cached: false },
			hours: [
				{ hour: "2026-10-27T01:00:00", calls: 10, bad: 1, ttftP50: 400, ttftP90: 900, ttftSamples: 9 },
				{ hour: "2026-10-27T02:00:00", calls: 20, bad: 0, ttftP50: 600, ttftP90: 1200, ttftSamples: 20 },
			],
		};
	}
	return {
		ok: true,
		meta: { dbPath: "x", window: "today", client: "all", generatedAt: Date.now(), cached: false },
		events: [
			{
				id: 42,
				timestamp: "2026-10-27T01:02:03+08:00",
				timestampMs: 1,
				model: "gemini-3.8-flash-high",
				provider: "antigravity",
				client: "pi",
				failed: false,
				canceled: false,
				latencyMs: 12_000,
				ttftMs: 4000,
				inputTokens: 1000,
				outputTokens: 500,
				reasoningTokens: 20,
				cacheReadTokens: 800,
				totalTokens: 1500,
				costAmount: 0.0123,
			},
		],
	};
}

// 语言跟随 documentElement.lang（宿主切语言也走这条路）：固定中文以便断言文案
document.documentElement.lang = "zh-CN";

const clientEntry = await import("../../client/entry.mjs");
const { callsChart, ttftChart, dict, fmtCost, fmtMs, costShare, multiMark } = clientEntry;

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
	document.body.innerHTML = "";
	document.getElementById("usage-ledger-styles")?.remove();
});

describe("客户端看板渲染", () => {
	it("渲染指标卡 / 双图 / 模型表 / 事件表", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				state.calls.push({ url: String(url) });
				const body = payloadFor(String(url));
				return { ok: true, status: 200, json: async () => body };
			}),
		);
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => {
			expect(container.querySelector(".cps-cards")).toBeTruthy();
		});
		const html = container.innerHTML;
		// 指标卡：请求数 1.2k、TTFT p50 4.37s、平均 tok/s
		expect(html).toContain("1.2k");
		expect(html).toContain("6.33s");
		expect(html).toContain("43"); // 平均 tok·s⁻¹ 42.5 → 大数值保留整数
		expect(html).toContain("98.3%");
		// 两张手写 SVG 图
		expect(container.querySelectorAll("svg.cps-svg").length).toBe(2);
		expect(container.querySelectorAll("svg.cps-svg rect").length).toBeGreaterThan(0); // 柱状
		expect(container.querySelectorAll("svg.cps-svg polyline").length).toBeGreaterThan(0); // 折线
		// 成本卡 + 价格快照行（来源 / 估算 / 未知价占比）
		expect(html).toContain("≈$12.35");
		expect(html).toContain("价格快照");
		expect(html).toContain("models.dev");
		expect(html).toContain("未知价 34 次");
		// 维度汇总表与事件表
		expect(html).toContain("gemini-3.8-flash-high");
		expect(html).toContain("≈$10.50");
		expect(html).toContain("≈$0.0123");
		expect(html).toContain("01:02:03");
		expect(html).toContain("成功");
		expect(html).toContain("请求数");
		expect(html).toContain("E:\\EasyCLIProxyAPI");
		// 三路接口都打了
		expect(state.calls.map((c) => c.url.split("?")[0]).sort()).toEqual([
			"/plugins-api/usage-ledger/api/events",
			"/plugins-api/usage-ledger/api/series",
			"/plugins-api/usage-ledger/api/summary",
		]);
		cleanup();
		expect(container.childElementCount).toBe(0);
		container.remove();
	});

	it("点击事件行展开 token 拆分，再点收起", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => payloadFor(String(url)) })),
		);
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector("tr[data-rid='42']")).toBeTruthy());
		const row = container.querySelector("tr[data-rid='42']") as HTMLElement;
		row.click();
		await vi.waitFor(() => expect(container.querySelector(".cps-detail")).toBeTruthy());
		expect(container.querySelector(".cps-detail")?.textContent).toContain("1.5k");
		(container.querySelector("tr[data-rid='42']") as HTMLElement).click();
		await vi.waitFor(() => expect(container.querySelector(".cps-detail")).toBeNull());
		cleanup();
		container.remove();
	});

	it("窗口与客户端筛选真的换了查询参数", async () => {
		const fetchMock = vi.fn(async (url: string) => ({
			ok: true,
			status: 200,
			json: async () => payloadFor(String(url)),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-cards")).toBeTruthy());
		fetchMock.mockClear();

		const btn7d = container.querySelector('[data-act="window"][data-value="7d"]') as HTMLElement;
		btn7d.click();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(String(fetchMock.mock.calls[0][0])).toContain("window=7d");

		fetchMock.mockClear();
		const btnPi = container.querySelector('[data-act="client"][data-value="pi"]') as HTMLElement;
		btnPi.click();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(String(fetchMock.mock.calls[0][0])).toContain("client=pi");

		fetchMock.mockClear();
		const btnRoute = container.querySelector('[data-act="groupBy"][data-value="provider"]') as HTMLElement;
		btnRoute.click();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(String(fetchMock.mock.calls[0][0])).toContain("groupBy=provider");

		fetchMock.mockClear();
		const btnPrices = container.querySelector('[data-act="prices"]') as HTMLElement;
		btnPrices.click();
		await vi.waitFor(() =>
			expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/prices/refresh"))).toBe(true),
		);
		cleanup();
		container.remove();
	});

	it("账本缺失：显示明确空态与重试按钮，且不抛错", async () => {
		state.failMode = "no-db";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => payloadFor(String(url)) })),
		);
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-notice")).toBeTruthy());
		const notice = container.querySelector(".cps-notice") as HTMLElement;
		expect(notice.textContent).toContain("未找到账本");
		expect(notice.textContent).toContain("usage.db");
		expect(notice.querySelector("[data-act='refresh']")).toBeTruthy();
		// 结构化空态：已尝试的候选路径要展示出来（否则用户不知道该填什么）
		const tried = notice.querySelector(".cps-tried") as HTMLElement | null;
		expect(tried, "空态必须展示已尝试的候选位置").toBeTruthy();
		const triedText = tried?.textContent ?? "";
		expect(triedText).toContain("CLIProxyAPI");
		expect(triedText).toContain("cliproxyapi.json");
		// 空态下不应有指标卡
		expect(container.querySelector(".cps-cards")).toBeNull();
		cleanup();
		container.remove();
	});

	it("接口网络失败：也走空态文案，不抛异常", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("boom");
			}),
		);
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() =>
			expect((container.querySelector(".cps-notice") as HTMLElement | null)?.textContent ?? "").toContain("boom"),
		);
		cleanup();
		container.remove();
	});
});

describe("图表纯函数（0 点 / 单点 / 极值不出 NaN）", () => {
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
			{ hour: "2026-10-27T00:00:00", calls: 219944, bad: 219944, ttftP50: 0, ttftP90: 0, ttftSamples: 0 },
			{ hour: "2026-10-27T01:00:00", calls: 0, bad: 0, ttftP50: 219944, ttftP90: 219944, ttftSamples: 1 },
		];
		for (const svg of [callsChart(extreme, dict("zh")), ttftChart(extreme, dict("zh"))]) {
			expect(svg).not.toMatch(/NaN|Infinity|undefined/);
		}
		// 全 0 的 ttft 列 → 空态（没有可用样本）
		const zeroTtft = [{ hour: "2026-10-27T02:00:00", calls: 3, bad: 0, ttftP50: 0, ttftP90: 0, ttftSamples: 0 }];
		expect(ttftChart(zeroTtft, dict("zh"))).not.toContain("<svg");
	});

	it("金额与毫秒格式化：未知价是 --，不是 0", () => {
		expect(fmtCost(null, dict("zh"))).toBe("--");
		expect(fmtCost(0, dict("zh"))).toBe("≈$0.0000");
		expect(fmtCost(12.3456, dict("zh"))).toBe("≈$12.35");
		expect(fmtMs(0)).toBe("--");
		expect(fmtMs(null)).toBe("--");
	});
});

describe("R5：未知价占比必须显示且不得伪装成 0", () => {
	it("卡片显示「未知价 N 次（占 X%）」，悬停写明已排除", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => payloadFor(String(url)) })),
		);
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.querySelector(".cps-cards")).toBeTruthy());
		const html = container.innerHTML;
		expect(html).toContain("未知价 34 次（2.8%）");
		expect(html).toContain("已排除未知价请求 34 次（2.8%）");
		// 金额仍带 ≈ 前缀
		expect(html).toContain("≈$12.35");
		cleanup();
		container.remove();
	});

	it("costShare：0 请求是 --、全未知是 100%、旧载荷也能读", () => {
		expect(costShare({ amount: null, pricedCalls: 0, unknownCalls: 0, totalCalls: 0, unknownRatio: null })).toBe("--");
		expect(costShare({ amount: null, pricedCalls: 0, unknownCalls: 5, totalCalls: 5, unknownRatio: 1 })).toBe("100.0%");
		// 只有旧字段（R2 载荷）：自算
		expect(costShare({ amount: 1, pricedCalls: 3, unknownCalls: 1 })).toBe("25.0%");
		// 旧名 unknownRate
		expect(costShare({ amount: 1, pricedCalls: 1, unknownCalls: 1, unknownRate: 0.5 })).toBe("50.0%");
		expect(costShare(null)).toBe("--");
	});

	it("全未知价的汇总：金额是 --（不是 ≈$0）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const body = payloadFor(String(url)) as Record<string, unknown>;
				if (String(url).includes("/api/summary")) {
					(body.summary as Record<string, unknown>).calls = 5;
					(body.summary as Record<string, unknown>).cost = {
						amount: null,
						pricedCalls: 0,
						unknownCalls: 5,
						totalCalls: 5,
						unknownRatio: 1,
						unknownRate: 1,
					};
				}
				return { ok: true, status: 200, json: async () => body };
			}),
		);
		const { container, cleanup } = mountDashboard();
		// 模块级 runtime.state 跨挂载保留（真实宿主只有一个容器），这里等新数据到位
		await vi.waitFor(() => expect(container.innerHTML).toContain("未知价 5 次"));
		const html = container.innerHTML;
		expect(html).not.toContain("≈$0.0000");
		cleanup();
		container.remove();
	});
});

describe("R7：跨源价格分歧必须在金额旁可见", () => {
	it("multiMark：无次数不画、有次数给标签 + 悬停写明次数", () => {
		const d = dict("zh");
		expect(multiMark(null, d)).toBe("");
		expect(multiMark({ multiSourceCalls: 0 }, d)).toBe("");
		const html = multiMark({ multiSourceCalls: 12, multiSourceRatio: 0.5 }, d);
		expect(html).toContain("多源不一致");
		expect(html).toContain("跨源价格分歧：12 次请求");
		// 英文
		expect(multiMark({ multiSourceCalls: 3 }, dict("en"))).toContain("multi-source");
	});

	it("成本卡与分组表都挂标记（悬停写明「跨源价格分歧：N 次请求」）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const body = payloadFor(String(url)) as Record<string, unknown>;
				if (String(url).includes("/api/summary")) {
					(body.summary as Record<string, Record<string, unknown>>).cost = {
						amount: 12.3456,
						pricedCalls: 1234,
						unknownCalls: 0,
						totalCalls: 1234,
						unknownRatio: 0,
						unknownRate: 0,
						multiSourceCalls: 34,
						multiSourceRatio: 34 / 1234,
					};
					const groups = (body as Record<string, Record<string, unknown>[]>).groups;
					(groups[0].cost as Record<string, unknown>).multiSourceCalls = 30;
					(groups[0].cost as Record<string, unknown>).multiSourceRatio = 30 / 900;
				}
				return { ok: true, status: 200, json: async () => body };
			}),
		);
		const { container, cleanup } = mountDashboard();
		await vi.waitFor(() => expect(container.innerHTML).toContain("多源不一致"));
		const html = container.innerHTML;
		expect(html).toContain("跨源价格分歧：34 次请求"); // 汇总卡悬停
		expect(html).toContain("跨源价格分歧：30 次请求"); // 分组行悬停
		expect(container.querySelectorAll(".cps-badge.multi").length).toBeGreaterThanOrEqual(2);
		cleanup();
		container.remove();
	});
});
