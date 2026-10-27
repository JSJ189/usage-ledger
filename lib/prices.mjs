/**
 * usage-ledger · 价目表（估算成本用）
 *
 * 设计约束（R3 人类决策）：
 *  1. **不随包内置快照**：只在运行时从三个开源源同步，结果存插件自己的 storage（TTL 7 天），
 *     过期后台异步刷新；刷新失败保留旧快照并标注时间与失败态。禁止首屏同步联网。
 *  2. **未知价一律 null**（UI 显示 `--`），绝不外推、绝不当 0。汇总要给「未知价占比」。
 *  3. 金额全部是 **USD per 1M tokens** 的中间量，页面显示时加「≈ 估算」。
 *  4. 绝不写 E: 盘、绝不写 usage.db 的 model_prices。
 *
 * 三个源（优先级从高到低）：
 *  - models.dev  `https://models.dev/api.json`（USD / 1M，部分条目 cost 缺失）
 *  - LiteLLM     `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`（USD / token，需 ×1e6）
 *  - OpenRouter  `https://openrouter.ai/api/v1/models`（USD / token 字符串，带 overrides 分段价）
 *
 * 本文件全部是纯函数（除 `createPriceBook` 的 IO 部分），单测只喂裁剪过的 fixture，不联网。
 */

export const PRICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PRICE_STORAGE_KEY = "priceSnapshot.v1";
export const PRICE_FETCH_TIMEOUT_MS = 90_000;
/** 单源响应上限：models.dev 实测 ~5.9MB，留足余量但不接受无限流。 */
export const PRICE_MAX_BYTES = 24 * 1024 * 1024;

export const PRICE_SOURCES = [
	{
		id: "modelsdev",
		label: "models.dev",
		host: "models.dev",
		url: "https://models.dev/api.json",
		priority: 1,
	},
	{
		id: "litellm",
		label: "LiteLLM",
		host: "raw.githubusercontent.com",
		url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
		priority: 2,
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		host: "openrouter.ai",
		url: "https://openrouter.ai/api/v1/models",
		priority: 3,
	},
];

/** 允许联网的主机白名单（manifest.netAllowlist 同源，插件侧再自查一次：fail-closed）。 */
export const PRICE_HOSTS = PRICE_SOURCES.map((s) => s.host);

/**
 * 路由 provider（账本里的 `provider`）→ 价目表里的 provider 候选（按优先级）。
 * 真库实测只有 antigravity / xai 两家；别名表与「按路由汇总」共用同一份。
 */
export const PROVIDER_ALIASES = {
	antigravity: ["google-vertex", "google"],
	gemini: ["google", "google-vertex"],
	google: ["google", "google-vertex"],
	"google-vertex": ["google-vertex", "google"],
	"google-ai-studio": ["google"],
	xai: ["xai"],
	"x-ai": ["xai"],
	openrouter: ["openrouter"],
	anthropic: ["anthropic"],
	openai: ["openai"],
	azure: ["azure"],
	"azure-ai": ["azure"],
};

/** 能力后缀（effort / 模式）——剥一层用于匹配基名。纯数字后缀（如 grok-4.7 的 -4.7）不在表内。 */
const EFFORT_SUFFIXES = [
	"-non-reasoning",
	"-nonreasoning",
	"-reasoning",
	"-thinking",
	"-minimal",
	"-xhigh",
	"-medium",
	"-high",
	"-low",
	"-none",
	"-max",
];

// ──────────────────────────────────────────────────────── 名称归一化

/** 剥掉一层能力后缀：`gemini-3.8-flash-high` → `gemini-3.8-flash`（只剥一次，剥完不能为空）。 */
export function stripEffort(model) {
	const s = String(model ?? "").trim();
	for (const suffix of EFFORT_SUFFIXES) {
		if (s.length > suffix.length && s.toLowerCase().endsWith(suffix)) return s.slice(0, -suffix.length);
	}
	return s;
}

/** 剥掉 provider 前缀：`google/gemini-3.8-flash` → `gemini-3.8-flash`；`:batch` 之类的变体后缀也剥。 */
export function stripProviderPrefix(model) {
	let s = String(model ?? "").trim();
	const slash = s.lastIndexOf("/");
	if (slash >= 0 && slash < s.length - 1) s = s.slice(slash + 1);
	const colon = s.indexOf(":");
	if (colon > 0) s = s.slice(0, colon);
	return s;
}

