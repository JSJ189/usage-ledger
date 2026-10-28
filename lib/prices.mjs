/**
 * 价格表（2.1.0 新增）：当 SDK 没回填成本时，按公开价格表**估算**金额。
 *
 * 为什么需要：内网网关（liteLLM / cliproxyapi 这类）不回填 `usage.cost.total`，
 * 于是会话 JSONL 里 `cost.total = 0`，看板只能显示 `$0.0000`。
 *
 * 职责边界（本文件只做四件事）：
 *  1. **抓取**：三个公开源（models.dev / LiteLLM / OpenRouter），失败互不影响；
 *  2. **归一**：统一成「USD / 每 1M token」的 `{input, output, cacheRead, cacheWrite}`；
 *  3. **缓存**：写 `host.dataDir/prices.json`，TTL 7 天；读缓存不联网；
 *  4. **解析**：`resolvePrice(model, hints)` 纯函数，候选可枚举、选择规则确定。
 *
 * 三条不可违反的口径：
 *  - **绝不把缺价当 0**：`input`/`output` 任一缺失 = 该行不可用；`cacheRead`/`cacheWrite`
 *    缺失时按 `input` 计，并在 `priceNote` 里标 `cacheRead≈input` / `cacheWrite≈input`。
 *  - **绝不写死模型名**：官方厂商只按前缀规则映射（qwen/gemini/grok/mimo/deepseek…），
 *    具体价格一律来自抓取结果或用户覆盖。
 *  - **候选必须可枚举**：`resolvePrice()` 恒返回全部候选（来源 / 供应商 / 四项价），
 *    前端能列出「同一个模型不同源差 3 倍」并让用户用 `priceOverrides` 选。
 *
 * 单位约定：内存与落盘里所有价格都是 **USD / 1M tokens**；归一化时 LiteLLM 与
 * OpenRouter 的 per-token 价要 ×1e6。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 缓存文件名（放 `host.dataDir` 下）。 */
export const PRICE_CACHE_FILE = "prices.json";
/** 缓存 TTL：7 天。 */
export const PRICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 单个源的响应上限（models.dev 实测 ~6MB，留余量但拒绝无限流）。 */
export const PRICE_MAX_BYTES = 32 * 1024 * 1024;
/** 单源请求超时。 */
export const PRICE_FETCH_TIMEOUT_MS = 30_000;
/** 缓存文件结构版本。 */
export const PRICE_SCHEMA = 1;

/** 三个价格源。失败互不影响：任何一个挂了只记 `sources[].ok=false`。 */
export const PRICE_SOURCES = [
	{
		id: "modelsdev",
		label: "models.dev",
		url: "https://models.dev/api.json",
		/** 源内单位：已经是 USD / 1M。 */
		unit: "perMillion",
		priority: 1,
	},
	{
		id: "litellm",
		label: "LiteLLM",
		url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
		unit: "perToken",
		priority: 2,
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		url: "https://openrouter.ai/api/v1/models",
		unit: "perToken",
		priority: 3,
	},
];

/** 源 id → 源定义。 */
export const SOURCE_BY_ID = new Map(PRICE_SOURCES.map((s) => [s.id, s]));

/**
 * 官方厂商规则：模型名前缀 → 该模型「官方」价格行的供应商候选（按优先级）。
 *
 * 这是**唯一**与模型名有关的生产逻辑，只表达「谁是这个模型的官方厂商」，
 * 不含任何具体价格。命中规则后，多来源候选里只有来自这些供应商的行算「官方行」。
 */
export const OFFICIAL_VENDORS = [
	{ test: /^qwen/i, vendors: ["alibaba-cn", "alibaba"] },
	{ test: /^qwq/i, vendors: ["alibaba-cn", "alibaba"] },
	{ test: /^gemini/i, vendors: ["google"] },
	{ test: /^grok/i, vendors: ["xai"] },
	{ test: /^mimo/i, vendors: ["xiaomi"] },
	{ test: /^deepseek/i, vendors: ["deepseek", "alibaba-cn", "alibaba"] },
	{ test: /^claude/i, vendors: ["anthropic"] },
	{ test: /^gpt|^o\d/i, vendors: ["openai"] },
];

