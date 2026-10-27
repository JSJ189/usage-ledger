/**
 * usage-ledger 价目表单测（R2/R3 验收）
 *
 * 全部离线：三个源用 `tests/fixtures/cliproxy-prices/*.json`（从真实响应裁剪，单文件 <32KB），
 * 绝不联网。覆盖：
 *  - per-token → per-1M 换算（LiteLLM / OpenRouter）、models.dev 本身就是 per-1M；
 *  - effort 后缀剥离（`gemini-3.8-flash-high` → 基名），且 `grok-4.7` 的 `-4.7` 不被误剥；
 *  - provider 映射（antigravity → google-vertex/google、xai → xai）；
 *  - tiers 阈值（context > 200000 走分段价）；
 *  - cost 缺失条目的回退（azure grok-4.7 无 cost）；
 *  - 未知价绝不冒充 0；
 *  - 快照缓存：TTL 命中/过期、刷新失败保留旧快照并标时间；
 *  - 仓库红线：不提交大体积价格原文（>32KB）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	PRICE_SOURCES,
	PRICE_STORAGE_KEY,
	PRICE_TTL_MS,
	billableOutput,
	buildPriceIndex,
	computeRowCost,
	createPriceBook,
	describeSnapshot,
	filterEntriesForModels,
	indexFromSnapshot,
	isSnapshotStale,
	matchPrice,
	modelCandidates,
	normalizeLiteLlm,
	normalizeModelsDev,
	normalizeOpenRouter,
	parsePriceOverrides,
	perTokenToPerMillion,
	pickTier,
	pricingProviderCandidates,
	snapshotCoversModels,
	stripEffort,
	stripProviderPrefix,
} from "../../lib/prices.mjs";

const HERE = fileURLToPath(new URL("./", import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "cliproxy-prices");

function fixture(name: string) {
	return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

const MODELSDEV = fixture("modelsdev");
const LITELLM = fixture("litellm");
const OPENROUTER = fixture("openrouter");

/** 账本里真实出现过的模型（体积过滤要用同一批）。 */
const LEDGER_MODELS = [
	"gemini-3.8-flash-high",
	"gemini-3.7-flash-high",
	"gemini-3.6-flash-high",
	"gemini-3.5-flash-lite",
	"grok-4.7",
	"grok-4.6",
];

function fullIndex() {
	return buildPriceIndex([
		...normalizeModelsDev(MODELSDEV),
		...normalizeLiteLlm(LITELLM),
		...normalizeOpenRouter(OPENROUTER),
	]);
}

// ───────────────────────────────────────────────── 归一化与名称处理

describe("名称归一化", () => {
	it("剥 effort 后缀只剥一层，且纯数字版本号不受影响", () => {
		expect(stripEffort("gemini-3.8-flash-high")).toBe("gemini-3.8-flash");
		expect(stripEffort("gemini-3.8-flash-xhigh")).toBe("gemini-3.8-flash");
		expect(stripEffort("grok-4.7")).toBe("grok-4.7"); // 关键：-4.7 不是 effort 后缀
		expect(stripEffort("grok-4.7-high")).toBe("grok-4.7");
		expect(stripEffort("high")).toBe("high"); // 剥完为空则原样返回
		expect(stripEffort("")).toBe("");
	});

	it("剥 provider 前缀与变体后缀", () => {
		expect(stripProviderPrefix("google/gemini-3.8-flash")).toBe("gemini-3.8-flash");
		expect(stripProviderPrefix("x-ai/grok-4.7")).toBe("grok-4.7");
		expect(stripProviderPrefix("google/gemini-3.8-flash:batch")).toBe("gemini-3.8-flash");
		expect(stripProviderPrefix("grok-4.7")).toBe("grok-4.7");
	});

	it("匹配候选去重保序：原样 → 剥后缀 → 剥前缀", () => {
		expect(modelCandidates("gemini-3.8-flash-high")).toEqual(["gemini-3.8-flash-high", "gemini-3.8-flash"]);
		expect(modelCandidates("google/gemini-3.8-flash-high")).toEqual([
			"google/gemini-3.8-flash-high",
			"google/gemini-3.8-flash",
			"gemini-3.8-flash-high",
			"gemini-3.8-flash",
		]);
	});

	it("provider 映射：antigravity → google-vertex/google，xai → xai", () => {
		expect(pricingProviderCandidates("antigravity").slice(0, 2)).toEqual(["google-vertex", "google"]);
		expect(pricingProviderCandidates("xai")).toEqual(["xai"]);
		expect(pricingProviderCandidates("X-AI")).toEqual(["xai", "x-ai"]);
		expect(pricingProviderCandidates("unknown-provider")).toEqual(["unknown-provider"]);
	});
});

