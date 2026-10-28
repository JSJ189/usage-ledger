/**
 * 价格表单测（2.1.0）：三源归一、候选枚举、选择规则、估算、缓存与插件接线。
 *
 * 全部离线：价格数据来自 `tests/fixtures/prices/*.json`（按三个真实源的形状裁过），
 * `host.fetch` 一律打桩，**没有任何网络请求**。
 *
 * 口径（与 lib/prices.mjs 顶部注释、brief A 一致）：
 *  - 所有价格在内存里都是 **USD / 1M token**；
 *  - 缺 `cacheRead` / `cacheWrite` 价 → 按 `input` 计，并在 `priceNote` 里标出；
 *  - SDK `cost.total > 0` 优先；否则用估算；两者都无 → `null`（不是 $0）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	PRICE_CACHE_FILE,
	PRICE_TTL_MS,
	applyPricing,
	buildPriceIndex,
	createPriceBook,
	emptySnapshot,
	estimateCost,
	fetchPriceSources,
	hasCorePrices,
	isSnapshotStale,
	modelCandidates,
	normalizeLiteLlm,
	normalizeModelsDev,
	normalizeOpenRouter,
	officialVendorsOf,
	parsePriceOverrides,
	perTokenToPerMillion,
	priceCandidates,
	priceRowId,
	resolvePrice,
	stripProviderPrefix,
	stripVariant,
} from "../../lib/prices.mjs";

const FIXTURES = new URL("../fixtures/prices/", import.meta.url);
const readFixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));

const MODELSDEV = readFixture("modelsdev.json");
const LITELLM = readFixture("litellm.json");
const OPENROUTER = readFixture("openrouter.json");

/** 三源合并后的行 + 索引（大多数用例都用它）。 */
function fixtureIndex() {
	const rows = [
		...normalizeModelsDev(MODELSDEV),
		...normalizeLiteLlm(LITELLM),
		...normalizeOpenRouter(OPENROUTER),
	];
	return { rows, index: buildPriceIndex(rows) };
}

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "ul-prices-"));
}

/** 打桩的 host.fetch：按 URL 返回对应 fixture（未列出的源一律 500）。 */
function stubFetch(map = { modelsdev: MODELSDEV, litellm: LITELLM, openrouter: OPENROUTER }) {
	const urls = {
		modelsdev: "https://models.dev/api.json",
		litellm: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
		openrouter: "https://openrouter.ai/api/v1/models",
	};
	return vi.fn(async (url) => {
		const key = Object.keys(urls).find((k) => urls[k] === url);
		if (!key || !(key in map)) return { ok: false, status: 500, text: async () => "" };
		return { ok: true, status: 200, text: async () => JSON.stringify(map[key]) };
	});
}

