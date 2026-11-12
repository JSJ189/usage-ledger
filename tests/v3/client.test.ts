/**
 * v3 客户端看板挂载测试（jsdom）：
 *  - 首屏只请求 `/plugins-api/usage-ledger/api/v3/overview` 与 `/plugins-api/usage-ledger/api/v3/import/status`；
 *  - 点击「7d」范围按钮后，KPI 文本随之更新（不同 range 返回不同 calls）且 `location.hash` 含 `range=7d`。
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { JSDOM } = require("jsdom");

const GLOBAL_KEYS = [
	"window",
	"document",
	"location",
	"history",
	"navigator",
	"MouseEvent",
	"localStorage",
	"Element",
	"HTMLElement",
	"Node",
	"Event",
	"MutationObserver",
	"fetch",
] as const;

function makeOverviewPayload(rangeKey: string, calls: number) {
	const now = Date.UTC(2026, 10, 12, 10, 0, 0);
	const span = rangeKey === "7d" ? 7 * 86_400_000 : 86_400_000;
	const fromMs = now - span;
	return {
		ok: true,
		version: rangeKey === "7d" ? 2 : 1,
		range: {
			key: rangeKey,
			fromMs,
			toMs: now,
			gran: "1h",
			granAuto: true,
			timezone: "UTC+08:00",
			tzLabel: "Asia/Shanghai",
		},
		freshness: {
			lastIngestAt: now,
			lastImportAt: now,
			ledgerRecords: calls,
			importing: false,
			coverage: { imported: 1, eligible: 1 },
			degraded: null,
		},
		kpi: {
			calls,
			ok: calls - 1,
			error: 1,
			incomplete: 0,
			aborted: 0,
			answered: calls,
			successRate: (calls - 1) / calls,
			ttft: { p50: 420, p90: 980, p99: 1500, samples: calls, coverage: 1, approx: true },
			e2e: { p50: 1200, p90: 3000, samples: calls, approx: true },
			tokPerSec: 40,
			tokPerSecMean: 42,
			tokPerSecSamples: calls,
			cacheHitRate: 0.5,
			cacheHitSamples: calls,
			tokens: { input: 1000, output: 500, cacheRead: 1000, cacheWrite: 0, total: 2500 },
			cost: {
				amount: calls * 0.01,
				sdkAmount: calls * 0.01,
				estimatedAmount: 0,
				unpricedCalls: 0,
				estimateShare: 0,
				isLowerBound: false,
			},
		},
		series: [
			{
				t: fromMs,
				calls: Math.floor(calls / 2),
				ok: Math.floor(calls / 2),
				error: 0,
				incomplete: 0,
				cost: 0.05,
				ttftP50: 400,
				ttftP90: 900,
				e2eP50: 1100,
				outTok: 200,
			},
			{
				t: fromMs + 3_600_000,
				calls: calls - Math.floor(calls / 2),
				ok: calls - Math.floor(calls / 2) - 1,
				error: 1,
				incomplete: 0,
				cost: 0.07,
				ttftP50: 440,
				ttftP90: 980,
				e2eP50: 1300,
				outTok: 300,
			},
		],
		topModels: [{ name: "m1", calls, share: 1, cost: calls * 0.01, tokPerSec: 40, ttftP50: 420, errorRate: 1 / calls }],
		topProjects: [
			{ name: "JK项目/知识库", calls, share: 1, cost: calls * 0.01, tokPerSec: 40, ttftP50: 420, errorRate: 1 / calls },
		],
		filters: {
			models: ["m1"],
			providers: ["p1"],
			projects: ["JK项目/知识库"],
			statuses: ["ok", "provider_error"],
		},
		prices: { version: 1, fetchedAt: now, stale: false, overridesError: null },
	};
}

async function flushMicrotasks(rounds = 8) {
	for (let i = 0; i < rounds; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("client/entry.mjs：jsdom 挂载与范围切换", () => {
	const saved = new Map<string, PropertyDescriptor | undefined>();
	let dom: InstanceType<typeof JSDOM> | null = null;
	let cleanup: (() => void) | null = null;

	afterEach(() => {
		if (cleanup) {
			try {
				cleanup();
			} catch {
				/* ignore */
			}
			cleanup = null;
		}
		if (dom) {
			dom.window.close();
			dom = null;
		}
		for (const key of GLOBAL_KEYS) {
			const prev = saved.get(key);
			if (prev) Object.defineProperty(globalThis, key, prev);
			else delete (globalThis as Record<string, unknown>)[key];
		}
		saved.clear();
	});

	it("首屏只请求 overview 与 import/status；点「7d」后 KPI 文本变化且 location.hash 含 range=7d", async () => {
		dom = new JSDOM('<!doctype html><html lang="zh"><body><div id="app"></div></body></html>', {
			url: "http://localhost/#ul",
		});
		const w = dom.window;

		const requestedUrls: string[] = [];
		const stubFetch = async (input: string | URL) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes("/plugins-api/usage-ledger/api/v3/import/status")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						ok: true,
						status: {
							phase: "idle",
							filesTotal: 0,
							filesDone: 0,
							rowsTotal: 0,
							bytesRead: 0,
							etaMs: null,
							lastError: null,
							workerAlive: false,
						},
					}),
				};
			}
			if (url.includes("/plugins-api/usage-ledger/api/v3/overview")) {
				const parsed = new URL(url, "http://localhost");
				const range = parsed.searchParams.get("range") ?? "today";
				const calls = range === "7d" ? 345 : 12;
				return {
					ok: true,
					status: 200,
					json: async () => makeOverviewPayload(range, calls),
				};
			}
			throw new Error(`未预期的请求：${url}`);
		};

		const bindings: Record<string, unknown> = {
			window: w,
			document: w.document,
			location: w.location,
			history: w.history,
			navigator: w.navigator,
			MouseEvent: w.MouseEvent,
			localStorage: w.localStorage,
			Element: w.Element,
			HTMLElement: w.HTMLElement,
			Node: w.Node,
			Event: w.Event,
			MutationObserver: w.MutationObserver,
			fetch: stubFetch,
		};

		for (const key of GLOBAL_KEYS) {
			saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, {
				value: bindings[key],
				configurable: true,
				writable: true,
			});
		}

		const { default: entry } = await import("../../client/entry.mjs");
		const container = w.document.getElementById("app")!;
		cleanup = entry.mount(container);

		await flushMicrotasks();

		// 首屏只发 1 个 overview + 1 个 import/status（不发 records）
		expect(requestedUrls.length).toBe(2);
		expect(requestedUrls.some((u) => u.startsWith("/plugins-api/usage-ledger/api/v3/overview?range=today"))).toBe(true);
		expect(requestedUrls.some((u) => u === "/plugins-api/usage-ledger/api/v3/import/status")).toBe(true);
		expect(requestedUrls.some((u) => u.includes("/api/v3/records"))).toBe(false);

		const kpiCallsEl = container.querySelector('[data-k="kpi.calls.value"]')!;
		const initialCallsText = kpiCallsEl.textContent;
		expect(initialCallsText).toBe("12");

		// 点击「7d」tab
		const tab7d = container.querySelector('[data-act="range"][data-value="7d"]')!;
		expect(tab7d).not.toBeNull();
		tab7d.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

		await flushMicrotasks();

		expect(w.location.hash).toContain("range=7d");
		expect(requestedUrls.some((u) => u.startsWith("/plugins-api/usage-ledger/api/v3/overview?range=7d"))).toBe(true);

		const updatedCallsText = kpiCallsEl.textContent;
		expect(updatedCallsText).toBe("345");
		expect(updatedCallsText).not.toBe(initialCallsText);
	});
});