describe("三源归一化（单位统一为 USD / 1M tokens）", () => {
	it("per-token → per-1M 换算", () => {
		expect(perTokenToPerMillion("0.000002")).toBeCloseTo(2, 10);
		expect(perTokenToPerMillion(0.0000005)).toBeCloseTo(0.5, 10);
		expect(perTokenToPerMillion(null)).toBe(null);
		expect(perTokenToPerMillion("abc")).toBe(null);
	});

	it("models.dev：cost 缺失的条目直接跳过（不产生假价）", () => {
		const entries = normalizeModelsDev(MODELSDEV);
		expect(entries.length).toBeGreaterThan(0);
		// azure 的 grok-4.7 在 fixture 里没有 cost
		expect(entries.some((e) => e.provider === "azure" && e.model === "grok-4.7")).toBe(false);
		const gemini = entries.find((e) => e.provider === "google" && e.model === "gemini-3.8-flash")!;
		expect(gemini.prices).toMatchObject({ input: 0.75, output: 3.75, cacheRead: 0.075 });
		const grok = entries.find((e) => e.provider === "xai" && e.model === "grok-4.7")!;
		expect(grok.prices).toMatchObject({ input: 2, output: 6, cacheRead: 0.5 });
		expect(grok.tiers).toEqual([expect.objectContaining({ size: 200000 })]);
		expect(grok.tiers[0].prices).toMatchObject({ input: 4, output: 12, cacheRead: 1 });
	});

	it("LiteLLM：per token ×1e6，above_200k 折成分段价", () => {
		const entries = normalizeLiteLlm(LITELLM);
		const gemini = entries.find((e) => e.model === "gemini-3.8-flash")!;
		expect(gemini.prices.input).toBeCloseTo(0.75, 10);
		expect(gemini.prices.output).toBeCloseTo(3.75, 10);
		expect(gemini.prices.cacheRead).toBeCloseTo(0.075, 10);
		const grok = entries.find((e) => e.model === "grok-4.7" && e.provider === "xai")!;
		expect(grok.prices.input).toBeCloseTo(2, 10);
		expect(grok.tiers).toEqual([expect.objectContaining({ size: 200000 })]);
		expect(grok.tiers[0].prices.input).toBeCloseTo(4, 10);
	});

	it("OpenRouter：字符串 per token ×1e6，overrides 折成分段价", () => {
		const entries = normalizeOpenRouter(OPENROUTER);
		const grok = entries.find((e) => e.model === "grok-4.7" && e.provider === "x-ai")!;
		expect(grok.prices.input).toBeCloseTo(2, 10);
		expect(grok.prices.output).toBeCloseTo(6, 10);
		expect(grok.prices.cacheRead).toBeCloseTo(0.5, 10);
		expect(grok.tiers[0]).toEqual(expect.objectContaining({ size: 200000 }));
		expect(grok.tiers[0].prices.input).toBeCloseTo(4, 10);
	});
});

// ───────────────────────────────────────────────── 索引与匹配

