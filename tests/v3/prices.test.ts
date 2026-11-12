/**
 * v3 价格层（`lib/v3/prices.mjs`）：单位换算、缺价回退、SDK 与估算的边界。
 *
 * 三个坑（v2 都踩过）：
 *  1. LiteLLM / OpenRouter 的价格是 **per token**，少乘 1e6 就整张表缩成 1/1e6；
 *  2. 缺 `cacheRead` 价时必须按 `input` 价计，**不能当 0**（否则缓存越大成本越低）；
 *  3. `cost.total = 0` 是「上游没给价」，不能当成 SDK 真值（金额会变成 $0）。
 */
import { describe, expect, it } from "vitest";
import {
	applyPricing,
	buildPriceIndex,
	estimateCost,
	normalizeLiteLlm,
	normalizeModelsDev,
	normalizeOpenRouter,
	perTokenToPerMillion,
	resolvePrice,
} from "../../lib/v3/prices.mjs";

describe("prices：per-token → per-1M 单位换算", () => {
	it("1e-7 → 0.1；字符串形式同样处理；空值不变成 0", () => {
		expect(perTokenToPerMillion(1e-7)).toBe(0.1);
		expect(perTokenToPerMillion("0.000000825")).toBe(0.825);
		expect(perTokenToPerMillion(0)).toBe(0);
		expect(perTokenToPerMillion(null)).toBeNull();
		expect(perTokenToPerMillion("")).toBeNull();
	});

	it("三个源归一到同一单位：models.dev（本来就是 1M）/ LiteLLM（per token）/ OpenRouter（per token 字符串）", () => {
		const modelsdev = normalizeModelsDev({
			google: { models: { "gemini-3.8-flash": { cost: { input: 0.1, output: 0.4, cache_read: 0.025 } } } },
		});
		const litellm = normalizeLiteLlm({
			"gemini/gemini-3.8-flash": {
				litellm_provider: "vertex",
				input_cost_per_token: 1e-7,
				output_cost_per_token: 4e-7,
				cache_read_input_token_cost: 2.5e-8,
				cache_creation_input_token_cost: 1.25e-7,
			},
		});
		const openrouter = normalizeOpenRouter({
			data: [
				{
					id: "google/gemini-3.8-flash",
					pricing: { prompt: "0.0000001", completion: "0.0000004", input_cache_read: "0.000000025" },
				},
			],
		});

		expect(modelsdev.length).toBe(1);
		expect(litellm.length).toBe(1);
		expect(openrouter.length).toBe(1);
		// 三源同一模型 → 输入/输出/缓存读三项数值必须一致
		for (const row of [modelsdev[0], litellm[0], openrouter[0]]) {
			expect(row.input).toBe(0.1);
			expect(row.output).toBe(0.4);
			expect(row.cacheRead).toBe(0.025);
		}
		expect(litellm[0].provider).toBe("vertex"); // 供应商看 litellm_provider，不看键前缀
		expect(litellm[0].cacheWrite).toBe(0.125);
		expect(openrouter[0].source).toBe("openrouter");
		expect(modelsdev[0].id).toBe("modelsdev:google/gemini-3.8-flash");
	});

	it("缺 input/output 价的行不算可计价（缺价绝不是 0 价）", () => {
		const rows = normalizeModelsDev({ acme: { models: { x: { cost: { output: 1 } } } } });
		expect(rows).toEqual([]);
	});
});

