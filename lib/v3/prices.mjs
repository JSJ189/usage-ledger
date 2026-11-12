/**
 * v3 价格表（合同 §4.12）：抓取三源 → 归一成「USD / 1M token」→ 快照缓存 → 纯函数解析 → 计价。
 *
 * 为什么需要：内网网关（liteLLM / cliproxyapi 这类）不回填 `usage.cost.total`，
 * 会话 JSONL 里 `cost.total = 0`，库里 `cost_sdk` 也就没有真值。价格表的唯一职责是
 * 在这个空档里给一个**可复现**的估算，并把「没价」明确标成 `unpriced`。
 *
 * 与 v2 `lib/prices.mjs` 的关系：解析规则、三源归一、`priceOverrides` 语义照搬，
 * 两处结构性改动：
 *  1. **设置来自快照参数**（`getSettingsSnapshot()`），热路径零文件读（合同 §一.2）；
 *  2. 输出形状改成 v3 的**纯价格对象**（`promptPerM` / `outputPerM` / …），
 *     记录行只拿补丁（`{costEst, costSource, priceId, priceVersion}`），不再整行复制。
 *
 * 四条不可违反的口径（合同 §三 + 方案 §2.8）：
 *  - **绝不把缺价当 0**：`input`/`output` 任一缺失 = 该行不可计价；`cacheRead`/`cacheWrite`
 *    缺失时按 `input` 价计，并在 `estimateCost().note` 里标 `cacheRead≈input` / `cacheWrite≈input`。
 *  - **`cost_sdk` 优先**：SDK 报了值（含合法的 0）就不写 `costEst`，避免同一笔账被数两次。
 *  - **绝不写死模型名**：官方厂商只按前缀规则映射（qwen/gemini/grok/mimo/deepseek…），
 *    具体价格一律来自抓取结果或用户覆盖。
 *  - **一个模型一个价**：候选顺序确定性（名字层 → 源优先级 → 规则内供应商顺序 → id），
 *    同一份快照 + 同一份设置永远解析出同一个 `priceId`。
 *
 * 单位：内存与 `prices.json` 里所有价格都是 **USD / 1M tokens**。LiteLLM 与 OpenRouter
 * 给的是 per-token，归一化时 ×1e6（v2 已知坑①）。
 *
 * 快照（`<dir>/prices.json`）：
 * ```
 * { schema: 2, version: 7, fetchedAt: 1794399448630,
 *   sources: [{id, label, ok, count, ms, error}], entries: [价格行], lastError: null }
 * ```
 * `version` 每次**成功**刷新 +1（失败不动）；`entries` 与 v2 同构，老快照可直接读。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 快照文件名（放状态目录，即 `~/.pi-web/plugin-data/usage-ledger/`）。 */
export const PRICE_CACHE_FILE = "prices.json";
/** 快照 TTL：7 天（超过只在 `ensureFresh()` 里触发后台刷新，旧价继续可用）。 */
export const PRICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 单个源的响应上限（models.dev 实测 ~6MB，留余量但拒绝无限流）。 */
export const PRICE_MAX_BYTES = 32 * 1024 * 1024;
/** 单源请求超时（宿主 `host.fetch` 的 `timeoutMs`，上限 600_000）。 */
export const PRICE_FETCH_TIMEOUT_MS = 30_000;
/** 快照结构版本（2 = v3：多了 `version`）。 */
export const PRICE_SCHEMA = 2;

/**
 * 三个价格源。**失败互不影响**：任何一个挂了只记 `sources[].ok=false`，
 * 其余源照样入表（v2 行为，实测三源覆盖不同）。
 */
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
 * 官方厂商规则：模型名前缀 → 该模型「官方」价格行的供应商候选（**按优先级**）。
 *
 * 这是**唯一**与模型名有关的生产逻辑，只表达「谁是这个模型的官方厂商」，
 * 不含任何具体价格（v2 口径，见来源优先级要求）。
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