describe("索引与匹配", () => {
	const index = fullIndex();

	it("全部真库模型都能定价，且优先取映射后的源（models.dev）", () => {
		const cases: [string, string, number][] = [
			["gemini-3.8-flash-high", "antigravity", 0.75],
			["gemini-3.7-flash-high", "antigravity", 0.75],
			["gemini-3.6-flash-high", "antigravity", 0.75],
			["gemini-3.5-flash-lite", "antigravity", 0.3],
			["grok-4.7", "xai", 2],
			["grok-4.6", "xai", 2],
		];
		for (const [model, provider, input] of cases) {
			const match = matchPrice(index, { model, provider });
			expect(match, `${model} 必须能定价`).toBeTruthy();
			expect(match!.source).toBe("modelsdev");
			expect(match!.prices.input).toBeCloseTo(input, 10);
		}
	});

	it("多 provider 价不一致时取映射到的那家（opencode 报 2 倍价不算）", () => {
		const match = matchPrice(index, { model: "gemini-3.8-flash", provider: "antigravity" });
		expect(match!.matchedProvider).toBe("google-vertex");
		expect(match!.prices.input).toBeCloseTo(0.75, 10);
		// 多数价回退也应是 google 的价，而不是 opencode 的 1.5
		expect(index.wildcard.get("gemini-3.8-flash")!.prices.input).toBeCloseTo(0.75, 10);
		expect(index.wildcard.get("gemini-3.8-flash")!.multiSource).toBe(true);
	});

	it("未知模型返回 null（绝不编价）", () => {
		expect(matchPrice(index, { model: "no-such-model-xyz", provider: "antigravity" })).toBe(null);
		expect(matchPrice(buildPriceIndex([]), { model: "grok-4.7", provider: "xai" })).toBe(null);
	});

	it("用户覆盖优先于任何源", () => {
		const withOverride = buildPriceIndex([
			...normalizeModelsDev(MODELSDEV),
			...parsePriceOverrides({ "grok-4.7": { input: 1, output: 1, cacheRead: 0.1 } }).entries,
		]);
		const match = matchPrice(withOverride, { model: "grok-4.7", provider: "xai" });
		expect(match!.via).toBe("override");
		expect(match!.prices.input).toBeCloseTo(1, 10);
	});

	it("价格覆盖解析：非法 JSON / 缺 input+output 一律不出条目", () => {
		expect(parsePriceOverrides("{oops").error).toBeTruthy();
		expect(parsePriceOverrides("{oops").entries).toEqual([]);
		expect(parsePriceOverrides({ m: { input: 1 } }).entries).toEqual([]);
		expect(parsePriceOverrides({ m: { input: 1, output: 2 } }).entries[0].prices).toMatchObject({
			input: 1,
			output: 2,
		});
		expect(parsePriceOverrides("").entries).toEqual([]);
	});
});

// ───────────────────────────────────────────────── 分段价与单行成本

