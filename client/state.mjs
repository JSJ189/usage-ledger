/**
 * 用量账本 v3 · 查询状态与 URL 合同（纯函数 + localStorage 读写，无渲染）
 *
 * URL 合同（docs/V3-CONTRACT.md §六）：`#ul?range=30d&gran=1h&model=all&status=all&view=chart`
 *  - 只写非默认值（升级默认值后旧链接仍然有效）；
 *  - 值一律可读 `k=v`，禁止 base64；多值用逗号；
 *  - 只改 hash，用 `history.replaceState`，不新增历史条目。
 */

import { fromDateInput } from "./format.mjs";

export const RANGES = ["today", "24h", "7d", "30d", "90d", "all", "custom"];
export const GRANS = ["auto", "5m", "1h", "1d"];
export const VIEWS = ["chart", "table", "prices"];
/** 六态（顺序即 UI 顺序，与 docs §三 schema 一致）。 */
export const STATUSES = ["ok", "client_error", "rate_limited", "provider_error", "aborted", "incomplete"];
/** 表格列（顺序即渲染顺序）。 */
export const COLUMNS = [
	{ key: "time", sort: "ts" },
	{ key: "model", sort: "model" },
	{ key: "provider", sort: "provider" },
	{ key: "project", sort: "project" },
	{ key: "status", sort: "status" },
	{ key: "input", sort: "input", num: true },
	{ key: "output", sort: "output", num: true },
	{ key: "total", sort: "total", num: true },
	{ key: "cache", sort: "cacheRead", num: true },
	{ key: "cacheHit", sort: "cacheHitRate", num: true },
	{ key: "ttft", sort: "ttft", num: true },
	{ key: "gen", sort: "gen", num: true },
	{ key: "e2e", sort: "e2e", num: true },
	{ key: "cost", sort: "cost", num: true },
	{ key: "origin", sort: "origin" },
	{ key: "session", sort: "sessionId" },
];
export const COLUMN_KEYS = COLUMNS.map((c) => c.key);
export const SORT_KEYS = ["ts", "model", "provider", "project", "status", "input", "output", "total", "cacheRead", "cacheHitRate", "ttft", "gen", "e2e", "cost", "origin", "sessionId"];
const STATUS_SET = new Set(STATUSES);
const RANGE_SET = new Set(RANGES);
const GRAN_SET = new Set(GRANS);
const VIEW_SET = new Set(VIEWS);

export const HASH_PREFIX = "ul";
export const LS_PREFIX = "cps.";
export const DEFAULT_SORT = { key: "ts", dir: "desc" };

/** 默认查询（也是「只写非默认值」的比较基准）。 */
export function defaultQuery() {
	return {
		range: "today",
		from: "",
		to: "",
		gran: "auto",
		model: "all",
		provider: "all",
		project: "all",
		status: "all",
		view: "chart",
		sort: { ...DEFAULT_SORT },
	};
}

export function cloneQuery(q) {
	const base = defaultQuery();
	const src = q ?? {};
	return {
		range: src.range ?? base.range,
		from: src.from ?? base.from,
		to: src.to ?? base.to,
		gran: src.gran ?? base.gran,
		model: src.model ?? base.model,
		provider: src.provider ?? base.provider,
		project: src.project ?? base.project,
		status: src.status ?? base.status,
		view: src.view ?? base.view,
		sort: { key: src.sort?.key ?? DEFAULT_SORT.key, dir: src.sort?.dir === "asc" ? "asc" : "desc" },
	};
}