describe("单位归一：三个源都归到 USD / 1M token", () => {
	it("per-token → per-1M，去掉浮点尾巴", () => {
		expect(perTokenToPerMillion(2e-6)).toBe(2);
		expect(perTokenToPerMillion("0.000000825")).toBe(0.825);
		// 浮点尾巴必须清掉（8.250000000000001e-7 这类）
		expect(perTokenToPerMillion(8.250000000000001e-7)).toBe(0.825);
		expect(perTokenToPerMillion(undefined)).toBeNull();
		expect(perTokenToPerMillion("abc")).toBeNull();
	});

	it("models.dev 已经是每 1M：原样收下，缺 cost 或缺 output 的行丢弃", () => {
		const rows = normalizeModelsDev(MODELSDEV);
		const gemini = rows.find((r) => r.id === "modelsdev:google/gemini-3.8-flash");
		expect(gemini).toMatchObject({ source: "modelsdev", provider: "google", input: 0.75, output: 3.75, cacheRead: 0.075 });
		expect(gemini.cacheWrite).toBeNull();
		expect(rows.some((r) => r.model === "no-cost-model")).toBe(false);
		expect(rows.some((r) => r.model === "only-input-model")).toBe(false);
	});

	it("LiteLLM 是 per token：×1e6，provider 取 litellm_provider", () => {
		const rows = normalizeLiteLlm(LITELLM);
		const grok = rows.find((r) => r.id === "litellm:xai/grok-4.7");
		expect(grok).toMatchObject({ provider: "xai", input: 2, output: 6, cacheRead: 0.5 });
		const qwen = rows.find((r) => r.id === "litellm:dashscope/qwen3.8-flash");
		expect(qwen).toMatchObject({ provider: "dashscope", input: 0.15, output: 0.47, cacheWrite: 0.2 });
		// 键前缀 `together_ai/` 不算供应商，模型名要剥掉
		expect(rows.some((r) => r.model === "DeepSeek-V4-Flash-0731" && r.provider === "together_ai")).toBe(true);
		// 只有 input 价的行不可计价
		expect(rows.some((r) => r.model === "only-input-model")).toBe(false);
	});

	it("OpenRouter 是 per token 字符串：×1e6，provider 取 id 前缀", () => {
		const rows = normalizeOpenRouter(OPENROUTER);
		const gemini = rows.find((r) => r.id === "openrouter:google/gemini-3.8-flash");
		expect(gemini).toMatchObject({ input: 0.825, output: 4.125, cacheRead: 0.0825 });
		expect(gemini.cacheWrite).toBeNull();
		expect(rows.some((r) => r.model === "no-output-model")).toBe(false);
	});

	it("三源合计能建出索引，行 id 稳定可读", () => {
		const { rows, index } = fixtureIndex();
		expect(rows.length).toBeGreaterThan(20);
		expect(index.size).toBeGreaterThan(8);
		expect(priceRowId("modelsdev", "Alibaba-CN", "qwen3.8-flash")).toBe("modelsdev:alibaba-cn/qwen3.8-flash");
		expect(hasCorePrices({ input: 0, output: 0 })).toBe(true);
		expect(hasCorePrices({ input: 1, output: null })).toBe(false);
	});
});

describe("名称归一与官方厂商规则", () => {
	it("剥 provider 前缀与变体后缀（只剥一层数字尾号）", () => {
		expect(stripProviderPrefix("google/gemini-3.8-flash")).toBe("gemini-3.8-flash");
		expect(stripProviderPrefix("google/gemini-3.8-flash:batch")).toBe("gemini-3.8-flash");
		expect(stripVariant("gemini-3.8-flash-high")).toBe("gemini-3.8-flash");
		expect(stripVariant("Qwen3.8-Flash-Next")).toBe("Qwen3.8-Flash");
		expect(stripVariant("Deepseek-V4.1-Flash-1017")).toBe("Deepseek-V4.1-Flash");
		// 不能把模型主版本号当后缀剥掉
		expect(stripVariant("grok-4.7")).toBe("grok-4.7");
	});

	it("候选列表去重、保序（原样 → 变体 → 前缀）", () => {
		const list = modelCandidates("Deepseek-V4.1-Flash-1017");
		expect(list[0]).toBe("deepseek-v4.1-flash-1017");
		expect(list).toContain("deepseek-v4.1-flash");
		const prefixed = modelCandidates("alibaba-cn/qwen3.8-flash");
		expect(prefixed).toContain("qwen3.8-flash");
	});

	it("官方厂商前缀规则（只表达「谁是官方」，不含价格）", () => {
		expect(officialVendorsOf("Qwen3.8-Flash-Next")).toEqual(["alibaba-cn", "alibaba"]);
		expect(officialVendorsOf("gemini-3.8-flash-high")).toEqual(["google"]);
		expect(officialVendorsOf("grok-4.7")).toEqual(["xai"]);
		expect(officialVendorsOf("mimo-v2.6-pro")).toEqual(["xiaomi"]);
		expect(officialVendorsOf("DeepSeek-V4-Flash-0731")).toEqual(["deepseek", "alibaba-cn", "alibaba"]);
		expect(officialVendorsOf("mystery-model-1")).toEqual([]);
	});
});