describe("分段价与单行成本", () => {
	const index = fullIndex();

	it("tiers：context 未过阈值用基础价，超过阈值用分段价", () => {
		const match = matchPrice(index, { model: "grok-4.7", provider: "xai" })!;
		expect(pickTier(match.prices, match.tiers, 100_000).prices.input).toBeCloseTo(2, 10);
		expect(pickTier(match.prices, match.tiers, 200_000).prices.input).toBeCloseTo(2, 10); // 等于阈值不算超
		expect(pickTier(match.prices, match.tiers, 200_001).prices.input).toBeCloseTo(4, 10);
		expect(pickTier(match.prices, [], 999_999).size).toBe(0);
	});

	it("输出侧计费由账本 total_tokens 自判（不做启发式猜测）", () => {
		// 真库四种形状，逐一钉住
		expect(billableOutput({ input: 100, output: 10, reasoning: 5, cacheRead: 0, total: 110 })).toEqual({
			tokens: 10,
			basis: "in+out",
		});
		expect(billableOutput({ input: 100, output: 10, reasoning: 5, cacheRead: 0, total: 115 })).toEqual({
			tokens: 15,
			basis: "in+out+reasoning",
		});
		// 关键回归：reasoning ≤ output 也要另计（真库 5172 行走这条）
		expect(billableOutput({ input: 100, output: 70, reasoning: 9, cacheRead: 0, total: 179 })).toEqual({
			tokens: 79,
			basis: "in+out+reasoning",
		});
		expect(billableOutput({ input: 100, output: 10, reasoning: 0, cacheRead: 40, total: 150 })).toEqual({
			tokens: 10,
			basis: "in+out+cache",
		});
		expect(billableOutput({ input: 100, output: 10, reasoning: 5, cacheRead: 40, total: 155 })).toEqual({
			tokens: 15,
			basis: "in+out+r+cache",
		});
		// 账本没给 total：退回保守口径，并标注
		expect(billableOutput({ input: 100, output: 10, reasoning: 50, total: 0 })).toEqual({
			tokens: 60,
			basis: "no-total",
		});
		// 未知形状：只按 output 计，标 unknown（上层统计，绝不当 0 成本）
		expect(billableOutput({ input: 100, output: 10, reasoning: 5, cacheRead: 0, total: 999 })).toEqual({
			tokens: 10,
			basis: "unknown",
		});
	});

	it("单行成本口径：cache_read 已在 input 内，输出 token 走账本自判", () => {
		const gemini = matchPrice(index, { model: "gemini-3.8-flash-high", provider: "antigravity" })!;
		// 100k input（其中 80k 缓存命中）+ 1k output
		const cost = computeRowCost(gemini, { input: 100_000, cacheRead: 80_000, output: 1000, reasoning: 500 })!;
		const expected = ((20_000 * 0.75 + 80_000 * 0.075 + 1000 * 3.75) / 1e6) * 1;
		expect(cost.amount).toBeCloseTo(expected, 12);
		expect(cost.amount).toBeLessThan(0.1); // 若把 cache_read 当额外输入，金额会明显更大
		// total = input+output+reasoning → reasoning 另计（即便 reasoning < output）
		const withBigReasoning = computeRowCost(gemini, {
			input: 1000,
			cacheRead: 0,
			output: 100,
			reasoning: 900,
			total: 2000,
		})!;
		expect(withBigReasoning.outputBasis).toBe("in+out+reasoning");
		expect(withBigReasoning.billableOutputTokens).toBe(1000);
		expect(withBigReasoning.amount).toBeCloseTo((1000 * 0.75 + 1000 * 3.75) / 1e6, 12);
		// total = input+output → reasoning 已含在 output 内，不重复计
		const withSmallReasoning = computeRowCost(gemini, {
			input: 1000,
			cacheRead: 0,
			output: 100,
			reasoning: 40,
			total: 1100,
		})!;
		expect(withSmallReasoning.outputBasis).toBe("in+out");
		expect(withSmallReasoning.billableOutputTokens).toBe(100);
		expect(withSmallReasoning.amount).toBeCloseTo((1000 * 0.75 + 100 * 3.75) / 1e6, 12);
	});

	it("cache_read 超过 input 时按 input 封顶（脏数据不外推）", () => {
		const gemini = matchPrice(index, { model: "gemini-3.8-flash", provider: "antigravity" })!;
		const cost = computeRowCost(gemini, { input: 100, cacheRead: 500, output: 0, reasoning: 0 })!;
		expect(cost.amount).toBeCloseTo((100 * 0.075) / 1e6, 15);
	});

	it("未知价返回 null（绝不返回 0）", () => {
		const unmatched = matchPrice(index, { model: "totally-unknown", provider: "xai" });
		expect(unmatched).toBe(null);
		expect(computeRowCost(unmatched, { input: 1000, output: 100 })).toBe(null);
	});
});

// ───────────────────────────────────────────────── 快照缓存（离线假 fetch）

function fakeStorage(initial: Record<string, unknown> = {}) {
	const data = new Map<string, unknown>(Object.entries(initial));
	const sets: string[] = [];
	return {
		data,
		sets,
		get(key: string, fallback?: unknown) {
			return data.has(key) ? data.get(key) : fallback;
		},
		set(key: string, value: unknown) {
			sets.push(key);
			data.set(key, value);
		},
		delete(key: string) {
			data.delete(key);
		},
		has(key: string) {
			return data.has(key);
		},
		keys() {
			return [...data.keys()];
		},
		clear() {
			data.clear();
		},
		all() {
			return Object.fromEntries(data);
		},
	};
}