/** `all` / `a,b` → 数组（`all` → 空数组）。 */
export function filterList(value) {
	const v = String(value ?? "all").trim();
	if (!v || v === "all") return [];
	return v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** 数组 → `all` / `a,b`。 */
export function joinFilter(list) {
	const out = [...new Set((list ?? []).filter(Boolean))];
	return out.length ? out.join(",") : "all";
}

/** 在 `all`/列表之间切换某项。 */
export function toggleFilter(value, item, allValues) {
	const current = filterList(value);
	if (current.length === 0) {
		// 当前是「全部」→ 点任一项 = 只选它
		return item ? item : "all";
	}
	const next = current.includes(item) ? current.filter((x) => x !== item) : [...current, item];
	if (!next.length) return "all";
	// 全选 = 全部（避免 URL 里塞满六个值）
	if (allValues && next.length === allValues.length && allValues.every((v) => next.includes(v))) return "all";
	return joinFilter(next);
}

/** 自定义范围 → 自动粒度（合同只允许 5m/1h/1d）。 */
export function customGran(spanMs) {
	if (!Number.isFinite(spanMs) || spanMs <= 0) return "1h";
	if (spanMs <= 26 * 3_600_000) return "5m";
	if (spanMs <= 31 * 86_400_000) return "1h";
	return "1d";
}

/**
 * 组装服务端查询参数（§五「公共查询参数」）。
 * 自定义范围发 `from`/`to`（毫秒）；`gran=auto` 时交给服务端自动，自定义范围自己算，
 * 因为服务端的 range→bucket 阶梯只覆盖命名范围。
 */
export function apiParams(query) {
	const q = cloneQuery(query);
	const p = new URLSearchParams();
	if (q.range === "custom") {
		const from = fromDateInput(q.from, false);
		const to = fromDateInput(q.to, true);
		if (from !== null && to !== null && to >= from) {
			p.set("from", String(from));
			p.set("to", String(to));
			p.set("gran", q.gran === "auto" ? customGran(to - from) : q.gran);
		} else {
			p.set("range", "today");
		}
	} else {
		p.set("range", q.range);
		if (q.gran !== "auto") p.set("gran", q.gran);
	}
	for (const key of ["model", "provider", "project", "status"]) {
		const v = q[key];
		if (v && v !== "all") p.set(key, v);
	}
	return p;
}

/** 规范化查询签名：用于「记录缓存是否还能复用」「响应是否还是当前查询的」。 */
export function querySig(query) {
	const q = cloneQuery(query);
	return `${apiParams(q).toString()}|${q.view}`;
}

/**
 * 解析 hash。
 * @returns {{ok: boolean, query: object}} ok=false 表示这不是本插件的 hash（用默认值，不回写）
 */
export function parseHash(hash) {
	const query = defaultQuery();
	const raw = String(hash ?? "").replace(/^#/, "");
	const qIndex = raw.indexOf("?");
	const head = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
	if (head !== HASH_PREFIX) return { ok: false, query };
	if (qIndex < 0) return { ok: true, query };
	const params = new URLSearchParams(raw.slice(qIndex + 1));
	const range = params.get("range");
	if (range && RANGE_SET.has(range)) query.range = range;
	const gran = params.get("gran");
	if (gran && GRAN_SET.has(gran)) query.gran = gran;
	const from = params.get("from");
	const to = params.get("to");
	if (from && to) {
		query.range = "custom";
		query.from = from;
		query.to = to;
	}
	for (const key of ["model", "provider", "project", "status"]) {
		const v = params.get(key);
		if (v === null) continue;
		if (key === "status") {
			const list = filterList(v).filter((s) => STATUS_SET.has(s));
			query.status = list.length ? joinFilter(list) : "all";
		} else {
			query[key] = v && v !== "all" ? v : "all";
		}
	}
	const view = params.get("view");
	if (view && VIEW_SET.has(view)) query.view = view;
	const sort = params.get("sort");
	if (sort) {
		const [key, dir] = sort.split(".");
		if (SORT_KEYS.includes(key)) query.sort = { key, dir: dir === "asc" ? "asc" : "desc" };
	}
	return { ok: true, query };
}

/**
 * 组装 hash（只写非默认值）。
 * @returns {string} `#ul?...`；全部为默认值时返回 `#ul`
 */
export function buildHash(query) {
	const q = cloneQuery(query);
	const base = defaultQuery();
	const params = new URLSearchParams();
	if (q.range !== base.range) params.set("range", q.range);
	if (q.gran !== base.gran) params.set("gran", q.gran);
	if (q.range === "custom") {
		if (q.from) params.set("from", q.from);
		if (q.to) params.set("to", q.to);
	}
	for (const key of ["model", "provider", "project", "status"]) {
		if (q[key] && q[key] !== "all") params.set(key, q[key]);
	}
	if (q.view !== base.view) params.set("view", q.view);
	const sortKey = q.sort.key;
	const isDefaultSort = sortKey === base.sort.key && q.sort.dir === base.sort.dir;
	if (!isDefaultSort) params.set("sort", `${sortKey}.${q.sort.dir}`);
	const qs = params.toString();
	return qs ? `#${HASH_PREFIX}?${qs}` : `#${HASH_PREFIX}`;
}

/** 生效的筛选条件数量（不含范围/粒度/视图）。 */
export function activeFilterCount(query) {
	let n = 0;
	for (const key of ["model", "provider", "project", "status"]) {
		if (query[key] && query[key] !== "all") n += 1;
	}
	return n;
}

/** 读 localStorage（隐私模式/损坏 → 回落，绝不影响功能）。 */
export function readStore(key, fallback) {
	try {
		const raw = window.localStorage.getItem(LS_PREFIX + key);
		if (raw === null) return fallback;
		const value = JSON.parse(raw);
		if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback;
		return value ?? fallback;
	} catch {
		return fallback;
	}
}

/** 写 localStorage（失败静默）。 */
export function writeStore(key, value) {
	try {
		window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
	} catch {
		/* 隐私模式：不记忆，不影响功能 */
	}
}

/**
 * 初始状态。
 * @param {object} [opts]
 */
export function createState(opts = {}) {
	return {
		lang: opts.lang ?? "zh",
		/** idle | loading | ready | stale | error */
		phase: opts.phase ?? "loading",
		query: cloneQuery(opts.query),
		data: null,
		records: {
			items: [],
			total: 0,
			nextCursor: null,
			cursor: null,
			stack: [],
			loading: false,
			error: null,
			sig: "",
			limit: 50,
			expandedId: null,
		},
		importStatus: null,
		table: {
			hidden: opts.hidden ?? [],
			showCols: false,
		},
		ui: {
			reqId: 0,
			recordsReqId: 0,
			lastError: null,
			staleReason: null,
			notice: "",
			noticeAt: 0,
			statusOpen: false,
			filtersOpen: false,
			kpiSig: "",
			lastLoadAt: 0,
		},
	};
}