describe("resolvePrice：已知候选必须命中（对照 brief A7）", () => {
	const { index } = fixtureIndex();
	const cases = [
		["gemini-3.8-flash-high", "modelsdev:google/gemini-3.8-flash", [0.75, 3.75, 0.075, null]],
		["grok-4.7", "modelsdev:xai/grok-4.7", [2, 6, 0.5, null]],
		["Qwen3.8-Flash-Next", "modelsdev:alibaba-cn/qwen3.8-flash", [0.11875, 0.40073, 0.014844, 0.185547]],
		["Deepseek-V4.1-Flash-1017", "modelsdev:alibaba-cn/deepseek-v4.1-flash", [0.29754, 1.19015, 0.01488, null]],
		["DeepSeek-V4-Flash-0731", "modelsdev:alibaba/deepseek-v4-flash-0731", [0.44, 1.32, 0.088, null]],
		["mimo-v2.6-pro", "modelsdev:xiaomi/mimo-v2.6-pro", [0.435, 0.87, 0.0036, null]],
	];
	for (const [model, priceId, prices] of cases) {
		it(`${model} → ${priceId}`, () => {
			const resolved = resolvePrice(model, { index });
			expect(resolved.via).toBe("official");
			expect(resolved.price.id).toBe(priceId);
			expect([
				resolved.price.input,
				resolved.price.output,
				resolved.price.cacheRead,
				resolved.price.cacheWrite,
			]).toEqual(prices);
			// 候选必须可枚举（多来源差异要让用户看得见）
			expect(resolved.candidates.length).toBeGreaterThanOrEqual(2);
		});
	}

	it("没命中的模型给 null（看板显示 --，绝不当 0）", () => {
		const resolved = resolvePrice("totally-unknown-model", { index });
		expect(resolved.price).toBeNull();
		expect(resolved.via).toBeNull();
		expect(resolved.candidates).toEqual([]);
	});
});

describe("候选枚举顺序（brief A6：候选必须可枚举）", () => {
	const { index } = fixtureIndex();

	it("官方行在前、其余按源优先级（models.dev > LiteLLM > OpenRouter）", () => {
		const resolved = resolvePrice("DeepSeek-V4-Flash-0731", { index });
		const ids = resolved.candidates.map((c) => c.id);
		expect(ids[0]).toBe("modelsdev:alibaba/deepseek-v4-flash-0731");
		// 第二层（剥掉 -0731）的行也保留，供用户对照 3 倍差异
		expect(ids).toContain("modelsdev:deepseek/deepseek-v4-flash");
		const litellmAt = ids.indexOf("litellm:together_ai/DeepSeek-V4-Flash-0731");
		const openrouterAt = ids.indexOf("openrouter:deepseek/deepseek-v4-flash-0731");
		expect(litellmAt).toBeGreaterThan(0);
		expect(openrouterAt).toBeGreaterThan(0);
		expect(ids.indexOf("openrouter:deepseek/deepseek-v4-flash-0731")).toBeLessThan(
			ids.indexOf("openrouter:deepseek/deepseek-v4-flash"),
		);
		expect(resolved.candidates.every((c) => typeof c.official === "boolean")).toBe(true);
	});

	it("用户覆盖排在最前，且直接被选中（via=override）", () => {
		const overrides = parsePriceOverrides({
			"DeepSeek-V4-Flash-0731": { input: 0.2, output: 0.5, cacheRead: 0.02 },
		}).rows;
		const resolved = resolvePrice("DeepSeek-V4-Flash-0731", { index, overrides });
		expect(resolved.via).toBe("override");
		expect(resolved.price.id).toBe("override:DeepSeek-V4-Flash-0731");
		expect(resolved.candidates[0].source).toBe("override");
		// 原生候选仍然保留在后面（用户能看到官方行长什么样）
		expect(resolved.candidates.length).toBeGreaterThan(1);
	});

	it("没有官方行 → 取多来源中位数（按 input 升序的中位行）", () => {
		const resolved = resolvePrice("mystery-model-1", { index });
		expect(resolved.via).toBe("median");
		const inputs = resolved.candidates.map((c) => c.input).sort((a, b) => a - b);
		expect(inputs).toEqual([0.25, 0.3, 0.35]);
		expect(resolved.price.input).toBe(0.3);
	});
});