/** 假 fetch：按 URL 返回 fixture；可选抛错模拟失败。 */
function fakeFetch(plan: { failAll?: boolean; calls?: string[] } = {}) {
	const byHost: Record<string, unknown> = {
		"models.dev": MODELSDEV,
		"raw.githubusercontent.com": LITELLM,
		"openrouter.ai": OPENROUTER,
	};
	return async (url: string, init?: { timeoutMs?: number }) => {
		plan.calls?.push(url);
		expect(init?.timeoutMs).toBeGreaterThan(0);
		if (plan.failAll) throw new Error("network down");
		const host = new URL(url).hostname;
		const body = byHost[host];
		if (!body) return { ok: false, status: 404, text: async () => "" };
		return { ok: true, status: 200, text: async () => JSON.stringify(body) };
	};
}

describe("价格快照：缓存 / 过期 / 失败保留旧值", () => {
	it("首次 refresh 落 storage，条目只保留账本用到的模型", async () => {
		const storage = fakeStorage();
		const book = createPriceBook({ storage: storage as never, fetchImpl: fakeFetch() as never });
		expect(book.load()).toBe(null);
		expect(book.status().available).toBe(false);
		const status = await book.refresh({ models: LEDGER_MODELS });
		expect(status.available).toBe(true);
		expect(status.sourceLabels.sort()).toEqual(["LiteLLM", "OpenRouter", "models.dev"]);
		const snap = storage.data.get(PRICE_STORAGE_KEY) as { entries: { model: string }[]; models: string[] };
		expect(snap.models).toEqual(LEDGER_MODELS);
		expect(snap.entries.length).toBeGreaterThan(0);
		// 体积红线：快照只有账本用到的模型，远小于 32KB
		expect(JSON.stringify(snap).length).toBeLessThan(32 * 1024);
		// 落盘后能被新实例同步载入（首屏不联网）
		const reloaded = createPriceBook({ storage: storage as never, fetchImpl: null as never });
		expect(reloaded.load()).toBeTruthy();
		expect(reloaded.status().available).toBe(true);
		const match = matchPrice(indexFromSnapshot(reloaded.snapshot()), {
			model: "gemini-3.8-flash-high",
			provider: "antigravity",
		});
		expect(match!.prices.input).toBeCloseTo(0.75, 10);
	});

	it("TTL：过期判定与 ensureFresh 触发一次后台刷新", async () => {
		const storage = fakeStorage();
		const calls: string[] = [];
		let clock = 1_000_000;
		const book = createPriceBook({
			storage: storage as never,
			fetchImpl: fakeFetch({ calls }) as never,
			now: () => clock,
		});
		await book.refresh({ models: LEDGER_MODELS });
		expect(calls.length).toBe(PRICE_SOURCES.length);
		expect(isSnapshotStale(book.snapshot(), clock)).toBe(false);
		expect(isSnapshotStale(book.snapshot(), clock + PRICE_TTL_MS)).toBe(true);
		// 未过期：不刷新
		const fresh = book.ensureFresh({ models: LEDGER_MODELS });
		expect(fresh.triggered).toBe(false);
		// 过期：触发后台刷新
		clock += PRICE_TTL_MS;
		const stale = book.ensureFresh({ models: LEDGER_MODELS });
		expect(stale.triggered).toBe(true);
		await vi.waitFor(() => expect(calls.length).toBe(PRICE_SOURCES.length * 2));
	});

	it("刷新失败：保留旧快照 + 记录失败时间与错误，不抛错", async () => {
		const storage = fakeStorage();
		const book = createPriceBook({ storage: storage as never, fetchImpl: fakeFetch() as never });
		await book.refresh({ models: LEDGER_MODELS });
		const before = book.status();
		// 换成必然失败的 fetch
		const failing = createPriceBook({ storage: storage as never, fetchImpl: fakeFetch({ failAll: true }) as never });
		failing.load();
		await failing.refresh({ models: LEDGER_MODELS });
		const after = failing.status();
		expect(after.available).toBe(true); // 旧快照还在
		expect(after.fetchedAt).toBe(before.fetchedAt);
		expect(after.refreshFailedAt).toBeGreaterThan(0);
		expect(after.lastError).toBeTruthy();
		// 旧快照价格仍然可用
		expect(matchPrice(failing.getIndex(), { model: "grok-4.7", provider: "xai" })!.prices.input).toBeCloseTo(2, 10);
	});

	it("三源全挂时首屏状态是 available:false（成本显示 --，不是 0）", async () => {
		const book = createPriceBook({ storage: fakeStorage() as never, fetchImpl: fakeFetch({ failAll: true }) as never });
		await book.refresh({ models: LEDGER_MODELS });
		expect(book.status().available).toBe(false);
		expect(matchPrice(book.getIndex(), { model: "grok-4.7", provider: "xai" })).toBe(null);
	});

	it("模型集合变化会被识别为「快照未覆盖」", async () => {
		const storage = fakeStorage();
		const book = createPriceBook({ storage: storage as never, fetchImpl: fakeFetch() as never });
		await book.refresh({ models: LEDGER_MODELS });
		expect(snapshotCoversModels(book.snapshot(), ["grok-4.7"])).toBe(true);
		expect(snapshotCoversModels(book.snapshot(), ["brand-new-model"])).toBe(false);
		expect(book.ensureFresh({ models: ["brand-new-model"] }).triggered).toBe(true);
	});

	it("describeSnapshot 给出可用来源与失败来源", async () => {
		const storage = fakeStorage();
		const book = createPriceBook({
			storage: storage as never,
			fetchImpl: (async (url: string) => {
				if (new URL(url).hostname === "openrouter.ai") throw new Error("blocked");
				const body = new URL(url).hostname === "models.dev" ? MODELSDEV : LITELLM;
				return { ok: true, status: 200, text: async () => JSON.stringify(body) };
			}) as never,
		});
		await book.refresh({ models: LEDGER_MODELS });
		const desc = describeSnapshot(book.snapshot());
		expect(desc.available).toBe(true);
		expect(desc.sourceLabels).toContain("models.dev");
		expect(desc.failedSources).toEqual(["OpenRouter"]);
	});
});