/** 匹配候选（去重、保序）：原样 → 剥后缀 → 再剥前缀。 */
export function modelCandidates(model) {
	const raw = String(model ?? "").trim();
	const out = [];
	const push = (v) => {
		if (v && !out.includes(v)) out.push(v);
	};
	push(raw);
	push(stripEffort(raw));
	push(stripProviderPrefix(raw));
	push(stripProviderPrefix(stripEffort(raw)));
	return out;
}

/** 路由 provider → 价目表 provider 候选（别名优先，最后附原值小写）。 */
export function pricingProviderCandidates(provider) {
	const key = String(provider ?? "")
		.trim()
		.toLowerCase();
	const out = [];
	const push = (v) => {
		if (v && !out.includes(v)) out.push(v);
	};
	for (const alias of PROVIDER_ALIASES[key] ?? []) push(alias);
	push(key);
	return out;
}

// ──────────────────────────────────────────────────────── 三源归一化

function num(value) {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** per-token → per-1M（LiteLLM / OpenRouter 都是 per token）。 */
export function perTokenToPerMillion(value) {
	const n = num(value);
	return n === null ? null : n * 1e6;
}

function priceBag({ input, output, cacheRead, cacheWrite }) {
	const bag = {
		input: num(input),
		output: num(output),
		cacheRead: num(cacheRead),
		cacheWrite: num(cacheWrite),
	};
	return bag;
}

/** 是否至少有 input/output 价（否则视为「无价条目」，不可用于计价）。 */
function hasCorePrices(bag) {
	return bag && bag.input !== null && bag.output !== null;
}

/**
 * models.dev：`{<provider>: {models: {<modelId>: {cost: {input, output, cache_read, cache_write, tiers[], context_over_200k}}}}}`
 * 单位 USD / 1M tokens；cost 缺失的条目必须跳过（逐 provider 判空）。
 */
export function normalizeModelsDev(json) {
	const entries = [];
	if (!json || typeof json !== "object") return entries;
	for (const [provider, providerEntry] of Object.entries(json)) {
		const models = providerEntry?.models;
		if (!models || typeof models !== "object") continue;
		for (const [modelId, model] of Object.entries(models)) {
			const cost = model?.cost;
			if (!cost || typeof cost !== "object") continue;
			const prices = priceBag({
				input: cost.input,
				output: cost.output,
				cacheRead: cost.cache_read,
				cacheWrite: cost.cache_write,
			});
			if (!hasCorePrices(prices)) continue;
			const tiers = [];
			for (const tier of Array.isArray(cost.tiers) ? cost.tiers : []) {
				const size = num(tier?.tier?.size);
				if (size === null || tier?.tier?.type !== "context") continue;
				const tierPrices = priceBag({
					input: tier.input ?? prices.input,
					output: tier.output ?? prices.output,
					cacheRead: tier.cache_read ?? prices.cacheRead,
					cacheWrite: tier.cache_write ?? prices.cacheWrite,
				});
				if (hasCorePrices(tierPrices)) tiers.push({ size, prices: tierPrices });
			}
			// 老式 context_over_200k：当成 size=200000 的分段
			const over = cost.context_over_200k;
			if (over && typeof over === "object" && !tiers.some((t) => t.size === 200000)) {
				const o = priceBag({
					input: over.input ?? prices.input,
					output: over.output ?? prices.output,
					cacheRead: over.cache_read ?? prices.cacheRead,
					cacheWrite: over.cache_write ?? prices.cacheWrite,
				});
				if (hasCorePrices(o)) tiers.push({ size: 200000, prices: o });
			}
			tiers.sort((a, b) => a.size - b.size);
			entries.push({
				source: "modelsdev",
				provider: String(provider).toLowerCase(),
				model: String(modelId),
				prices,
				tiers,
			});
		}
	}
	return entries;
}

/**
 * LiteLLM：键形如 `gemini/gemini-3.8-flash`，成本字段是 **per token**，需 ×1e6。
 * 分段价用 `*_above_200k_tokens` 表达 → size=200000 的 tier。
 */
export function normalizeLiteLlm(json) {
	const entries = [];
	if (!json || typeof json !== "object") return entries;
	for (const [key, row] of Object.entries(json)) {
		if (!row || typeof row !== "object") continue;
		const prices = priceBag({
			input: perTokenToPerMillion(row.input_cost_per_token),
			output: perTokenToPerMillion(row.output_cost_per_token),
			cacheRead: perTokenToPerMillion(row.cache_read_input_token_cost),
			cacheWrite: perTokenToPerMillion(row.cache_creation_input_token_cost),
		});
		if (!hasCorePrices(prices)) continue;
		const tiers = [];
		const aboveInput = perTokenToPerMillion(row.input_cost_per_token_above_200k_tokens);
		const aboveOutput = perTokenToPerMillion(row.output_cost_per_token_above_200k_tokens);
		const aboveCacheRead = perTokenToPerMillion(row.cache_read_input_token_cost_above_200k_tokens);
		if (aboveInput !== null || aboveOutput !== null) {
			tiers.push({
				size: 200000,
				prices: priceBag({
					input: aboveInput ?? prices.input,
					output: aboveOutput ?? prices.output,
					cacheRead: aboveCacheRead ?? prices.cacheRead,
					cacheWrite: prices.cacheWrite,
				}),
			});
		}
		const provider = String(row.litellm_provider ?? key.split("/")[0] ?? "").toLowerCase();
		const model = stripProviderPrefix(key);
		if (!provider || !model) continue;
		entries.push({ source: "litellm", provider, model, prices, tiers });
	}
	return entries;
}

/**
 * OpenRouter：`{data: [{id: "x-ai/grok-4.7", pricing: {prompt, completion, input_cache_read, input_cache_write, overrides[]}}]}`
 * 价格是 **per token 字符串**（×1e6 归一），overrides 是「prompt 超过阈值后的分段价」。
 */
export function normalizeOpenRouter(json) {
	const entries = [];
	const list = Array.isArray(json?.data) ? json.data : [];
	for (const row of list) {
		const id = String(row?.id ?? "");
		const pricing = row?.pricing;
		if (!id || !pricing || typeof pricing !== "object") continue;
		const prices = priceBag({
			input: perTokenToPerMillion(pricing.prompt),
			output: perTokenToPerMillion(pricing.completion),
			cacheRead: perTokenToPerMillion(pricing.input_cache_read),
			cacheWrite: perTokenToPerMillion(pricing.input_cache_write),
		});
		if (!hasCorePrices(prices)) continue;
		const tiers = [];
		for (const ov of Array.isArray(pricing.overrides) ? pricing.overrides : []) {
			const size = num(ov?.min_prompt_tokens);
			if (size === null) continue;
			const tierPrices = priceBag({
				input: perTokenToPerMillion(ov.prompt) ?? prices.input,
				output: perTokenToPerMillion(ov.completion) ?? prices.output,
				cacheRead: perTokenToPerMillion(ov.input_cache_read) ?? prices.cacheRead,
				cacheWrite: perTokenToPerMillion(ov.input_cache_write) ?? prices.cacheWrite,
			});
			if (hasCorePrices(tierPrices)) tiers.push({ size, prices: tierPrices });
		}
		tiers.sort((a, b) => a.size - b.size);
		const slash = id.lastIndexOf("/");
		const provider = slash > 0 ? id.slice(0, slash).toLowerCase() : "";
		const model = slash > 0 ? id.slice(slash + 1) : id;
		entries.push({ source: "openrouter", provider, model, prices, tiers });
	}
	return entries;
}

/** 三个源的解析入口（按 source id 分派；未知 id 回空数组）。 */
export function normalizeSource(sourceId, json) {
	if (sourceId === "modelsdev") return normalizeModelsDev(json);
	if (sourceId === "litellm") return normalizeLiteLlm(json);
	if (sourceId === "openrouter") return normalizeOpenRouter(json);
	return [];
}

// ────────────────────────────────────────────────────────── 用户覆盖

/**
 * 用户价格覆盖（只存插件自己的 storage / 设置文本，绝不写账本）：
 * `{"grok-4.7": {"input": 2, "output": 6, "cacheRead": 0.5}}`（USD / 1M）
 */
export function parsePriceOverrides(text) {
	if (!text) return { entries: [], error: null };
	let raw = text;
	if (typeof text === "string") {
		const trimmed = text.trim();
		if (!trimmed) return { entries: [], error: null };
		try {
			raw = JSON.parse(trimmed);
		} catch (err) {
			return { entries: [], error: `价格覆盖不是合法 JSON：${err?.message ?? err}` };
		}
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { entries: [], error: "价格覆盖必须是 { 模型: { input, output, cacheRead, cacheWrite } }" };
	}
	const entries = [];
	for (const [model, value] of Object.entries(raw)) {
		if (!value || typeof value !== "object") continue;
		const prices = priceBag({
			input: value.input,
			output: value.output,
			cacheRead: value.cacheRead ?? value.cache_read,
			cacheWrite: value.cacheWrite ?? value.cache_write,
		});
		if (!hasCorePrices(prices)) continue;
		entries.push({ source: "override", provider: "*", model: String(model), prices, tiers: [] });
	}
	return { entries, error: null };
}

// ────────────────────────────────────────────────────────── 索引与匹配

function keyOf(provider, model) {
	return `${provider}\u0000${model}`;
}

function priceSignature(prices) {
	return `${prices.input}/${prices.output}/${prices.cacheRead}/${prices.cacheWrite}`;
}

/**
 * 构建查询索引：
 *  - `overrides`：用户覆盖（key = 模型名）优先；
 *  - `exact`：`provider|model` 取最高优先级源（models.dev > litellm > openrouter）；
 *  - `wildcard`：`model` 的「多数价」（跨 provider 取出现最多的价），多价并存时打 `multiSource`。
 *    排序键 `(priority 升序, count 降序)`：跨源分歧时取优先级更高的源（models.dev 优先），
 *    同优先级或单源内部才比票数。否则一票最高优先源会被低价源的多数票静默压掉（REVIEW F-11）。
 */
export function buildPriceIndex(entries) {
	const priorityOf = (source) => PRICE_SOURCES.find((s) => s.id === source)?.priority ?? 9;
	const overrides = new Map();
	const exact = new Map();
	const wildcardVotes = new Map();
	const wildcardChosen = new Map();

	for (const entry of entries ?? []) {
		if (!entry || !entry.model) continue;
		if (entry.source === "override" || entry.provider === "*") {
			if (!overrides.has(entry.model)) overrides.set(entry.model, entry);
			continue;
		}
		const key = keyOf(entry.provider, entry.model);
		const prev = exact.get(key);
		if (!prev || priorityOf(entry.source) < priorityOf(prev.source)) exact.set(key, entry);

		const sig = priceSignature(entry.prices);
		const priority = priorityOf(entry.source);
		const votes = wildcardVotes.get(entry.model) ?? new Map();
		const hit = votes.get(sig);
		if (!hit) {
			votes.set(sig, { count: 1, entry, priority, sig });
		} else {
			hit.count += 1;
			// 同一价组内多源投票：保留最高优先源的 priority 与其 entry（tiers 也随最优源）
			if (priority < hit.priority) {
				hit.priority = priority;
				hit.entry = entry;
			}
		}
		wildcardVotes.set(entry.model, votes);
	}
	for (const [model, votes] of wildcardVotes) {
		let best = null;
		for (const [, v] of votes) {
			if (!best) {
				best = v;
				continue;
			}
			// (priority, -count)：跨源分歧时最高优先源胜（models.dev > litellm > openrouter）；
			// 同优先级、或同源内部多价时，票数多者胜。R7 人类裁决：优先源不得被低价源多数票静默压掉。
			if (v.priority !== best.priority) {
				if (v.priority < best.priority) best = v;
				continue;
			}
			if (v.count !== best.count) {
				if (v.count > best.count) best = v;
				continue;
			}
			if (v.sig < best.sig) best = v; // 全打平也要确定性
		}
		if (best) wildcardChosen.set(model, { ...best.entry, multiSource: votes.size > 1 });
	}
	return { overrides, exact, wildcard: wildcardChosen };
}

/**
 * 匹配一条用量行的价格。返回 null = 未知价（UI 必须显示 `--`）。
 * 顺序：用户覆盖 → provider 映射后的精确匹配 → 多数价回退。
 * 返回值恒带 `multiSource`（布尔）：本次命中的价表条目是否「跨源价格分歧」。
 */
export function matchPrice(index, { model, provider } = {}) {
	if (!index) return null;
	const candidates = modelCandidates(model);
	for (const cand of candidates) {
		const ov = index.overrides?.get(cand) ?? index.overrides?.get(String(model ?? "").trim());
		if (ov) return { ...ov, matchedModel: cand, matchedProvider: "*", via: "override", multiSource: false };
	}
	for (const cand of candidates) {
		for (const prov of pricingProviderCandidates(provider)) {
			const hit = index.exact?.get(keyOf(prov, cand));
			if (hit) return { ...hit, matchedModel: cand, matchedProvider: prov, via: "exact", multiSource: false };
		}
	}
	for (const cand of candidates) {
		const hit = index.wildcard?.get(cand);
		if (hit) {
			return {
				...hit,
				matchedModel: cand,
				matchedProvider: "*",
				via: "wildcard",
				multiSource: hit.multiSource === true,
			};
		}
	}
	return null;
}

/** 选分段价：取 size < contextTokens 的最大分段；不到阈值用基础价。 */
export function pickTier(prices, tiers, contextTokens) {
	const base = { size: 0, prices };
	const ctx = num(contextTokens) ?? 0;
	let chosen = base;
	for (const tier of tiers ?? []) {
		if (!tier?.prices) continue;
		if (ctx > tier.size && tier.size >= chosen.size) chosen = { size: tier.size, prices: tier.prices };
	}
	return chosen;
}

/**
 * 「输出侧要计费多少 token」——**用账本自带的 total_tokens 自判**，不做启发式猜测。
 *
 * 真库实测（n=49866，2026-10-27）只有四种形状，且**没有一行落在未知形状**：
 *  - `total = input + output`                    41584 行 → reasoning 已含在 output 里，只计 output；
 *  - `total = input + output + reasoning`        14015 行 → reasoning 另计（其中 5172 行 reasoning ≤ output，
 *                                                            正是启发式 `reasoning > output` 会漏掉的那批）；
 *  - `total = input + output + cache_read`        7303 行 → 只计 output（cache 另按缓存价计）；
 *  - `total = input + output + reasoning + cache_read` 5237 行 → 计 output + reasoning。
 *
 * 判据顺序从最具体到最泛。`total` 缺失/为 0 时退回 `output + (reasoning>output ? reasoning : 0)`
 * （basis = "no-total"，账本没给总数只能这么取），其它形状一律按 output 计并标 `basis = "unknown"`，
 * 由上层统计「口径未知」行数（绝不把它们当 0 成本）。
 *
 * @param {{input?: number, output?: number, reasoning?: number, cacheRead?: number, total?: number}} usage
 * @returns {{tokens: number, basis: string}}
 */
export function billableOutput(usage) {
	const input = Math.max(0, num(usage?.input) ?? 0);
	const output = Math.max(0, num(usage?.output) ?? 0);
	const reasoning = Math.max(0, num(usage?.reasoning) ?? 0);
	const cacheRead = Math.max(0, num(usage?.cacheRead) ?? 0);
	const total = num(usage?.total);
	if (total === null || total <= 0) {
		return { tokens: output + (reasoning > output ? reasoning : 0), basis: "no-total" };
	}
	// cache_read = 0 时前两种形状与后两种等价，标签只按「更具体」的那个给
	if (cacheRead > 0 && reasoning > 0 && total === input + output + reasoning + cacheRead) {
		return { tokens: output + reasoning, basis: "in+out+r+cache" };
	}
	if (reasoning > 0 && total === input + output + reasoning)
		return { tokens: output + reasoning, basis: "in+out+reasoning" };
	if (cacheRead > 0 && total === input + output + cacheRead) return { tokens: output, basis: "in+out+cache" };
	if (total === input + output) return { tokens: output, basis: "in+out" };
	return { tokens: output, basis: "unknown" };
}

/**
 * 单行成本（USD）。返回 null 表示未知价（调用方必须记为 unknown，绝不当 0）。
 *
 * 口径（真库实测，见 README）：
 *  - `cache_read_tokens ⊆ input_tokens`（全表 0 行 input < cache_read）→ 可计费输入 = input − cache_read；
 *  - 输出侧 token 由 `billableOutput()` 按账本 total_tokens 的形状自判；
 *  - 未知价 → null（不是 0）。
 */
export function computeRowCost(match, usage) {
	if (!match || !match.prices || !hasCorePrices(match.prices)) return null;
	const input = Math.max(0, num(usage?.input) ?? 0);
	const cacheRead = Math.min(input, Math.max(0, num(usage?.cacheRead) ?? 0));
	const cacheWrite = Math.max(0, num(usage?.cacheWrite) ?? 0);
	const out = billableOutput({ ...usage, cacheRead });
	const billableInput = input - cacheRead;
	const tier = pickTier(match.prices, match.tiers, input);
	const p = tier.prices;
	if (p.input === null || p.output === null) return null;
	const cacheReadPrice = p.cacheRead === null ? p.input : p.cacheRead;
	const cacheWritePrice = p.cacheWrite === null ? p.input : p.cacheWrite;
	const amount =
		(billableInput * p.input + cacheRead * cacheReadPrice + out.tokens * p.output + cacheWrite * cacheWritePrice) / 1e6;
	return {
		amount,
		tierSize: tier.size,
		outputBasis: out.basis,
		billableOutputTokens: out.tokens,
		cacheReadFallback: p.cacheRead === null,
		cacheWriteFallback: p.cacheWrite === null,
		source: match.source,
		// 该行用的价是「跨源价格分歧」里选出来的（供成本桶计数与 UI 标记）
		multiSource: match.multiSource === true,
	};
}

// ────────────────────────────────────────────────────────── 快照状态

/** 快照是否过期（无快照也算过期）。 */
export function isSnapshotStale(snapshot, now = Date.now(), ttlMs = PRICE_TTL_MS) {
	if (!snapshot || !snapshot.fetchedAt) return true;
	return now - snapshot.fetchedAt >= ttlMs;
}

/** 快照里的模型集合是否覆盖当前账本用到的模型（不覆盖就要刷新）。 */
export function snapshotCoversModels(snapshot, models) {
	if (!snapshot || !Array.isArray(snapshot.entries)) return false;
	if (!Array.isArray(models) || !models.length) return true;
	const wanted = new Set();
	for (const m of models) for (const cand of modelCandidates(m)) wanted.add(cand);
	for (const entry of snapshot.entries) {
		if (entry?.model && wanted.has(entry.model)) return true;
	}
	return false;
}

/** 快照 → 索引（供聚合复用；快照里只有 entries）。 */
export function indexFromSnapshot(snapshot) {
	if (!snapshot || !Array.isArray(snapshot.entries)) return buildPriceIndex([]);
	return buildPriceIndex(snapshot.entries);
}

/** 快照状态摘要（前端展示「价格快照：<时间>（刷新失败）」）。 */
export function describeSnapshot(snapshot, now = Date.now(), ttlMs = PRICE_TTL_MS) {
	if (!snapshot || !snapshot.fetchedAt) {
		return {
			available: false,
			stale: true,
			fetchedAt: null,
			sourceLabels: [],
			failedSources: [],
			entryCount: 0,
			lastError: null,
		};
	}
	const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
	return {
		available: Array.isArray(snapshot.entries) && snapshot.entries.length > 0,
		stale: isSnapshotStale(snapshot, now, ttlMs),
		fetchedAt: snapshot.fetchedAt,
		sourceLabels: sources.filter((s) => s.ok).map((s) => s.label),
		failedSources: sources.filter((s) => !s.ok).map((s) => s.label),
		entryCount: Array.isArray(snapshot.entries) ? snapshot.entries.length : 0,
		lastError: snapshot.lastError ?? null,
		refreshFailedAt: snapshot.refreshFailedAt ?? null,
		overridesError: snapshot.overridesError ?? null,
		models: Array.isArray(snapshot.models) ? snapshot.models : [],
		providers: Array.isArray(snapshot.providers) ? snapshot.providers : [],
	};
}

// ────────────────────────────────────────────────────────── 抓取（IO）

function hostAllowed(hostname, allowlist) {
	const host = String(hostname ?? "").toLowerCase();
	return allowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * 依次抓三源并归一化。失败一律静默降级（写进 sources[].error，不抛错、不刷屏）。
 * @param {(url: string, init?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<Response>} fetchImpl
 */
export async function fetchPriceSources(fetchImpl, options = {}) {
	const allowlist = options.hostAllowlist ?? PRICE_HOSTS;
	const timeoutMs = options.timeoutMs ?? PRICE_FETCH_TIMEOUT_MS;
	const signal = options.signal;
	const maxBytes = options.maxBytes ?? PRICE_MAX_BYTES;
	const sources = [];
	const entries = [];
	for (const source of PRICE_SOURCES) {
		const started = Date.now();
		let urlObj = null;
		try {
			urlObj = new URL(source.url);
		} catch {
			sources.push({ id: source.id, label: source.label, ok: false, error: "bad url", ms: 0 });
			continue;
		}
		if (!hostAllowed(urlObj.hostname, allowlist)) {
			sources.push({ id: source.id, label: source.label, ok: false, error: "host not allowed", ms: 0 });
			continue;
		}
		try {
			const res = await fetchImpl(source.url, {
				timeoutMs,
				...(signal ? { signal } : {}),
				headers: { Accept: "application/json", "User-Agent": "pi-web-ui-usage-ledger" },
			});
			if (!res || !res.ok) {
				sources.push({
					id: source.id,
					label: source.label,
					ok: false,
					error: `HTTP ${res?.status ?? "?"}`,
					ms: Date.now() - started,
				});
				continue;
			}
			const text = await res.text();
			if (typeof text === "string" && text.length > maxBytes) {
				sources.push({
					id: source.id,
					label: source.label,
					ok: false,
					error: "response too large",
					ms: Date.now() - started,
				});
				continue;
			}
			let parsed = null;
			try {
				parsed = JSON.parse(text);
			} catch (err) {
				sources.push({
					id: source.id,
					label: source.label,
					ok: false,
					error: `JSON 解析失败：${err?.message ?? err}`,
					ms: Date.now() - started,
				});
				continue;
			}
			const normalized = normalizeSource(source.id, parsed);
			entries.push(...normalized);
			sources.push({
				id: source.id,
				label: source.label,
				ok: true,
				count: normalized.length,
				bytes: text.length,
				ms: Date.now() - started,
			});
		} catch (err) {
			sources.push({
				id: source.id,
				label: source.label,
				ok: false,
				error: String(err?.message ?? err).slice(0, 160),
				ms: Date.now() - started,
			});
		}
	}
	return { entries, sources };
}

/**
 * 只保留账本里用到的模型（可选再按 provider 收敛）。
 * 目的：快照落盘体积可控（真实数据 6 个模型 × 相关 provider ≈ 几十条，而不是 1.2 万条 / 37KB 以上）。
 * @param {unknown[]} entries 归一化后的条目
 * @param {string[]} models 账本出现过的模型
 * @param {string[]} [providers] 账本出现过的路由 provider（会展开成价目表 provider 候选）
 */
export function filterEntriesForModels(entries, models, providers) {
	const wanted = new Set();
	for (const m of models ?? []) for (const cand of modelCandidates(m)) wanted.add(cand);
	if (!wanted.size) return [];
	let wantedProviders = null;
	if (Array.isArray(providers) && providers.length) {
		wantedProviders = new Set();
		for (const provider of providers) for (const cand of pricingProviderCandidates(provider)) wantedProviders.add(cand);
	}
	return (entries ?? []).filter((e) => {
		const modelHit = wanted.has(e.model) || wanted.has(stripProviderPrefix(e.model));
		if (!modelHit) return false;
		if (!wantedProviders || e.source === "override" || e.provider === "*") return true;
		return wantedProviders.has(e.provider);
	});
}

// ────────────────────────────────────────────────────────── 价格簿（含缓存）

/**
 * 价格簿：storage 里的快照 + 异步刷新 + 失败保留旧值。
 * 首屏路径**同步**读快照（可能为空 → 全部显示 `--`），刷新永远在后台跑。
 */
export function createPriceBook(options = {}) {
	const storage = options.storage ?? null;
	const fetchImpl = options.fetchImpl ?? null;
	const log = options.log ?? (() => {});
	const now = options.now ?? (() => Date.now());
	const ttlMs = options.ttlMs ?? PRICE_TTL_MS;
	let snapshot = null;
	let index = buildPriceIndex([]);
	let refreshing = null;
	let lastAttemptAt = 0;

	function readStorage() {
		try {
			const raw = storage?.get?.(PRICE_STORAGE_KEY, null);
			if (!raw || typeof raw !== "object") return null;
			if (!Array.isArray(raw.entries)) return null;
			return raw;
		} catch {
			return null;
		}
	}

	function adopt(next) {
		snapshot = next;
		index = indexFromSnapshot(next);
	}

	/** 同步加载快照（activate 时调用；不联网）。 */
	function load() {
		const stored = readStorage();
		if (stored) adopt(stored);
		return snapshot;
	}

	function status() {
		return describeSnapshot(snapshot, now(), ttlMs);
	}

	function getIndex() {
		return index;
	}

	/**
	 * 触发一次刷新（同一时刻只跑一个）。返回 Promise（测试可 await；生产可不 await）。
	 * @param {{models?: string[], overridesText?: string|null, force?: boolean}} [opts]
	 */
	function refresh(opts = {}) {
		if (refreshing) return refreshing;
		const models = Array.isArray(opts.models) ? opts.models : (snapshot?.models ?? []);
		const providers = Array.isArray(opts.providers) ? opts.providers : (snapshot?.providers ?? []);
		const overridesText = opts.overridesText ?? snapshot?.overridesText ?? "";
		refreshing = (async () => {
			lastAttemptAt = now();
			const overrides = parsePriceOverrides(overridesText);
			try {
				if (!fetchImpl) throw new Error("no fetch implementation");
				const { entries, sources } = await fetchPriceSources(fetchImpl, { signal: opts.signal });
				if (!entries.length) throw new Error("all price sources failed");
				const filtered = filterEntriesForModels(entries, models, providers);
				const next = {
					v: 1,
					fetchedAt: now(),
					ttlMs,
					models,
					providers,
					sources,
					entries: [
						...filtered,
						...(overrides.entries.length ? filterEntriesForModels(overrides.entries, models) : []),
					],
					overridesText,
					overridesError: overrides.error,
					lastError: null,
					refreshFailedAt: null,
				};
				// 覆盖条目按模型名匹配，不受账本模型集合过滤影响（用户可能提前配）
				if (overrides.entries.length) next.entries.push(...overrides.entries);
				adopt(next);
				try {
					storage?.set?.(PRICE_STORAGE_KEY, next);
				} catch (err) {
					log("warn", "price snapshot persist failed:", err?.message ?? err);
				}
				return status();
			} catch (err) {
				const message = String(err?.message ?? err).slice(0, 200);
				// 失败保留旧快照，只标时间与失败态
				snapshot = {
					...(snapshot ?? { v: 1, fetchedAt: 0, entries: [], models: [], sources: [] }),
					overridesError: overrides.error,
					lastError: message,
					refreshFailedAt: now(),
				};
				index = indexFromSnapshot(snapshot);
				log("warn", "price refresh failed:", message);
				return status();
			} finally {
				refreshing = null;
			}
		})();
		return refreshing;
	}

	/**
	 * 需要时后台刷新（不阻塞调用方）：快照缺失 / 过期 / 模型集合未覆盖 / 显式 force。
	 * @returns {{status: object, triggered: boolean}}
	 */
	function ensureFresh(opts = {}) {
		const wanted = Array.isArray(opts.models) ? opts.models : [];
		const needRefresh =
			Boolean(opts.force) ||
			!snapshot ||
			isSnapshotStale(snapshot, now(), ttlMs) ||
			!snapshotCoversModels(snapshot, wanted);
		if (needRefresh && fetchImpl && !refreshing) {
			void refresh({
				models: wanted,
				providers: Array.isArray(opts.providers) ? opts.providers : [],
				overridesText: opts.overridesText,
			});
			return { status: status(), triggered: true };
		}
		return { status: status(), triggered: false };
	}

	return {
		load,
		status,
		getIndex,
		refresh,
		ensureFresh,
		lastAttemptAt: () => lastAttemptAt,
		/** 只读快照（测试 / 调试用）。 */
		snapshot: () => snapshot,
	};
}