/**
 * 可剥离的「变体后缀」：`gemini-3.8-flash-high` → `gemini-3.8-flash`。
 * 这些不是模型名的一部分，是同一模型的参数档位（网关还会自己加 `-1017` 这类尾号）。
 */
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

/**
 * per-token → per-1M（LiteLLM / OpenRouter 必过）。四舍五入到 9 位小数，
 * 避免 `0.8250000000000001` 这种浮点尾巴进快照（v2 已知坑①）。
 */
export function perTokenToPerMillion(value) {
	const n = toNum(value);
	if (n === null) return null;
	return Math.round(n * 1e6 * 1e9) / 1e9;
}

// ──────────────────────────────────────────────────────── 名称归一

/** 去掉 `provider/` 前缀与 `:batch` 这类路由后缀。 */
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
	const lower = s.toLowerCase();
	for (const suffix of VARIANT_SUFFIXES) {
		if (lower.endsWith(suffix) && s.length > suffix.length) return s.slice(0, -suffix.length);
	}
	const m = /^(.*\D)-\d{3,}$/.exec(s);
	if (m) return m[1];
	return s;
}

/**
 * 模型名 → 规范 id：剥 `provider/` 前缀 + **反复**剥变体后缀。
 * `xiaomi/mimo-v2.6-pro-high` → `mimo-v2.6-pro`；`deepseek-v4.1-flash-1017` → `deepseek-v4.1-flash`。
 * 最多剥 4 层（`-high` 之外再叠 `-reasoning` 这类双层后缀时才有用），防止死循环。
 */
export function normalizeModelId(model) {
	let s = stripProviderPrefix(model);
	for (let i = 0; i < 4; i++) {
		const next = stripVariant(s);
		if (next === s) break;
		s = next;
	}
	return s;
}

/**
 * 模型名 → 匹配候选（小写去重、保序，层次即优先级）：
 * 原名 → 剥一层变体 → 剥 vendor 前缀 → 规范化（多轮剥）。
 * `matchLevel` 越小越「精确」，解析时先看小层（v2 `priceCandidates` 语义）。
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
	push(normalizeModelId(raw));
	return out;
}

/**
 * 模型名的「官方供应商」候选（按前缀规则；没有规则命中 → 空数组）。
 * @param {string} model
 * @returns {string[]}
 */
export function officialVendorsOf(model) {
	const bare = normalizeModelId(model).toLowerCase();
	for (const rule of OFFICIAL_VENDORS) {
		if (rule.test.test(bare)) return [...rule.vendors];
	}
	return [];
}

// ──────────────────────────────────────────────────────── 三源归一

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

/** 有 `input` + `output` 价才算「可计价」（缺价绝不是 0 价）。 */
export function hasCorePrices(prices) {
	return Boolean(prices) && prices.input !== null && prices.output !== null;
}

/** 价格行 id（稳定、可读、可写进日志与 `priceOverrides` 对照）。 */
export function priceRowId(source, provider, model) {
	return `${source}:${String(provider ?? "").toLowerCase()}/${model}`;
}