// ───────────────────────────────────────────────── 仓库红线

describe("仓库红线（R3）", () => {
	const ROOT = fileURLToPath(new URL("../../", import.meta.url));

	it("仓库里不存在 >32KB 的价格原始 JSON（快照只允许运行时同步）", () => {
		// 独立仓库：插件根 = 仓库根；只走交付目录，不跟进 node_modules / 锁文件
		const dirs = [FIXTURES, ROOT];
		const tooBig: string[] = [];
		const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", ".cps-tmp"]);
		// 锁文件不是价格快照，体积天然 >32KB，不进红线口径
		const SKIP_FILES = new Set(["package-lock.json"]);
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					if (SKIP_DIRS.has(entry.name)) continue;
					walk(join(dir, entry.name));
					continue;
				}
				if (SKIP_FILES.has(entry.name)) continue;
				if (!/\.json$/i.test(entry.name)) continue;
				const size = statSync(join(dir, entry.name)).size;
				if (size > 32 * 1024) tooBig.push(`${join(dir, entry.name)} (${size} bytes)`);
			}
		};
		for (const dir of dirs) walk(dir);
		expect(tooBig).toEqual([]);
	});

	it("fixture 只保留计价相关字段（体积可控、可人工 diff）", () => {
		expect(statSync(join(FIXTURES, "modelsdev.json")).size).toBeLessThan(32 * 1024);
		expect(statSync(join(FIXTURES, "litellm.json")).size).toBeLessThan(32 * 1024);
		expect(statSync(join(FIXTURES, "openrouter.json")).size).toBeLessThan(32 * 1024);
		const only = filterEntriesForModels(normalizeModelsDev(MODELSDEV), ["grok-4.7"]) as Array<{ model: string }>;
		expect(only.length).toBeGreaterThan(0);
		expect(only.every((e) => e.model === "grok-4.7")).toBe(true);
	});
});

// ───────────────────────────────────────────────── R7 / F-11：跨源价格分歧的裁决与标记