/** 可剥离的「变体后缀」：`gemini-3.8-flash-high` → `gemini-3.8-flash`。 */
const VARIANT_SUFFIXES = [
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
	"-next",
	"-latest",
	"-preview",
	"-instruct",
	"-chat",
];

function toNum(v) {
	if (v === null || v === undefined) return null;
	if (typeof v === "string" && !v.trim()) return null;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

function toStr(v) {
	if (typeof v !== "string") return null;
	const s = v.trim();
	return s ? s : null;
}

/** per-token → per-1M（LiteLLM / OpenRouter 都要过这一步）。四舍五入到 9 位小数，避免 0.8250000000000001 这种浮点尾巴。 */
export function perTokenToPerMillion(value) {
	const n = toNum(value);
	if (n === null) return null;
	return Math.round(n * 1e6 * 1e9) / 1e9;
}

// ──────────────────────────────────────────────────────────── 名称归一

/** 去掉 `provider/` 前缀与 `:batch` 这类变体后缀。 */
export function stripProviderPrefix(model) {
	let s = String(model ?? "").trim();
	const slash = s.lastIndexOf("/");
	if (slash >= 0 && slash < s.length - 1) s = s.slice(slash + 1);
	const colon = s.indexOf(":");
	if (colon > 0) s = s.slice(0, colon);
	return s;
}

/**
 * 剥掉**一层**变体后缀：`gemini-3.8-flash-high` → `gemini-3.8-flash`。
 * `-1017` 这类纯数字尾号也剥（网关给模型加的内部版本号）。
 */
export function stripVariant(model) {
	const s = String(model ?? "").trim();
	for (const suffix of VARIANT_SUFFIXES) {
		if (s.toLowerCase().endsWith(suffix) && s.length > suffix.length) {
			return s.slice(0, -suffix.length);
		}
	}
	const m = /^(.*\D)-\d{3,}$/.exec(s);
	if (m) return m[1];
	return s;
}

/**
 * 模型名 → 匹配候选（小写去重、保序）：
 * 原样 → 剥变体后缀 → 剥 vendor 前缀 → 再剥一层变体后缀（`deepseek-v4.1-flash-1017`）。
 */
export function modelCandidates(model) {
	const raw = String(model ?? "").trim();
	const out = [];
	const push = (v) => {
		const key = String(v ?? "")
			.trim()
			.toLowerCase();
		if (key && !out.includes(key)) out.push(key);
	};
	push(raw);
	push(stripVariant(raw));
	push(stripProviderPrefix(raw));
	push(stripProviderPrefix(stripVariant(raw)));
	push(stripVariant(stripProviderPrefix(stripVariant(raw))));
	return out;
}

/**
 * 模型名的「官方供应商」候选（按前缀规则；没有规则命中 → 空数组）。
 * @param {string} model
 * @returns {string[]}
 */
export function officialVendorsOf(model) {
	const bare = stripProviderPrefix(String(model ?? "").trim()).toLowerCase();
	for (const rule of OFFICIAL_VENDORS) {
		if (rule.test.test(bare)) return [...rule.vendors];
	}
	return [];
}

// ──────────────────────────────────────────────────────────── 三源归一

/** 四项价（USD / 1M token）：统一归一到 9 位小数。 */
function priceBag({ input, output, cacheRead, cacheWrite }) {
	const norm = (v) => {
		const n = toNum(v);
		return n === null ? null : Math.round(n * 1e9) / 1e9;
	};
	return {
		input: norm(input),
		output: norm(output),
		cacheRead: norm(cacheRead),
		cacheWrite: norm(cacheWrite),
	};
}

/** 有 input + output 价才算「可计价」（缺价绝不是 0 价）。 */
export function hasCorePrices(prices) {
	return Boolean(prices) && prices.input !== null && prices.output !== null;
}

/** 价格行 id（稳定、可读、可写进 priceOverrides 的日志）。 */
export function priceRowId(source, provider, model) {
	return `${source}:${String(provider ?? "").toLowerCase()}/${model}`;
}

function makeRow({ source, provider, model, prices }) {
	const vendored = toStr(provider)?.toLowerCase() ?? "";
	const name = toStr(model) ?? "";
	if (!vendored || !name || !hasCorePrices(prices)) return null;
	return {
		id: priceRowId(source, vendored, name),
		source,
		provider: vendored,
		model: name,
		input: prices.input,
		output: prices.output,
		cacheRead: prices.cacheRead,
		cacheWrite: prices.cacheWrite,
	};
}

/**
 * models.dev：`{<provider>: {models: {<modelId>: {cost: {input, output, cache_read, cache_write}}}}}`
 * 单位已经是 USD / 1M。
 */
export function normalizeModelsDev(json) {
	const rows = [];
	if (!json || typeof json !== "object") return rows;
	for (const [provider, providerEntry] of Object.entries(json)) {
		const models = providerEntry?.models;
		if (!models || typeof models !== "object") continue;
		for (const [modelId, model] of Object.entries(models)) {
			const cost = model?.cost;
			if (!cost || typeof cost !== "object") continue;
			const row = makeRow({
				source: "modelsdev",
				provider,
				model: modelId,
				prices: priceBag({
					input: cost.input,
					output: cost.output,
					cacheRead: cost.cache_read,
					cacheWrite: cost.cache_write,
				}),
			});
			if (row) rows.push(row);
		}
	}
	return rows;
}

/**
 * LiteLLM：键形如 `gemini/gemini-3.8-flash`，字段是 **per token**，要 ×1e6。
 * `litellm_provider` 才是供应商，键前缀只是路由。
 */
export function normalizeLiteLlm(json) {
	const rows = [];
	if (!json || typeof json !== "object") return rows;
	for (const [key, row] of Object.entries(json)) {
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		const model = stripProviderPrefix(key);
		const provider = toStr(row.litellm_provider) ?? (key.includes("/") ? key.split("/")[0] : "");
		const built = makeRow({
			source: "litellm",
			provider,
			model,
			prices: priceBag({
				input: perTokenToPerMillion(row.input_cost_per_token),
				output: perTokenToPerMillion(row.output_cost_per_token),
				cacheRead: perTokenToPerMillion(row.cache_read_input_token_cost),
				cacheWrite: perTokenToPerMillion(row.cache_creation_input_token_cost),
			}),
		});
		if (built) rows.push(built);
	}
	return rows;
}

/**
 * OpenRouter：`{data: [{id: "x-ai/grok-4.7", pricing: {prompt, completion, input_cache_read, input_cache_write}}]}`
 * 价格是 **per token 字符串**，要 ×1e6。
 */
export function normalizeOpenRouter(json) {
	const rows = [];
	const list = Array.isArray(json?.data) ? json.data : [];
	for (const row of list) {
		const id = toStr(row?.id);
		const pricing = row?.pricing;
		if (!id || !pricing || typeof pricing !== "object") continue;
		const slash = id.lastIndexOf("/");
		const provider = slash > 0 ? id.slice(0, slash) : "";
		const model = slash > 0 ? id.slice(slash + 1) : id;
		const built = makeRow({
			source: "openrouter",
			provider,
			model,
			prices: priceBag({
				input: perTokenToPerMillion(pricing.prompt),
				output: perTokenToPerMillion(pricing.completion),
				cacheRead: perTokenToPerMillion(pricing.input_cache_read),
				cacheWrite: perTokenToPerMillion(pricing.input_cache_write),
			}),
		});
		if (built) rows.push(built);
	}
	return rows;
}

/** 按源 id 分派解析（未知 id → 空数组）。 */
export function normalizeSource(sourceId, json) {
	if (sourceId === "modelsdev") return normalizeModelsDev(json);
	if (sourceId === "litellm") return normalizeLiteLlm(json);
	if (sourceId === "openrouter") return normalizeOpenRouter(json);
	return [];
}

// ──────────────────────────────────────────────────────────── 用户覆盖

/**
 * 解析 `settings.priceOverrides`：对象或 JSON 字符串，结构
 * `{ "<model>": { input, output, cacheRead, cacheWrite } }`（USD / 1M）。
 * 非法条目跳过并记 `errors`，绝不抛错。
 * @returns {{rows: object[], errors: string[]}}
 */
export function parsePriceOverrides(input) {
	const rows = [];
	const errors = [];
	let raw = input;
	if (typeof raw === "string") {
		const text = raw.trim();
		if (!text) return { rows, errors };
		try {
			raw = JSON.parse(text);
		} catch (err) {
			return { rows, errors: [`priceOverrides 不是合法 JSON：${String(err?.message ?? err)}`] };
		}
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { rows, errors };
	for (const [model, spec] of Object.entries(raw)) {
		const name = toStr(model);
		if (!name) continue;
		if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
			errors.push(`priceOverrides["${name}"] 不是对象`);
			continue;
		}
		const prices = priceBag({ input: spec.input, output: spec.output, cacheRead: spec.cacheRead, cacheWrite: spec.cacheWrite });
		if (!hasCorePrices(prices)) {
			errors.push(`priceOverrides["${name}"] 缺 input/output 价，已跳过`);
			continue;
		}
		rows.push({
			id: `override:${name}`,
			source: "override",
			provider: "user",
			model: name,
			input: prices.input,
			output: prices.output,
			cacheRead: prices.cacheRead,
			cacheWrite: prices.cacheWrite,
		});
	}
	return { rows, errors };
}

// ──────────────────────────────────────────────────────────── 索引与解析

/**
 * 建索引：`模型名（小写）→ 价格行[]`。同一模型可能有多个来源 / 供应商的行。
 * @param {object[]} rows
 */
export function buildPriceIndex(rows) {
	const byModel = new Map();
	const list = Array.isArray(rows) ? rows : [];
	for (const row of list) {
		if (!row || !hasCorePrices(row)) continue;
		const key = String(row.model ?? "")
			.trim()
			.toLowerCase();
		if (!key) continue;
		let bucket = byModel.get(key);
		if (!bucket) {
			bucket = [];
			byModel.set(key, bucket);
		}
		bucket.push(row);
	}
	return { byModel, size: byModel.size };
}

function sourceRank(source) {
	if (source === "override") return 0;
	return SOURCE_BY_ID.get(source)?.priority ?? 9;
}

/**
 * 枚举候选：按模型名候选列表逐层命中。**每一层的行都保留**（不因第一层命中就停），
 * 但带上 `matchLevel`（层号：0 = 原名精确），供选择规则区分「精确」与「变体」。
 * 顺序（确定性，测试可断言）：
 *  1. 用户覆盖行（`source:"override"`）；
 *  2. 官方厂商行（前缀规则命中的供应商）；
 *  3. 其余行：源优先级（models.dev > LiteLLM > OpenRouter）→ 供应商 → 模型名。
 *
 * @param {string} model 账本里的模型名
 * @param {{index?: ReturnType<typeof buildPriceIndex>|null, overrides?: object[]}} hints
 * @returns {object[]} 价格行副本（带 `official` 布尔与 `matchLevel` 数字）
 */
export function priceCandidates(model, hints = {}) {
	const index = hints.index ?? null;
	const overrides = Array.isArray(hints.overrides) ? hints.overrides : [];
	const names = modelCandidates(model);
	const rawName = String(model ?? "").trim().toLowerCase();
	const out = [];
	const seen = new Set();
	const push = (row, official, matchLevel) => {
		if (!row || seen.has(row.id)) return;
		seen.add(row.id);
		out.push({ ...row, official, matchLevel });
	};
	// 1. 用户覆盖：只认原样名字（用户写的是账本里看到的那个名字）
	for (const row of overrides) {
		const name = String(row.model ?? "").toLowerCase();
		if (name === rawName) push(row, false, 0);
	}
	const vendors = officialVendorsOf(model);
	names.forEach((name, level) => {
		const bucket = index?.byModel?.get(name);
		if (!bucket || !bucket.length) return;
		// 2. 官方厂商行：同一层内按「源优先级 → 规则内供应商顺序」排，保证确定性
		const officials = [];
		for (const row of bucket) {
			if (vendors.includes(String(row.provider ?? "").toLowerCase())) officials.push(row);
		}
		officials.sort(
			(a, b) =>
				sourceRank(a.source) - sourceRank(b.source) ||
				vendors.indexOf(String(a.provider).toLowerCase()) -
					vendors.indexOf(String(b.provider).toLowerCase()) ||
				a.id.localeCompare(b.id),
		);
		for (const row of officials) push(row, true, level);
		// 3. 其余行
		const rest = [...bucket].sort(
			(a, b) =>
				sourceRank(a.source) - sourceRank(b.source) ||
				String(a.provider).localeCompare(String(b.provider)) ||
				String(a.model).localeCompare(String(b.model)),
		);
		for (const row of rest) push(row, false, level);
	});
	return out;
}

/**
 * 解析模型价（**纯函数**，无 IO、不联网）。
 *
 * 选择规则（brief A6）：
 *  1. 用户覆盖 `priceOverrides[model]` 优先；
 *  2. 官方厂商行：先按**名字层**（原名 > 剥变体后缀 > 剥 vendor 前缀），再按
 *     源优先级（models.dev > LiteLLM > OpenRouter），再按规则内的供应商顺序；
 *     这一步必须确定性：同一模型多来源时不能随抓取顺序变价；
 *  3. 没有官方行 → 取「多来源中位数」（按 input 价升序取中位那一行；偶数个候选
 *     取偏低的那个，宁可少估也不多估）；
 *  4. 一个候选都没有 → `price:null`（看板显示 `--`）。
 *
 * @param {string} model
 * @param {{index?: object|null, overrides?: object[]|string|object}} hints
 * @returns {{price: object|null, via: "override"|"official"|"median"|null, candidates: object[]}}
 */
export function resolvePrice(model, hints = {}) {
	const overrides =
		Array.isArray(hints.overrides)
			? hints.overrides
			: parsePriceOverrides(hints.overrides ?? hints.priceOverrides).rows;
	const candidates = priceCandidates(model, { index: hints.index ?? null, overrides });
	if (!candidates.length) return { price: null, via: null, candidates };
	const override = candidates.find((c) => c.source === "override");
	if (override) return { price: override, via: "override", candidates };
	const vendorOrder = officialVendorsOf(model);
	const officials = candidates
		.filter((c) => c.official === true)
		.sort(
			(a, b) =>
				(a.matchLevel ?? 0) - (b.matchLevel ?? 0) ||
				sourceRank(a.source) - sourceRank(b.source) ||
				vendorOrder.indexOf(String(a.provider).toLowerCase()) - vendorOrder.indexOf(String(b.provider).toLowerCase()) ||
				a.id.localeCompare(b.id),
		);
	if (officials.length) return { price: officials[0], via: "official", candidates };
	const sorted = [...candidates].sort((a, b) => a.input - b.input || a.output - b.output || a.id.localeCompare(b.id));
	const median = sorted[Math.floor((sorted.length - 1) / 2)];
	return { price: median, via: "median", candidates };
}

// ──────────────────────────────────────────────────────────── 估算

/**
 * 估算一条记录的成本（USD）。**纯函数**。
 *
 * 口径（brief A4）：
 *  - `promptTokens = input + cacheRead + cacheWrite`；
 *  - `usd = (input*pIn + output*pOut + cacheRead*pCacheRead + cacheWrite*pCacheWrite) / 1e6`；
 *  - 缺 `cacheRead` 价 → 按 `pIn` 计，`note` 标 `cacheRead≈input`（同理 `cacheWrite`）；
 *  - 记录里没有任何 token 字段（live 记录 / 老会话）→ `null`（不是 $0）。
 *
 * @param {object|null} price resolvePrice 命中的价格行
 * @param {object} record
 * @returns {{usd:number, promptTokens:number, note:string}|null}
 */
export function estimateCost(price, record) {
	if (!price || !hasCorePrices(price)) return null;
	const input = toNum(record?.inputTokens);
	const output = toNum(record?.outputTokens);
	const cacheRead = toNum(record?.cacheReadTokens);
	const cacheWrite = toNum(record?.cacheWriteTokens);
	if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
	const inTok = input ?? 0;
	const outTok = output ?? 0;
	const readTok = cacheRead ?? 0;
	const writeTok = cacheWrite ?? 0;
	const pRead = price.cacheRead === null ? price.input : price.cacheRead;
	const pWrite = price.cacheWrite === null ? price.input : price.cacheWrite;
	const usd =
		(inTok * price.input + outTok * price.output + readTok * pRead + writeTok * pWrite) / 1e6;
	const notes = [];
	if (price.cacheRead === null) notes.push("cacheRead≈input");
	if (price.cacheWrite === null) notes.push("cacheWrite≈input");
	return {
		usd: Math.round(usd * 1e9) / 1e9,
		promptTokens: inTok + readTok + writeTok,
		note: notes.join(" "),
	};
}

/**
 * 给一条记录补齐计价字段（**纯函数**，返回新对象，绝不改原记录）。
 *
 * 字段语义（brief A5）：
 *  - `costUsd`：生效成本。SDK `> 0` 用 SDK；否则用估算；两者都无 → `null`。
 *  - `costSource`：`"sdk"` | `"estimate"` | `null`。
 *  - `costEstimateUsd`：估算值，**永远保留**（有 SDK 成本时也留着对照）。
 *  - `priceId`：命中的价格行 id（没命中 → `null`）。
 *  - `priceNote`：口径备注（`cacheRead≈input` 之类）。
 *
 * @param {object} record
 * @param {object|null} price 已解析的价格行
 */
export function applyPricing(record, price) {
	const sdk = toNum(record?.costUsd);
	const estimate = estimateCost(price, record);
	const base = {
		...record,
		costEstimateUsd: estimate ? estimate.usd : null,
		priceId: price ? price.id : null,
		priceNote: estimate ? estimate.note : "",
	};
	if (sdk !== null && sdk > 0) return { ...base, costUsd: sdk, costSource: "sdk" };
	if (estimate) return { ...base, costUsd: estimate.usd, costSource: "estimate" };
	return { ...base, costUsd: null, costSource: null };
}

// ──────────────────────────────────────────────────────────── 快照与缓存

/** 缓存快照是否过期（没有快照也算过期）。 */
export function isSnapshotStale(snapshot, now = Date.now(), ttlMs = PRICE_TTL_MS) {
	if (!snapshot || !toNum(snapshot.fetchedAt)) return true;
	return now - Number(snapshot.fetchedAt) >= ttlMs;
}

/** 空快照（没有缓存、刷新全失败时用）。 */
export function emptySnapshot() {
	return { schema: PRICE_SCHEMA, fetchedAt: 0, sources: [], entries: [], lastError: null };
}

/**
 * 抓取三个源并归一。**任何失败只写进 `sources[]`，绝不抛错**（接口不能 500）。
 * @param {(url:string, init?:object)=>Promise<{ok?:boolean,status?:number,text:()=>Promise<string>,json?:()=>Promise<unknown>}>} fetchImpl
 * @param {{log?:Function, now?:Function, maxBytes?:number}} [options]
 * @returns {Promise<{entries:object[], sources:object[]}>}
 */
export async function fetchPriceSources(fetchImpl, options = {}) {
	const log = typeof options.log === "function" ? options.log : () => {};
	const maxBytes = toNum(options.maxBytes) ?? PRICE_MAX_BYTES;
	const entries = [];
	const sources = [];
	for (const source of PRICE_SOURCES) {
		const started = Date.now();
		const record = { id: source.id, label: source.label, ok: false, count: 0, ms: 0, error: null };
		try {
			if (typeof fetchImpl !== "function") throw new Error("host.fetch 不可用（缺 http 权限）");
			const res = await fetchImpl(source.url, {
				timeoutMs: PRICE_FETCH_TIMEOUT_MS,
				headers: { Accept: "application/json" },
			});
			if (!res || res.ok === false) throw new Error(`HTTP ${res?.status ?? "?"}`);
			const text = typeof res.text === "function" ? await res.text() : JSON.stringify(await res.json?.());
			const body = String(text ?? "");
			if (body.length > maxBytes) throw new Error(`响应过大（${body.length} 字节）`);
			const parsed = JSON.parse(body);
			const rows = normalizeSource(source.id, parsed);
			entries.push(...rows);
			record.ok = true;
			record.count = rows.length;
		} catch (err) {
			record.error = String(err?.message ?? err).slice(0, 200);
			log("warn", `价格源 ${source.label} 抓取失败（不影响其它源）：`, record.error);
		}
		record.ms = Date.now() - started;
		sources.push(record);
	}
	return { entries, sources };
}

/**
 * 价格簿：缓存 + 解析 + 刷新。所有公共方法都不抛错。
 *
 * @param {object} options
 * @param {string} [options.dir] `host.dataDir`（写 `prices.json`）
 * @param {Function} [options.fetch] `host.fetch`
 * @param {() => Record<string, unknown>} [options.getSettings]
 * @param {(level:string, ...args:unknown[])=>void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 */
export function createPriceBook(options = {}) {
	const dir = typeof options.dir === "string" ? options.dir : "";
	const fetchImpl = typeof options.fetch === "function" ? options.fetch : null;
	const getSettings = typeof options.getSettings === "function" ? options.getSettings : () => ({});
	const log = typeof options.log === "function" ? options.log : () => {};
	const now = typeof options.now === "function" ? options.now : () => Date.now();
	const ttlMs = toNum(options.ttlMs) ?? PRICE_TTL_MS;
	const path = dir ? join(dir, PRICE_CACHE_FILE) : "";

	let snapshot = emptySnapshot();
	let index = buildPriceIndex([]);
	let refreshing = null;
	let lastAttemptAt = 0;
	/** 解析结果记忆化：同一模型在一次快照 / 覆盖配置下只解析一次（brief 硬约束 8）。 */
	let resolveCache = new Map();
	/** 设置项原始值的记忆化：`priceOverrides` 的 JSON.parse 不能每条记录都跑一遍。 */
	let overridesRaw;
	let overridesCache = { rows: [], errors: [] };

	function overridesOf() {
		const settings = (() => {
			try {
				return getSettings() ?? {};
			} catch {
				return {};
			}
		})();
		const raw = settings.priceOverrides;
		if (raw === overridesRaw) return overridesCache;
		overridesRaw = raw;
		overridesCache = parsePriceOverrides(raw);
		resolveCache = new Map();
		return overridesCache;
	}

	function adopt(next) {
		snapshot = next;
		index = buildPriceIndex(next.entries);
		resolveCache = new Map();
	}

	/** 读缓存（同步、不联网）。坏文件按空快照处理。 */
	function load() {
		if (!path) return snapshot;
		try {
			if (!existsSync(path)) return snapshot;
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) return snapshot;
			adopt({
				schema: PRICE_SCHEMA,
				fetchedAt: toNum(parsed.fetchedAt) ?? 0,
				sources: Array.isArray(parsed.sources) ? parsed.sources : [],
				entries: parsed.entries,
				lastError: parsed.lastError ?? null,
			});
		} catch (err) {
			log("warn", "价格缓存读取失败（按空价格表继续）：", String(err?.message ?? err));
		}
		return snapshot;
	}

	function save() {
		if (!path) return false;
		try {
			mkdirSync(dir, { recursive: true });
			const tmp = `${path}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, "utf8");
			renameSync(tmp, path);
			return true;
		} catch (err) {
			log("warn", "价格缓存写入失败（本次运行仍可用）：", String(err?.message ?? err));
			return false;
		}
	}

	/** 快照状态（前端展示「价格表：<时间>（N 条 / 失败源）」）。 */
	function status() {
		const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
		return {
			available: index.size > 0,
			stale: isSnapshotStale(snapshot, now(), ttlMs),
			fetchedAt: toNum(snapshot.fetchedAt) ?? null,
			ttlMs,
			entries: Array.isArray(snapshot.entries) ? snapshot.entries.length : 0,
			models: index.size,
			sources: sources.map((s) => ({
				id: s.id,
				label: s.label,
				ok: s.ok === true,
				count: toNum(s.count) ?? 0,
				ms: toNum(s.ms) ?? 0,
				error: s.error ?? null,
			})),
			failed: sources.filter((s) => s.ok !== true).map((s) => s.label ?? s.id),
			lastError: snapshot.lastError ?? null,
			overridesError: overridesOf().errors[0] ?? null,
		};
	}

	/**
	 * 刷新（同一时刻只跑一个）。失败保留旧快照，只更新 `lastError`。
	 * @returns {Promise<object>} status()
	 */
	function refresh() {
		if (refreshing) return refreshing;
		refreshing = (async () => {
			lastAttemptAt = now();
			try {
				const { entries, sources } = await fetchPriceSources(fetchImpl, { log, maxBytes: PRICE_MAX_BYTES });
				const okCount = sources.filter((s) => s.ok).length;
				if (!entries.length) throw new Error(okCount ? "三个源都没解析出可计价的行" : "三个价格源全部失败");
				adopt({
					schema: PRICE_SCHEMA,
					fetchedAt: now(),
					sources,
					entries,
					lastError: null,
				});
				save();
				log("info", `价格表已刷新：${entries.length} 行（源 ${sources.map((s) => `${s.label}:${s.ok ? s.count : "失败"}`).join("，")}）`);
				return status();
			} catch (err) {
				const message = String(err?.message ?? err).slice(0, 200);
				snapshot = { ...snapshot, lastError: message };
				log("warn", "价格表刷新失败（保留旧快照）：", message);
				return status();
			} finally {
				refreshing = null;
			}
		})();
		return refreshing;
	}

	/** 按需后台刷新（不阻塞调用方；缓存缺失 / 过期时触发）。 */
	function ensureFresh({ force = false } = {}) {
		const need = force || isSnapshotStale(snapshot, now(), ttlMs);
		if (need && fetchImpl && !refreshing) {
			void refresh();
			return { triggered: true, status: status() };
		}
		return { triggered: false, status: status() };
	}

	/**
	 * 解析模型价（记忆化：同一模型在一次快照 / 覆盖配置下只解析一次）。
	 * @param {string} model
	 */
	function resolve(model) {
		// 先探一下设置（raw 值比较，O(1)）：priceOverrides 改了会就地清掉缓存
		overridesOf();
		const key = String(model ?? "");
		const hit = resolveCache.get(key);
		if (hit) return hit;
		const resolved = resolvePrice(key, { index, overrides: overridesOf().rows });
		resolveCache.set(key, resolved);
		return resolved;
	}

	/** 给一条记录补计价字段（记忆化在 resolve 里，这里只剩乘法）。 */
	function price(record) {
		return applyPricing(record, resolve(record?.model ?? "")?.price ?? null);
	}

	return {
		path,
		load,
		status,
		refresh,
		ensureFresh,
		resolve,
		price,
		/** 只读快照（测试 / 诊断用）。 */
		snapshot: () => snapshot,
		index: () => index,
		lastAttemptAt: () => lastAttemptAt,
		/** 设置变了（priceOverrides）→ 清记忆化。 */
		invalidate() {
			overridesRaw = undefined;
			overridesCache = { rows: [], errors: [] };
			resolveCache = new Map();
		},
	};
}

export default createPriceBook;