function makeRow({ source, provider, model, prices }) {
	const vendor = toStr(provider)?.toLowerCase() ?? "";
	const name = toStr(model) ?? "";
	if (!vendor || !name || !hasCorePrices(prices)) return null;
	return {
		id: priceRowId(source, vendor, name),
		source,
		provider: vendor,
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
 * 价格是 **per token 字符串**，要 ×1e6（v2 已知坑①）。
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

const NORMALIZERS = {
	modelsdev: normalizeModelsDev,
	litellm: normalizeLiteLlm,
	openrouter: normalizeOpenRouter,
};

/**
 * 解析（归一）价格源。两种调用形态：
 *  - `parsePriceSources("modelsdev", json)` → 该源的价格行；
 *  - `parsePriceSources({ modelsdev: json, openrouter: json })` → 三源的行的拼接
 *    （map 里没出现的源跳过；未知源 id 忽略）。
 * 任何输入都不抛错（坏结构 → 空数组），因为刷新失败不能连累接口。
 */
export function parsePriceSources(sourceOrPayloads, payload) {
	const out = [];
	if (typeof sourceOrPayloads === "string") {
		const normalize = NORMALIZERS[sourceOrPayloads];
		if (!normalize) return out;
		out.push(...normalize(payload));
		return out;
	}
	if (!sourceOrPayloads || typeof sourceOrPayloads !== "object") return out;
	for (const [id, json] of Object.entries(sourceOrPayloads)) {
		const normalize = NORMALIZERS[id];
		if (normalize) out.push(...normalize(json));
	}
	return out;
}

// ──────────────────────────────────────────────────────── 用户覆盖

/**
 * 解析 `settings.priceOverrides`：对象或 JSON 字符串，结构
 * `{ "<model>": { input, output, cacheRead, cacheWrite } }`（USD / 1M）。
 * 非法条目跳过并记 `errors`，绝不抛错（设置里写错不该让看板崩）。
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
		const prices = priceBag({
			input: spec.input,
			output: spec.output,
			cacheRead: spec.cacheRead,
			cacheWrite: spec.cacheWrite,
		});
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

// ──────────────────────────────────────────────────────── 索引与解析

/**
 * 建索引：`模型名（小写）→ 价格行[]`。同一模型可能有多个来源 / 供应商的行。
 *
 * 每行同时挂到**原名**与 `normalizeModelId(原名)` 两个键下（两者相同时只挂一次），
 * 因为 models.dev 的 modelId 常带 vendor 前缀（`google/gemini-3.8-flash`），
 * 只按原名索引会让账本里的 `gemini-3.8-flash` 一条官方行都命中不到（v3 召回修正）。
 *
 * @param {object[]} rows
 * @param {{version?: number}} [opts]
 * @returns {{byModel: Map<string, object[]>, size: number, version: number, entries: number}}
 */
export function buildPriceIndex(rows, opts = {}) {
	const byModel = new Map();
	const list = Array.isArray(rows) ? rows : [];
	let entries = 0;
	for (const row of list) {
		if (!row || !hasCorePrices(row)) continue;
		const raw = String(row.model ?? "")
			.trim()
			.toLowerCase();
		if (!raw) continue;
		entries++;
		const keys = [raw];
		const normalized = normalizeModelId(raw).toLowerCase();
		if (normalized && normalized !== raw) keys.push(normalized);
		for (const key of keys) {
			let bucket = byModel.get(key);
			if (!bucket) {
				bucket = [];
				byModel.set(key, bucket);
			}
			bucket.push(row);
		}
	}
	return { byModel, size: byModel.size, version: toNum(opts.version) ?? 0, entries };
}

/** 源优先级：用户覆盖 0 < models.dev 1 < LiteLLM 2 < OpenRouter 3。 */
function sourceRank(source) {
	if (source === "override") return 0;
	return SOURCE_BY_ID.get(source)?.priority ?? 9;
}

/** `table` 参数容错：索引对象 / 快照（`{entries, version}`）/ 价格行数组。 */
function indexOf(table, hintVersion) {
	if (table && table.byModel instanceof Map) return table;
	if (Array.isArray(table)) return buildPriceIndex(table, { version: hintVersion });
	if (table && Array.isArray(table.entries)) return buildPriceIndex(table.entries, { version: hintVersion ?? table.version });
	return buildPriceIndex([], { version: hintVersion });
}

/**
 * 枚举候选：按模型名候选列表逐层命中。**每一层的行都保留**（不因第一层命中就停），
 * 但带上 `matchLevel`（层号：0 = 原名精确），供选择规则区分「精确」与「变体」。
 * 顺序（确定性，可断言）：
 *  1. 用户覆盖行（只认原名，用户写的是账本里看到的那个名字）；
 *  2. 官方厂商行：源优先级 → 规则内供应商顺序 → id；
 *  3. 其余行：源优先级 → 供应商 → 模型名。
 *
 * @param {string} model 账本里的模型名
 * @param {{table?: object|object[]|null, index?: object|null, overrides?: object[]}} hints
 * @returns {object[]} 价格行副本（带 `official` 布尔与 `matchLevel` 数字）
 */
export function priceCandidates(model, hints = {}) {
	const index = hints.index ?? indexOf(hints.table ?? null);
	const overrides = Array.isArray(hints.overrides) ? hints.overrides : [];
	const names = modelCandidates(model);
	const rawName = String(model ?? "").trim().toLowerCase();
	const vendors = Array.isArray(hints.officialVendors) ? hints.officialVendors : officialVendorsOf(model);
	const out = [];
	const seen = new Set();
	const push = (row, official, matchLevel) => {
		if (!row || seen.has(row.id)) return;
		seen.add(row.id);
		out.push({ ...row, official, matchLevel });
	};
	for (const row of overrides) {
		if (String(row.model ?? "").toLowerCase() === rawName) push(row, false, 0);
	}
	names.forEach((name, level) => {
		const bucket = index.byModel.get(name);
		if (!bucket || !bucket.length) return;
		const officials = [];
		for (const row of bucket) {
			if (vendors.includes(String(row.provider ?? "").toLowerCase())) officials.push(row);
		}
		officials.sort(
			(a, b) =>
				sourceRank(a.source) - sourceRank(b.source) ||
				vendors.indexOf(String(a.provider).toLowerCase()) - vendors.indexOf(String(b.provider).toLowerCase()) ||
				a.id.localeCompare(b.id),
		);
		for (const row of officials) push(row, true, level);
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
 * 来源优先级（合同 §4.12 + 任务口径）：
 *  1. 用户覆盖 `priceOverrides[model]`（原名精确匹配）；
 *  2. 官方厂商行：先按**名字层**（原名 > 剥变体后缀 > 剥 vendor 前缀 > 规范化），
 *     再按源优先级，再按规则内供应商顺序；
 *  3. 没有官方行 → 多来源中位数（按 input 升序取中位那一行；偶数个取偏低的，
 *     宁可少估也不多估）；
 *  4. 一个候选都没有 → `null`（= 缺价，看板显示 `--`，绝不写 0）。
 *
 * @param {object|object[]} table 价格索引 / 快照 `{entries, version}` / 价格行数组
 * @param {string} model
 * @param {{overrides?: object[]|string|object, hints?: {officialVendors?: string[]}, version?: number}} [opts]
 * @returns {{priceId:string, version:number, promptPerM:number, outputPerM:number,
 *            cacheReadPerM:number|null, cacheWritePerM:number|null,
 *            source:string, note:string}|null}
 */
export function resolvePrice(table, model, opts = {}) {
	const index = indexOf(table, opts.version);
	const overrides = Array.isArray(opts.overrides)
		? opts.overrides
		: parsePriceOverrides(opts.overrides).rows;
	const hints = opts.hints && typeof opts.hints === "object" ? opts.hints : {};
	const candidates = priceCandidates(model, {
		index,
		overrides,
		officialVendors: Array.isArray(hints.officialVendors) ? hints.officialVendors : null,
	});
	if (!candidates.length) return null;
	const shape = (row, note) => ({
		priceId: row.id,
		version: index.version,
		promptPerM: row.input,
		outputPerM: row.output,
		cacheReadPerM: row.cacheRead,
		cacheWritePerM: row.cacheWrite,
		source: row.source,
		note,
	});
	const override = candidates.find((c) => c.source === "override");
	if (override) return shape(override, "override");
	const vendors = Array.isArray(hints.officialVendors) ? hints.officialVendors : officialVendorsOf(model);
	const officials = candidates
		.filter((c) => c.official === true)
		.sort(
			(a, b) =>
				(a.matchLevel ?? 0) - (b.matchLevel ?? 0) ||
				sourceRank(a.source) - sourceRank(b.source) ||
				vendors.indexOf(String(a.provider).toLowerCase()) - vendors.indexOf(String(b.provider).toLowerCase()) ||
				a.id.localeCompare(b.id),
		);
	if (officials.length) {
		const best = officials[0];
		return shape(best, (best.matchLevel ?? 0) === 0 ? "official-exact" : `official-variant:${best.matchLevel}`);
	}
	const sorted = [...candidates].sort((a, b) => a.input - b.input || a.output - b.output || a.id.localeCompare(b.id));
	const median = sorted[Math.floor((sorted.length - 1) / 2)];
	return shape(median, `median:${sorted.length}`);
}

// ──────────────────────────────────────────────────────── 计价

/**
 * 估算一条记录的成本（USD）。**纯函数**。
 *
 * 口径（合同 §三，逐字）：
 *  - `promptTokens = inTok + cacheRead + cacheWrite`（这里不返回它，`metrics` 负责汇总）；
 *  - `usd = (inTok*pIn + outTok*pOut + cacheRead*pCacheRead + cacheWrite*pCacheWrite) / 1e6`；
 *  - 缺 `cacheRead` / `cacheWrite` 价 → 按 `pIn` 计，`note` 标 `cacheRead≈input`（同理 `cacheWrite`）；
 *  - 四项 token 全为 `null`（未采集）→ `usd:null`（不是 $0）。
 *
 * `reasoning` 只作为**入参占位**：pi 的 `usage.reasoning` 是 output 的明细/子集，
 * 再按 output 价加一遍就是重复计费（v2 也是这么算的，实测与 v2 估算逐条相等）。
 *
 * @param {{price: object|null, inTok?: number|null, outTok?: number|null,
 *          cacheRead?: number|null, cacheWrite?: number|null, reasoning?: number|null}} input
 * @returns {{usd:number|null, note:string}}
 */
export function estimateCost(input = {}) {
	const price = input.price ?? null;
	if (!price || toNum(price.promptPerM) === null || toNum(price.outputPerM) === null) {
		return { usd: null, note: "unpriced" };
	}
	const inTok = toNum(input.inTok);
	const outTok = toNum(input.outTok);
	const cacheRead = toNum(input.cacheRead);
	const cacheWrite = toNum(input.cacheWrite);
	if (inTok === null && outTok === null && cacheRead === null && cacheWrite === null) {
		return { usd: null, note: "no-usage" };
	}
	const pIn = toNum(price.promptPerM) ?? 0;
	const pOut = toNum(price.outputPerM) ?? 0;
	const readPrice = toNum(price.cacheReadPerM);
	const writePrice = toNum(price.cacheWritePerM);
	const pRead = readPrice === null ? pIn : readPrice;
	const pWrite = writePrice === null ? pIn : writePrice;
	const usd =
		((inTok ?? 0) * pIn + (outTok ?? 0) * pOut + (cacheRead ?? 0) * pRead + (cacheWrite ?? 0) * pWrite) / 1e6;
	const notes = [];
	if (readPrice === null) notes.push("cacheRead≈input");
	if (writePrice === null) notes.push("cacheWrite≈input");
	return { usd: Math.round(usd * 1e9) / 1e9, note: notes.join(" ") };
}

/**
 * 给一条明细行算计价**补丁**（纯函数，不改入参）。
 *
 * 语义（任务口径 7 + 合同 §三）：
 *  - SDK 有值（`costSdk > 0`，或 `costSdk === 0` 且 `costSource === "sdk"` 表示 0 是采集到的真值）
 *    → `{costEst:null, costSource:"sdk"}`，**绝不**再写估算，避免同一笔账被数两次；
 *  - 没有价格行 → `{costSource:"unpriced"}`（有调用无价）；
 *  - 有价格但四项 token 全缺（未采集） → `{costSource:null}`（不可估，等回填）；
 *  - 其余 → 估算。
 *
 * @param {object} row 合同 §4.9 明细行（`model` / `inTok` / `outTok` / `cacheRead` /
 *   `cacheWrite` / `reasoningTok` / `costSdk` / `costSource`）
 * @param {object|null} price `resolvePrice()` 的结果
 * @returns {{costEst:number|null, costSource:"sdk"|"estimate"|"unpriced"|null,
 *            priceId:string|null, priceVersion:number|null}}
 */
export function applyPricing(row, price) {
	const sdk = toNum(row?.costSdk);
	const declaredSdk = String(row?.costSource ?? "") === "sdk";
	if (sdk !== null && (sdk > 0 || declaredSdk)) {
		return { costEst: null, costSource: "sdk", priceId: null, priceVersion: null };
	}
	if (!price) return { costEst: null, costSource: "unpriced", priceId: null, priceVersion: null };
	const { usd } = estimateCost({
		price,
		inTok: row?.inTok,
		outTok: row?.outTok,
		cacheRead: row?.cacheRead,
		cacheWrite: row?.cacheWrite,
		reasoning: row?.reasoningTok,
	});
	if (usd === null) return { costEst: null, costSource: null, priceId: null, priceVersion: null };
	return { costEst: usd, costSource: "estimate", priceId: price.priceId, priceVersion: price.version };
}

// ──────────────────────────────────────────────────────── 抓取

/**
 * 抓三个源并归一。**任何失败只写进 `sources[]`，绝不抛错**（接口不能 500）。
 * @param {(url:string, init?:object)=>Promise<any>} fetchImpl 宿主的 `host.fetch`（不直接用全局 fetch）
 * @param {{log?:Function, maxBytes?:number}} [options]
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
			// 宿主两种返回形态都要认：原生 Response（`.ok/.status/.text()`）与
			// 能力被拒的 `{ok:false, error}`（`net.fetch` 在未授权时这么返回）。
			if (!res) throw new Error("响应为空");
			if (res.ok === false) throw new Error(String(res.error ?? `HTTP ${res.status ?? "?"}`));
			const text = typeof res.text === "function" ? await res.text() : JSON.stringify(await res.json?.());
			const body = String(text ?? "");
			if (body.length > maxBytes) throw new Error(`响应过大（${body.length} 字节）`);
			const rows = parsePriceSources(source.id, JSON.parse(body));
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

// ──────────────────────────────────────────────────────── 快照与价格簿

/** 快照是否过期（没有快照也算过期）。 */
export function isSnapshotStale(snapshot, now = Date.now(), ttlMs = PRICE_TTL_MS) {
	const fetchedAt = toNum(snapshot?.fetchedAt);
	if (fetchedAt === null || fetchedAt === 0) return true;
	return Number(now) - fetchedAt >= ttlMs;
}

/** 空快照（没有缓存 / 刷新全失败 / 文件损坏时用）。 */
export function emptySnapshot() {
	return { schema: PRICE_SCHEMA, version: 0, fetchedAt: 0, sources: [], entries: [], lastError: null };
}

/**
 * 价格簿：快照 + 解析 + 刷新。**所有公共方法都不抛错**（拿不到价只会让成本留空）。
 *
 * @param {object} options
 * @param {string} [options.dir] 状态目录（写 `<dir>/prices.json`）
 * @param {(url:string, init?:object)=>Promise<any>} [options.fetchImpl] 宿主的 `host.fetch`
 * @param {() => Record<string, unknown>} [options.getSettingsSnapshot] **内存快照**，绝不读盘
 * @param {(level:string, ...args:unknown[])=>void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 */
export function createPriceBook(options = {}) {
	const dir = typeof options.dir === "string" ? options.dir : "";
	const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : null;
	const getSettingsSnapshot =
		typeof options.getSettingsSnapshot === "function" ? options.getSettingsSnapshot : () => ({});
	const log = typeof options.log === "function" ? options.log : () => {};
	const now = typeof options.now === "function" ? options.now : () => Date.now();
	const ttlMs = toNum(options.ttlMs) ?? PRICE_TTL_MS;
	const path = dir ? join(dir, PRICE_CACHE_FILE) : "";

	let snapshot = emptySnapshot();
	let index = buildPriceIndex([], { version: 0 });
	/** 进行中的刷新（并发调用共用同一个 Promise）。 */
	let refreshing = null;
	/** 解析结果记忆化：同一模型在同一份快照 + 同一份覆盖下只解析一次。 */
	let resolveCache = new Map();
	/** `priceOverrides` 原始值的记忆化：JSON.parse 不能每条记录都跑一遍。 */
	let overridesRaw;
	let overridesCache = { rows: [], errors: [] };

	/** 当前设置快照里的 `priceOverrides`（raw 值变了就重解析 + 清记忆化）。 */
	function overridesOf() {
		const settings = (() => {
			try {
				return getSettingsSnapshot() ?? {};
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
		index = buildPriceIndex(next.entries, { version: next.version });
		resolveCache = new Map();
	}

	/**
	 * 读快照（同步、不联网）。缺失 → 空表；损坏 → 空表 + `lastError`，绝不抛错。
	 * 实测真实快照 2,402,308 B / 13,040 条，`JSON.parse` 10ms（合同 §一.1 的 16ms 预算内）。
	 */
	function load() {
		if (!path) return snapshot;
		let text;
		try {
			if (!existsSync(path)) return snapshot;
			text = readFileSync(path, "utf8");
		} catch (err) {
			const message = String(err?.message ?? err).slice(0, 200);
			snapshot = { ...snapshot, lastError: `快照读取失败：${message}` };
			log("warn", "价格快照读取失败（按空价格表继续）：", message);
			return snapshot;
		}
		try {
			const parsed = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
				throw new Error("结构不合法（缺 entries）");
			}
			adopt({
				schema: PRICE_SCHEMA,
				version: toNum(parsed.version) ?? 0,
				fetchedAt: toNum(parsed.fetchedAt) ?? 0,
				sources: Array.isArray(parsed.sources) ? parsed.sources : [],
				entries: parsed.entries,
				lastError: parsed.lastError ?? null,
			});
		} catch (err) {
			const message = String(err?.message ?? err).slice(0, 200);
			adopt({ ...emptySnapshot(), lastError: `快照损坏：${message}` });
			log("warn", "价格快照损坏（按空价格表继续，等后台刷新）：", message);
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
			log("warn", "价格快照写入失败（本次运行仍可用）：", String(err?.message ?? err));
			return false;
		}
	}

	/**
	 * 快照状态（`/api/v3/meta`、`/api/v3/overview.prices`）。
	 * `ok` = 「有一份可用的价 + 最近一次刷新没失败」；`available` = 「有任何可计价行」，
	 * 两者分开是为了让 UI 能表达「沿用旧价（可能过期）」而不是直接报错。
	 */
	function status() {
		const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
		const entries = Array.isArray(snapshot.entries) ? snapshot.entries.length : 0;
		const error = snapshot.lastError ?? null;
		return {
			ok: entries > 0 && !error,
			available: entries > 0,
			version: snapshot.version ?? 0,
			fetchedAt: toNum(snapshot.fetchedAt) || null,
			stale: isSnapshotStale(snapshot, now(), ttlMs),
			ttlMs,
			entries,
			models: index.size,
			path: path || null,
			error,
			failed: sources.filter((s) => s.ok !== true).map((s) => s.label ?? s.id),
			overridesError: overridesOf().errors[0] ?? null,
			sources: sources.map((s) => ({
				id: s.id,
				label: s.label,
				ok: s.ok === true,
				count: toNum(s.count) ?? 0,
				ms: toNum(s.ms) ?? 0,
				error: s.error ?? null,
			})),
		};
	}

	/**
	 * 刷新（同一时刻只跑一个）。**失败保留旧快照**，只把错误写进 `lastError`，
	 * 成功才把 `version` +1 并落盘。
	 * @returns {Promise<object>} status()
	 */
	function refresh() {
		if (refreshing) return refreshing;
		refreshing = (async () => {
			/** 本次尝试的逐源结果：失败时也要写进 status（让 UI 能说清哪个源挂了）。 */
			let attempted = null;
			try {
				const { entries, sources } = await fetchPriceSources(fetchImpl, { log, maxBytes: PRICE_MAX_BYTES });
				attempted = sources;
				const okCount = sources.filter((s) => s.ok).length;
				if (!entries.length) {
					throw new Error(okCount ? "三源都没解析出可计价的行" : "三个价格源全部失败");
				}
				adopt({
					schema: PRICE_SCHEMA,
					version: (toNum(snapshot.version) ?? 0) + 1,
					fetchedAt: now(),
					sources,
					entries,
					lastError: null,
				});
				save();
				log(
					"info",
					`价格表已刷新（v${snapshot.version}）：${entries.length} 行（${sources
						.map((s) => `${s.label}:${s.ok ? s.count : "失败"}`)
						.join("，")}）`,
				);
				return status();
			} catch (err) {
				const message = String(err?.message ?? err).slice(0, 200);
				// 旧 entries / fetchedAt / version 原样保留（旧价继续可用），
				// 只把「本次尝试的源结果」与错误写进去。
				snapshot = { ...snapshot, sources: attempted ?? snapshot.sources, lastError: message };
				log("warn", "价格表刷新失败（保留旧快照）：", message);
				return status();
			} finally {
				refreshing = null;
			}
		})();
		return refreshing;
	}

	/**
	 * 按需后台刷新：**绝不阻塞调用方**（触发后立即返回，刷新在微任务里跑）。
	 * 快照缺失 / 过期 / 损坏 / `force` 时触发；没有 `fetchImpl` 或已在刷新中则不触发。
	 * @param {{force?: boolean}} [opts]
	 * @returns {{triggered:boolean, status:object}}
	 */
	function ensureFresh(opts = {}) {
		const need = opts.force === true || isSnapshotStale(snapshot, now(), ttlMs) || Boolean(snapshot.lastError);
		if (need && fetchImpl && !refreshing) {
			void refresh();
			return { triggered: true, status: status() };
		}
		return { triggered: false, status: status() };
	}

	/**
	 * 解析模型价（记忆化：同一模型在同一份快照 + 同一份覆盖下只解析一次）。
	 * @param {string} model
	 * @param {{officialVendors?: string[]}} [hints]
	 */
	function resolvePriceOf(model, hints) {
		// raw 值比较 O(1)：设置里改了 priceOverrides 会就地清掉记忆化
		overridesOf();
		const key = `${String(model ?? "")}\u0000${hints?.officialVendors?.join(",") ?? ""}`;
		const hit = resolveCache.get(key);
		if (hit !== undefined) return hit;
		const resolved = resolvePrice(index, String(model ?? ""), {
			overrides: overridesOf().rows,
			hints: hints ?? {},
		});
		resolveCache.set(key, resolved);
		return resolved;
	}

	/** 给一条明细行补价（乘法级开销；解析走记忆化）。 */
	function apply(row) {
		const price = row?.model ? resolvePriceOf(row.model) : null;
		return applyPricing(row, price);
	}

	return {
		path,
		/** 快照版本（每次成功刷新 +1）。 */
		get version() {
			return snapshot.version ?? 0;
		},
		load,
		status,
		refresh,
		ensureFresh,
		resolve: resolvePriceOf,
		resolvePrice: resolvePriceOf,
		apply,
		/** 设置变了（`priceOverrides`）→ 清记忆化。 */
		invalidate() {
			overridesRaw = undefined;
			overridesCache = { rows: [], errors: [] };
			resolveCache = new Map();
		},
		/** 只读快照 / 索引（诊断与测试用）。 */
		snapshot: () => snapshot,
		index: () => index,
	};
}

export default createPriceBook;