/**
 * 同模型三源报价不一致的最小构造（provider 都对不上账本路由 → 只能走多数价回退）。
 * models.dev 1 票 1/3；LiteLLM 与 OpenRouter 同价 100/400 共 2 票（就是 F-11 的 125× 场景）。
 */
function divergentIndex() {
	return buildPriceIndex([
		...normalizeModelsDev({ p1: { models: { "amb-m": { cost: { input: 1, output: 3 } } } } }),
		...normalizeLiteLlm({
			"x/amb-m": { litellm_provider: "xai2", input_cost_per_token: 100e-6, output_cost_per_token: 400e-6 },
		}),
		...normalizeOpenRouter({ data: [{ id: "z/amb-m", pricing: { prompt: "0.0001", completion: "0.0004" } }] }),
	]);
}

describe("R7：跨源价格分歧（REVIEW F-11）", () => {
	const usage = { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 1_000, reasoning: 0, total: 2_000 };

	it("优先级胜出：models.dev 1 票压过低价源 2 票（1/3 而非 100/400），且标记 multiSource", () => {
		const index = divergentIndex();
		const hit = matchPrice(index, { model: "amb-m", provider: "no-such-provider" })!;
		expect(hit.via).toBe("wildcard");
		expect(hit.source, "跨源分歧必须取最高优先源（models.dev）").toBe("modelsdev");
		expect([hit.prices.input, hit.prices.output]).toEqual([1, 3]);
		expect(hit.multiSource).toBe(true);
		// 金额：(1000×1 + 1000×3)/1e6 = 0.004；旧行为（100/400）是 0.5，差 125 倍
		const cost = computeRowCost(hit, usage)!;
		expect(cost.amount).toBeCloseTo(0.004, 9);
		expect(cost.multiSource).toBe(true);
		// 精确命中（provider 映射得上）不得带多源标记
		const exact = matchPrice(index, { model: "amb-m", provider: "p1" })!;
		expect(exact.via).toBe("exact");
		expect(exact.multiSource).toBe(false);
	});

	it("同优先级内才比票数：LiteLLM 2 票同价 > LiteLLM 1 票另价（模型无 models.dev 报价）", () => {
		const index = buildPriceIndex([
			...normalizeLiteLlm({
				"a/m2": { litellm_provider: "pa", input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
				"b/m2": { litellm_provider: "pb", input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
				"c/m2": { litellm_provider: "pc", input_cost_per_token: 9e-6, output_cost_per_token: 27e-6 },
			}),
		]);
		const hit = matchPrice(index, { model: "m2", provider: "unknown-route" })!;
		expect([hit.prices.input, hit.prices.output]).toEqual([2, 6]);
		expect(hit.multiSource).toBe(true); // 两价并存 → 分歧
	});

	it("各源同价：取该价且不挂标记（分歧标记只在真分歧时出现）", () => {
		const index = buildPriceIndex([
			...normalizeModelsDev({ p1: { models: { "same-m": { cost: { input: 2, output: 6 } } } } }),
			...normalizeLiteLlm({
				"a/same-m": { litellm_provider: "pa", input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
				"b/same-m": { litellm_provider: "pb", input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
			}),
		]);
		const hit = matchPrice(index, { model: "same-m", provider: "unknown-route" })!;
		expect([hit.prices.input, hit.prices.output]).toEqual([2, 6]);
		expect(hit.multiSource).toBe(false);
		expect(computeRowCost(hit, usage)!.multiSource).toBe(false);
	});

	it("用户覆盖与精确命中永远不带分歧标记，未知价也不冒充分歧", () => {
		const withOverride = buildPriceIndex([
			...normalizeModelsDev({ p1: { models: { "amb-m": { cost: { input: 1, output: 3 } } } } }),
			...parsePriceOverrides({ "amb-m": { input: 5, output: 15 } }).entries,
		]);
		const hit = matchPrice(withOverride, { model: "amb-m", provider: "no-such-provider" })!;
		expect(hit.via).toBe("override");
		expect(hit.multiSource).toBe(false);
		expect(matchPrice(withOverride, { model: "nope-xyz", provider: "no-such-provider" })).toBe(null);
	});
});