describe("prices：解析与优先级", () => {
	const rows = [
		...normalizeModelsDev({
			google: { models: { "gemini-3.8-flash": { cost: { input: 0.1, output: 0.4, cache_read: 0.025 } } } },
		}),
		...normalizeLiteLlm({
			"gemini/gemini-3.8-flash": { litellm_provider: "vertex", input_cost_per_token: 2e-7, output_cost_per_token: 8e-7 },
		}),
		...normalizeOpenRouter({ data: [{ id: "x-ai/gemini-3.8-flash", pricing: { prompt: "0.0000003", completion: "0.0000012" } }] }),
	];

	it("官方行优先于第三方：chosen 是 models.dev 的官方价，不是 median", () => {
		const table = buildPriceIndex(rows, { version: 3 });
		const exact = resolvePrice(table, "gemini-3.8-flash", { version: 3 });
		expect(exact).not.toBeNull();
		expect(exact.priceId).toBe("modelsdev:google/gemini-3.8-flash");
		expect(exact.promptPerM).toBe(0.1);
		expect(exact.version).toBe(3);
		expect(exact.note).toBe("official-exact");

		// 带变体后缀的账本名（`-high`）剥一层后命中同一个官方行，并标出匹配层级
		const variant = resolvePrice(table, "gemini-3.8-flash-high", { version: 3 });
		expect(variant.priceId).toBe("modelsdev:google/gemini-3.8-flash");
		expect(variant.promptPerM).toBe(0.1);
		expect(variant.note).toBe("official-variant:1");
	});

	it("用户覆盖压过所有源（只认账本里的原名，不做模糊匹配）", () => {
		const table = buildPriceIndex(rows, { version: 4 });
		const price = resolvePrice(table, "gemini-3.8-flash", {
			version: 4,
			overrides: { "gemini-3.8-flash": { input: 1, output: 2 } },
		});
		expect(price.source).toBe("override");
		expect(price.promptPerM).toBe(1);
		expect(price.outputPerM).toBe(2);

		// 写的是别的名字（这里带网关前缀）→ 不匹配覆盖行，仍走官方价
		const other = resolvePrice(table, "cliproxyapi/gemini-3.8-flash", {
			version: 4,
			overrides: { "gemini-3.8-flash": { input: 1, output: 2 } },
		});
		expect(other.source).toBe("modelsdev");
		expect(other.promptPerM).toBe(0.1);
	});

	it("表里没有这个模型 → null（不瞎给 median）", () => {
		const table = buildPriceIndex(rows, { version: 3 });
		expect(resolvePrice(table, "totally-unknown-model", { version: 3 })).toBeNull();
	});
});

describe("prices：缺 cacheRead 价按 input 计，不是 0", () => {
	it("1M cacheRead token：无 cacheRead 价 → $1（= input 价），有价 → $0.25", () => {
		const noCachePrice = estimateCost({
			price: { promptPerM: 1, outputPerM: 2, cacheReadPerM: null, cacheWritePerM: null },
			inTok: 0,
			outTok: 0,
			cacheRead: 1_000_000,
			cacheWrite: 0,
		});
		expect(noCachePrice.usd).toBe(1);
		expect(noCachePrice.note).toContain("cacheRead≈input");

		const withCachePrice = estimateCost({
			price: { promptPerM: 1, outputPerM: 2, cacheReadPerM: 0.25, cacheWritePerM: 1 },
			inTok: 0,
			outTok: 0,
			cacheRead: 1_000_000,
			cacheWrite: 0,
		});
		expect(withCachePrice.usd).toBe(0.25);
		expect(withCachePrice.note).toBe("");
		expect(withCachePrice.usd).not.toBe(0);
	});

	it("四项 token 全缺 → usd:null（未采集不等于 $0）", () => {
		const none = estimateCost({ price: { promptPerM: 1, outputPerM: 2 }, inTok: null, outTok: null });
		expect(none.usd).toBeNull();
		expect(none.note).toBe("no-usage");
		expect(estimateCost({ price: null, inTok: 10 }).note).toBe("unpriced");
	});

	it("常规口径：prompt/out 各 1M → $1 + $2", () => {
		const { usd } = estimateCost({ price: { promptPerM: 1, outputPerM: 2 }, inTok: 1_000_000, outTok: 1_000_000 });
		expect(usd).toBe(3);
	});
});

describe("prices：SDK 与估算的边界", () => {
	const price = { priceId: "modelsdev:google/gemini-3.8-flash", version: 3, promptPerM: 1, outputPerM: 2 };

	it("costSdk > 0 → 只认 SDK，不再写估算（同一笔账不数两次）", () => {
		const patch = applyPricing({ costSdk: 0.5, inTok: 1_000_000 }, price);
		expect(patch.costSource).toBe("sdk");
		expect(patch.costEst).toBeNull();
		expect(patch.priceId).toBeNull();
	});

	it("costSdk = 0 且没声明 sdk → 走估算（0 不是真值）", () => {
		const patch = applyPricing({ costSdk: 0, costSource: null, inTok: 1_000_000 }, price);
		expect(patch.costSource).toBe("estimate");
		expect(patch.costEst).toBe(1);
		expect(patch.priceId).toBe(price.priceId);
	});

	it("costSdk = 0 但 costSource='sdk'（采集到的真 0 价）→ 保持 sdk", () => {
		const patch = applyPricing({ costSdk: 0, costSource: "sdk" }, price);
		expect(patch.costSource).toBe("sdk");
		expect(patch.costEst).toBeNull();
	});

	it("没有价格行 → unpriced（有调用无价，金额里排除并标下限）", () => {
		const patch = applyPricing({ costSdk: null, inTok: 1000 }, null);
		expect(patch.costSource).toBe("unpriced");
		expect(patch.costEst).toBeNull();
	});
});