describe("estimateCost：计价口径", () => {
	const { index } = fixtureIndex();
	const priceOf = (model) => resolvePrice(model, { index }).price;

	it("prompt = input + cacheRead + cacheWrite，四项价分别乘", () => {
		const price = priceOf("Qwen3.8-Flash-Next");
		const est = estimateCost(price, {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 1_000_000,
		});
		expect(est.promptTokens).toBe(3_000_000);
		// 0.11875 + 0.40073 + 0.014844 + 0.185547
		expect(est.usd).toBeCloseTo(0.719871, 6);
		expect(est.note).toBe("");
	});

	it("缺 cacheRead 价 → 按 input 计，并标 cacheRead≈input", () => {
		const est = estimateCost(
			{ input: 2, output: 6, cacheRead: null, cacheWrite: null },
			{ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 200 },
		);
		// https://www 手算：(1000*2 + 100*6 + 500*2 + 200*2) / 1e6 = 0.004
		expect(est.usd).toBeCloseTo(0.004, 9);
		expect(est.note).toContain("cacheRead≈input");
		expect(est.note).toContain("cacheWrite≈input");
	});

	it("没有 token 字段（live 记录 / 老会话）→ null，不是 $0", () => {
		expect(estimateCost(priceOf("grok-4.7"), {})).toBeNull();
		expect(estimateCost(priceOf("grok-4.7"), { inputTokens: null, outputTokens: null })).toBeNull();
		expect(estimateCost(null, { inputTokens: 10, outputTokens: 10 })).toBeNull();
		expect(estimateCost({ input: null, output: 1 }, { inputTokens: 10 })).toBeNull();
	});

	it("0 token 是合法值（有 usage 只是全 0）→ 0 美元而不是 null", () => {
		const est = estimateCost(priceOf("grok-4.7"), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
		expect(est.usd).toBe(0);
	});
});

describe("applyPricing：记录级成本字段语义（brief A5）", () => {
	const { index } = fixtureIndex();
	const price = resolvePrice("gemini-3.8-flash-high", { index }).price;
	const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

	it("SDK 有 >0 的成本 → 用 SDK，但估算值也保留下来对照", () => {
		const out = applyPricing({ model: "gemini-3.8-flash-high", costUsd: 0.9, ...usage }, price);
		expect(out.costUsd).toBe(0.9);
		expect(out.costSource).toBe("sdk");
		expect(out.costEstimateUsd).toBeCloseTo(0.75, 9);
		expect(out.priceId).toBe("modelsdev:google/gemini-3.8-flash");
	});

	it("SDK 成本是 0（网关没回填）→ 用估算", () => {
		const out = applyPricing({ model: "gemini-3.8-flash-high", costUsd: 0, ...usage }, price);
		expect(out.costUsd).toBeCloseTo(0.75, 9);
		expect(out.costSource).toBe("estimate");
		expect(out.costEstimateUsd).toBeCloseTo(0.75, 9);
	});

	it("SDK 与估算都没有 → costUsd / costSource 都是 null（不是 $0）", () => {
		const out = applyPricing({ model: "unknown-model", costUsd: null, ...usage }, null);
		expect(out.costUsd).toBeNull();
		expect(out.costSource).toBeNull();
		expect(out.costEstimateUsd).toBeNull();
		expect(out.priceId).toBeNull();
	});

	it("不修改传入的记录（账本里的对象必须保持原样）", () => {
		const record = { model: "gemini-3.8-flash-high", costUsd: 0, ...usage };
		const out = applyPricing(record, price);
		expect(record.costUsd).toBe(0);
		expect(record.costSource).toBeUndefined();
		expect(out).not.toBe(record);
	});
});

describe("parsePriceOverrides：设置项解析", () => {
	it("对象与 JSON 字符串都收，结构是四项价（USD / 1M）", () => {
		const fromObject = parsePriceOverrides({ "my-model": { input: 1, output: 2, cacheRead: 0.1 } });
		expect(fromObject.errors).toEqual([]);
		expect(fromObject.rows[0]).toMatchObject({
			id: "override:my-model",
			source: "override",
			input: 1,
			output: 2,
			cacheRead: 0.1,
			cacheWrite: null,
		});
		const fromText = parsePriceOverrides('{"my-model":{"input":1,"output":2}}');
		expect(fromText.rows.length).toBe(1);
	});

	it("非法 JSON / 缺 output 价 → 记 errors 并跳过，不抛错", () => {
		expect(parsePriceOverrides("{not json").errors[0]).toContain("JSON");
		const bad = parsePriceOverrides({ a: { input: 1 }, b: "x", c: { input: 1, output: 2 } });
		expect(bad.rows.map((r) => r.model)).toEqual(["c"]);
		expect(bad.errors.length).toBe(2);
		expect(parsePriceOverrides("").rows).toEqual([]);
	});
});

describe("fetchPriceSources：失败互不影响", () => {
	it("三源都成功 → 全部 ok 且有行数", async () => {
		const { entries, sources } = await fetchPriceSources(stubFetch());
		expect(sources.map((s) => s.ok)).toEqual([true, true, true]);
		expect(sources.every((s) => s.count > 0)).toBe(true);
		expect(entries.length).toBeGreaterThan(20);
	});

	it("models.dev 挂了：只标这一源 ok:false，另两源照常", async () => {
		const { entries, sources } = await fetchPriceSources(stubFetch({ litellm: LITELLM, openrouter: OPENROUTER }));
		expect(sources.find((s) => s.id === "modelsdev")).toMatchObject({ ok: false });
		expect(sources.find((s) => s.id === "litellm").ok).toBe(true);
		expect(sources.find((s) => s.id === "openrouter").ok).toBe(true);
		expect(entries.some((e) => e.source === "litellm")).toBe(true);
	});

	it("fetch 抛错 / 返回非 200 / 返回坏 JSON 都不抛出去", async () => {
		const throwing = vi.fn(async () => {
			throw new Error("boom");
		});
		const res = await fetchPriceSources(throwing);
		expect(res.entries).toEqual([]);
		expect(res.sources.every((s) => s.ok === false && s.error)).toBe(true);

		const badJson = vi.fn(async () => ({ ok: true, status: 200, text: async () => "{oops" }));
		const res2 = await fetchPriceSources(badJson);
		expect(res2.sources.every((s) => s.ok === false)).toBe(true);
	});
});

describe("createPriceBook：缓存、TTL 与刷新", () => {
	it("没有缓存 → status 标记不可用且过期", () => {
		const dir = tmpDir();
		const book = createPriceBook({ dir, fetch: stubFetch() });
		const status = book.status();
		expect(status.available).toBe(false);
		expect(status.stale).toBe(true);
		expect(status.entries).toBe(0);
	});

	it("刷新成功后写 prices.json，重新 load 能读回来（读缓存不联网）", async () => {
		const dir = tmpDir();
		const fetchImpl = stubFetch();
		const book = createPriceBook({ dir, fetch: fetchImpl });
		book.load();
		await book.refresh();
		expect(book.status().available).toBe(true);
		expect(book.status().entries).toBeGreaterThan(20);

		const again = createPriceBook({ dir, fetch: vi.fn(async () => ({ ok: false, status: 500 })) });
		again.load();
		expect(again.status().entries).toBe(book.status().entries);
		expect(again.resolve("grok-4.7").price.id).toBe("modelsdev:xai/grok-4.7");
		// 读缓存不触发任何网络请求
		expect(fetchImpl).toHaveBeenCalled();
		expect(again.status().stale).toBe(false);
	});

	it("TTL 到期标记 stale；坏的缓存文件按空快照处理", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, PRICE_CACHE_FILE), '{"fetchedAt": 1, "entries": "nope"}', "utf8");
		const book = createPriceBook({ dir });
		book.load();
		expect(book.status().entries).toBe(0);
		expect(isSnapshotStale(emptySnapshot(), Date.now())).toBe(true);
		expect(isSnapshotStale({ fetchedAt: 1000 }, 1000 + PRICE_TTL_MS - 1)).toBe(false);
		expect(isSnapshotStale({ fetchedAt: 1000 }, 1000 + PRICE_TTL_MS)).toBe(true);
	});

	it("刷新全部失败：保留旧快照，只更新 lastError（接口不能 500）", async () => {
		const dir = tmpDir();
		const book = createPriceBook({ dir, fetch: stubFetch() });
		await book.refresh();
		const before = book.status().entries;
		const failing = createPriceBook({ dir, fetch: vi.fn(async () => ({ ok: false, status: 503 })) });
		failing.load();
		await failing.refresh();
		expect(failing.status().entries).toBe(before);
		expect(failing.status().lastError).toBeTruthy();
		expect(failing.status().available).toBe(true);
	});

	it("resolve 按模型记忆化：同一模型返回同一个对象，invalidate 后重建", async () => {
		const dir = tmpDir();
		const book = createPriceBook({ dir, fetch: stubFetch() });
		await book.refresh();
		const a = book.resolve("grok-4.7");
		const b = book.resolve("grok-4.7");
		expect(a).toBe(b);
		book.invalidate();
		expect(book.resolve("grok-4.7")).not.toBe(a);
	});

	it("price() 直接把记录补上计价字段（供 /api 聚合用）", async () => {
		const dir = tmpDir();
		const book = createPriceBook({ dir, fetch: stubFetch() });
		await book.refresh();
		const out = book.price({ model: "Qwen3.8-Flash-Next", costUsd: 0, inputTokens: 1_000_000, outputTokens: 0 });
		expect(out.costSource).toBe("estimate");
		expect(out.costUsd).toBeCloseTo(0.11875, 9);
		expect(out.priceId).toBe("modelsdev:alibaba-cn/qwen3.8-flash");
	});

	it("设置改了但没显式 invalidate：覆盖配置也会立刻生效（不缓存脏值）", async () => {
		const dir = tmpDir();
		const settings = { priceOverrides: "" };
		const book = createPriceBook({ dir, fetch: stubFetch(), getSettings: () => settings });
		await book.refresh();
		expect(book.resolve("gemini-3.8-flash-high").via).toBe("official");
		settings.priceOverrides = JSON.stringify({ "gemini-3.8-flash-high": { input: 1, output: 2 } });
		expect(book.resolve("gemini-3.8-flash-high").via).toBe("override");
		settings.priceOverrides = "";
		expect(book.resolve("gemini-3.8-flash-high").via).toBe("official");
	});

	it("priceOverrides 从设置读取：改动设置后取新价", async () => {
		const dir = tmpDir();
		const settings = { priceOverrides: "" };
		const book = createPriceBook({ dir, fetch: stubFetch(), getSettings: () => settings });
		await book.refresh();
		expect(book.resolve("grok-4.7").via).toBe("official");
		settings.priceOverrides = JSON.stringify({ "grok-4.7": { input: 9, output: 9 } });
		book.invalidate();
		const after = book.resolve("grok-4.7");
		expect(after.via).toBe("override");
		expect(after.price.input).toBe(9);
		expect(book.status().overridesError).toBeNull();
		book.invalidate();
		settings.priceOverrides = "{bad json";
		book.invalidate();
		expect(book.status().overridesError).toContain("JSON");
	});
});

describe("大小写不敏感（网关给的名字千奇百怪）", () => {
	it("候选筛选不会因为大小写而漏（Deepseek / deepseek 都命中）", () => {
		const { index } = fixtureIndex();
		expect(resolvePrice("deepseek-v4.1-flash", { index }).price).toBeTruthy();
		expect(resolvePrice("DEEPSEEK-V4.1-FLASH", { index }).price).toBeTruthy();
		expect(priceCandidates("DeepSeek-V4.1-Flash", { index }).length).toBeGreaterThanOrEqual(2);
	});
});
