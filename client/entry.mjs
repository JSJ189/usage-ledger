/**
 * usage-ledger v3 · 客户端看板（入口）
 *
 * 目标（docs/V3-CONTRACT.md §六 + 方案 §2.6）：
 *  1. 首屏只发 2 个请求：`/api/v3/overview` 与 `/api/v3/import/status`；
 *     明细分页只在切到表格视图或滚到底部时才发；
 *  2. 骨架只建一次，之后按 `data-k` 打补丁（无整页 innerHTML，刷新不丢滚动/焦点）；
 *  3. 四态齐备：loading（骨架）/ ready / stale（保留旧数据 + banner）/ error（按 code 分文案）；
 *  4. 每次请求带 `AbortSignal.timeout(8000)` + 请求代数守卫；切范围立刻高亮 + 骨架，不清旧数据；
 *  5. 顶栏真值行：`起 → 止 · N 次 · 粒度 · 数据截至 HH:MM:SS`；
 *  6. URL 只写非默认值（`#ul?range=30d&gran=1h&view=chart`），用 `replaceState` 不增历史；
 *  7. 图表手写 SVG（crosshair + 单一 tooltip + 图例隐藏系列 + KPI sparkline）；
 *  8. 明细表光标分页 + 当前页排序 + 列显隐持久化（`cps.` 前缀）+ 本地时区时间；
 *  9. 导入面板进度条 + pause/resume/cancel，运行中 2s 轮询、空闲 30s；
 * 10. 导出直接调服务端流式接口；中/英字典单源；分段控件 tablist + aria-sort 等 a11y。
 */

import { dict, detectLang } from "./dict.mjs";
import * as F from "./format.mjs";
import { h, patch, pool, clear, setText } from "./dom.mjs";
import { ensureStyles, buildSkeleton, KPI_CARDS } from "./layout.mjs";
import { createChart, createSparkline } from "./charts.mjs";
import {
	RANGES,
	GRANS,
	VIEWS,
	HASH_PREFIX,
	STATUSES,
	COLUMNS,
	COLUMN_KEYS,
	apiParams,
	activeFilterCount,
	buildHash,
	cloneQuery,
	createState,
	filterList,
	parseHash,
	querySig,
	readStore,
	toggleFilter,
	writeStore,
} from "./state.mjs";

const PLUGIN_ID = "usage-ledger";
const ACTION_OPEN = "usage-ledger:open";
const VIEW_NAME = "plugin:usage-ledger";
/** 单次请求超时（合同 §六）。 */
const TIMEOUT_MS = 8000;
const POLL_VISIBLE_MS = 60_000;
const POLL_HIDDEN_MS = 30_000;
const POLL_IMPORT_RUNNING_MS = 2_000;
const POLL_IMPORT_IDLE_MS = 30_000;
const NOTICE_MS = 6000;
const TABLE_SIZES = [50, 100, 200];
const LS_HIDDEN_COLS = "table.hiddenCols";

const IMPORT_RUNNING = new Set(["scanning", "importing", "paused"]);

const CHART_CALLS_SERIES = [
	{ key: "ok", labelKey: "legendOk", tone: "accent" },
	{ key: "error", labelKey: "legendError", tone: "red" },
	{ key: "incomplete", labelKey: "legendIncomplete", tone: "amber" },
	{ key: "other", labelKey: "legendOther", tone: "faint" },
];
const CHART_LATENCY_SERIES = [
	{ key: "ttftP50", labelKey: "legendTtftP50", tone: "accent" },
	{ key: "ttftP90", labelKey: "legendTtftP90", tone: "amber", dash: true },
	{ key: "e2eP50", labelKey: "legendE2eP50", tone: "green" },
];

const apiBase = () => `/plugins-api/${PLUGIN_ID}`;

// ──────────────────────────────────────────────────────────── 运行时

const runtime = {
	root: null,
	refs: null,
	state: null,
	d: dict("zh"),
	mounted: false,
	charts: { calls: null, latency: null },
	sparks: new Map(),
	overviewCtl: null,
	recordsCtl: null,
	pollTimer: null,
	importTimer: null,
	noticeTimer: null,
	sentinelObserver: null,
	langObserver: null,
	offLocale: null,
	offViewChange: null,
	cleanups: [],
	chartSig: "",
	hashGuard: false,
};

// ──────────────────────────────────────────────────────────── 请求层

/** 组合「超时信号」与「主动取消信号」；有 `AbortSignal.any` 就全用，否则退化为定时器取消。 */
function deriveSignal(controller) {
	if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function") {
		return AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
	}
	if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
		return AbortSignal.timeout(TIMEOUT_MS);
	}
	setTimeout(() => {
		if (!controller.signal.aborted) {
			try {
				controller.abort(new Error("timeout"));
			} catch {
				controller.abort();
			}
		}
	}, TIMEOUT_MS);
	return controller.signal;
}

function isTimeoutError(err) {
	const name = String(err?.name ?? "");
	if (name === "TimeoutError") return true;
	return /timed? ?out|timeout/i.test(String(err?.message ?? ""));
}

async function requestJson(path, params, controller) {
	const qs = params && params.toString();
	const url = `${apiBase()}${path}${qs ? `?${qs}` : ""}`;
	const res = await fetch(url, {
		signal: deriveSignal(controller),
		headers: { Accept: "application/json" },
		cache: "no-store",
	});
	if (!res || res.ok === false) {
		// 合同要求永远 200 + ok 布尔，但代理/网关层仍可能给 4xx：尽量把结构化 code 带出来
		let payload = null;
		try {
			payload = await res.json();
		} catch {
			payload = null;
		}
		throw Object.assign(new Error(`HTTP ${res?.status ?? "?"}`), { code: payload?.code ?? "request-failed", payload });
	}
	return res.json();
}

function classifyError(err) {
	const code = err?.code ?? err?.payload?.code;
	if (typeof code === "string" && code) return code;
	return "request-failed";
}

// ──────────────────────────────────────────────────────────── 数据加载

function isImportRunning() {
	const phase = runtime.state?.importStatus?.phase;
	if (phase && IMPORT_RUNNING.has(phase)) return true;
	return Boolean(runtime.state?.data?.freshness?.importing);
}

function applyOverview(data) {
	const st = runtime.state;
	st.data = {
		version: Number(data.version) || 0,
		range: data.range ?? null,
		freshness: data.freshness ?? null,
		kpi: data.kpi ?? null,
		series: Array.isArray(data.series) ? data.series : [],
		topModels: Array.isArray(data.topModels) ? data.topModels : [],
		topProjects: Array.isArray(data.topProjects) ? data.topProjects : [],
		filters: data.filters ?? {},
		prices: data.prices ?? null,
	};
}

function noteFailure(payload) {
	const st = runtime.state;
	const code = payload?.code ?? "unknown";
	st.ui.lastError = {
		code,
		reason: String(payload?.reason ?? payload?.message ?? ""),
		hint: String(payload?.hint ?? ""),
		at: Date.now(),
	};
	// 有旧数据就保留（stale-while-error），没有才落到 error 整页态
	st.phase = st.data ? "stale" : "error";
}

/** 拉 overview（首屏 1 个请求，切范围/筛选/刷新各 1 个）。 */
async function loadOverview() {
	if (!runtime.mounted) return;
	const st = runtime.state;
	const reqId = (st.ui.reqId += 1);
	const query = cloneQuery(st.query);
	const controller = new AbortController();
	try {
		runtime.overviewCtl?.abort();
	} catch {
		/* 旧请求已结束 */
	}
	runtime.overviewCtl = controller;
	if (st.phase !== "loading") st.phase = "loading";
	render();
	let data = null;
	let failure = null;
	let aborted = false;
	try {
		data = await requestJson("/api/v3/overview", apiParams(query), controller);
		if (!data || data.ok !== true) failure = data ?? { ok: false, code: "unknown" };
	} catch (err) {
		if (controller.signal.aborted && !isTimeoutError(err)) aborted = true;
		else failure = { ok: false, code: classifyError(err), reason: String(err?.message ?? err) };
	}
	// 代数守卫：旧响应不得覆盖新状态（也不得复位 loading）
	if (aborted || reqId !== st.ui.reqId || !runtime.mounted) return;
	if (failure) {
		noteFailure(failure);
	} else {
		applyOverview(data);
		st.phase = "ready";
		st.ui.lastError = null;
	}
	st.ui.lastLoadAt = Date.now();
	render();
}

/** 拉一条明细页（首屏不发；切表格视图 / 滚到底部 / 翻页时才发）。 */
async function loadRecords(options = {}) {
	const st = runtime.state;
	if (!runtime.mounted) return;
	const reset = Boolean(options.reset);
	const cursor = options.cursor ?? null;
	const sig = querySig(st.query);
	const reqId = (st.ui.recordsReqId += 1);
	const controller = new AbortController();
	try {
		runtime.recordsCtl?.abort();
	} catch {
		/* 旧请求已结束 */
	}
	runtime.recordsCtl = controller;
	st.records.loading = true;
	render();
	const params = apiParams(st.query);
	params.set("limit", String(st.records.limit));
	if (cursor) params.set("cursor", cursor);
	let failure = null;
	let data = null;
	try {
		data = await requestJson("/api/v3/records", params, controller);
		if (!data || data.ok !== true) failure = data ?? { ok: false, code: "unknown" };
	} catch (err) {
		if (controller.signal.aborted && !isTimeoutError(err)) {
			// 被新请求接管：loading 归新请求管；被卸载打断时也不能把 loading 留在 true
			if (reqId === st.ui.recordsReqId) {
				st.records.loading = false;
				render();
			}
			return;
		}
		failure = { ok: false, code: classifyError(err), reason: String(err?.message ?? err) };
	}
	if (reqId !== st.ui.recordsReqId || !runtime.mounted) return;
	if (failure) {
		st.records.error = failure.code ?? "unknown";
	} else {
		const items = Array.isArray(data.records) ? data.records : [];
		st.records.items = reset ? items : [...st.records.items, ...items];
		st.records.total = Number(data.total) || st.records.total;
		st.records.nextCursor = data.nextCursor ?? null;
		st.records.cursor = cursor;
		st.records.sig = sig;
		st.records.error = null;
	}
	st.records.loading = false;
	render();
}

function ensureRecords() {
	const st = runtime.state;
	const sig = querySig(st.query);
	if (st.records.sig === sig && st.records.items.length) return;
	void loadRecords({ reset: true, cursor: null });
}

/** 导入状态（首屏 1 个请求，之后按运行/空闲节流轮询）。 */
async function loadImportStatus() {
	if (!runtime.mounted) return;
	const controller = new AbortController();
	try {
		const data = await requestJson("/api/v3/import/status", null, controller);
		if (!runtime.mounted || !data || data.ok !== true) return;
		const prev = runtime.state.importStatus;
		const next = data.status ?? null;
		runtime.state.importStatus = next;
		render();
		if (prev && next && prev.phase !== next.phase && (next.phase === "done" || next.phase === "error")) {
			void loadOverview();
		}
	} catch {
		/* 状态端点失败不影响主看板：保留旧值 */
	}
}

async function postAction(path, opts = {}) {
	const controller = new AbortController();
	try {
		await fetch(`${apiBase()}${path}`, {
			method: "POST",
			signal: deriveSignal(controller),
			headers: { Accept: "application/json" },
		});
	} catch {
		/* 端点按合同「立即返回、后台推进」，失败也由下一次状态轮询体现 */
	}
	await loadImportStatus();
	if (opts.reload) void loadOverview();
}

async function refreshPrices() {
	setNotice(runtime.d?.foot?.pricesRefreshing ?? "");
	await postAction("/api/v3/prices/refresh", { reload: true });
	// 回填在 worker 里跑，接口先返回。过几秒再拉一次，金额才会出现在卡片上。
	setTimeout(() => {
		if (runtime.mounted) void loadOverview();
	}, 8000);
}

// ──────────────────────────────────────────────────────────── URL 状态

function syncHash() {
	const st = runtime.state;
	if (!st) return;
	const next = buildHash(st.query);
	if (location.hash === next) return;
	// 宿主若自己用 hash 做路由（形如 `#/c/xxx`），不去覆盖它：状态留在内存里
	if (location.hash && !location.hash.startsWith(`#${HASH_PREFIX}`)) return;
	runtime.hashGuard = true;
	try {
		history.replaceState(history.state ?? null, "", `${location.pathname}${location.search}${next}`);
	} catch {
		/* file:// 或禁用 history：状态仍在内存里，不影响功能 */
	}
	runtime.hashGuard = false;
}

function applyHash() {
	if (!runtime.mounted || runtime.hashGuard) return;
	const parsed = parseHash(location.hash);
	if (!parsed.ok) return;
	const st = runtime.state;
	const next = cloneQuery(parsed.query);
	if (JSON.stringify(next) === JSON.stringify(st.query)) return;
	st.query = next;
	resetRecords();
	seedCustomInputs();
	st.ui.lastError = null;
	render();
	void loadOverview();
	if (next.view === "table") ensureRecords();
}

function resetRecords() {
	const st = runtime.state;
	st.records.items = [];
	st.records.total = 0;
	st.records.nextCursor = null;
	st.records.cursor = null;
	st.records.stack = [];
	st.records.sig = "";
	st.records.expandedId = null;
	st.records.error = null;
}

/** 查询变化：立刻高亮 + 骨架，**不清空已渲染的图表/KPI**（stale-while-loading）。 */
function onQueryChanged(options = {}) {
	const st = runtime.state;
	st.phase = "loading";
	st.ui.lastError = null;
	resetRecords();
	syncHash();
	render();
	void loadOverview();
	if (st.query.view === "table" || options.records) ensureRecords();
}

// ──────────────────────────────────────────────────────────── 渲染 · 文案

function renderTexts(d) {
	const st = runtime.state;
	const values = {
		"head.title": d.title,
		"head.sub": d.subtitle,
		"range.custom.from.label": d.customFrom,
		"range.custom.to.label": d.customTo,
		"range.apply": d.customApply,
		"filter.model.label": d.filterModel,
		"filter.provider.label": d.filterProvider,
		"filter.project.label": d.filterProject,
		"filter.status.label": d.filterStatus,
		"filter.clear": d.clearFilters,
		"head.refresh": st.phase === "loading" ? d.refreshing : d.refresh,
		"head.export": { text: d.export, title: d.exportHint },
		"chart.calls.title": d.charts.callsTitle,
		"chart.calls.sub": d.charts.callsSub,
		"chart.latency.title": d.charts.latencyTitle,
		"chart.latency.sub": d.charts.latencySub,
		"chart.calls.note": d.charts.hint,
		"chart.latency.note": d.charts.hint,
		"top.models.title": d.top.models,
		"top.projects.title": d.top.projects,
		"tokens.title": d.top.tokensTitle,
		"tokens.hint": d.top.tokensHint,
		"tokens.th.model": d.top.model,
		"tokens.th.calls": d.top.calls,
		"tokens.th.input": d.top.input,
		"tokens.th.output": d.top.output,
		"tokens.th.cacheRead": d.top.cacheRead,
		"tokens.th.cacheWrite": d.top.cacheWrite,
		"tokens.th.total": d.top.total,
		"tokens.th.cost": d.top.cost,
		"prices.title": d.prices.title,
		"prices.refresh": d.foot.pricesRefresh,
		"table.title": d.table.title,
		"import.title": d.import.title,
		"import.start": d.import.start,
		"import.pause": d.import.pause,
		"import.resume": d.import.resume,
		"import.cancel": d.import.cancel,
		"banner.stale.title": d.banner.staleTitle,
		"banner.stale.retry": d.retry,
		"banner.error.retry": d.retry,
		"banner.error.grant": d.grant,
		"banner.importing.title": d.banner.importingTitle,
		"banner.importing.desc": d.banner.importingDesc,
		"table.colsBtn": { text: d.columns, title: d.columns },
	};
	for (const status of STATUSES) values[`filter.status.text.${status}`] = d.statuses[status] ?? status;
	for (const col of COLUMNS) values[`table.colText.${col.key}`] = d.table.cols[col.key] ?? col.key;
	patch(runtime.root, values);
}

/** 分段控件（role=tablist）：高亮 + aria-selected + 只有一个 tabindex=0。 */
function renderSegment(act, values, current, labels) {
	const patchValues = {};
	for (const value of values) {
		const on = value === current;
		patchValues[`${act}.tab.${value}`] = {
			text: labels?.[value] ?? value,
			cls: { on },
			attrs: { "aria-selected": on ? "true" : "false", tabindex: on ? "0" : "-1" },
		};
	}
	patch(runtime.root, patchValues);
}

function renderQueryState(d) {
	const st = runtime.state;
	const q = st.query;
	renderSegment("range", RANGES, q.range, d.ranges);
	renderSegment("gran", GRANS, q.gran, d.grans);
	renderSegment("view", VIEWS, q.view, { chart: d.viewChart, table: d.viewTable, prices: d.viewPrices });
	patch(runtime.root, { "range.custom": { hidden: q.range !== "custom" } });
	// 日期输入框是「草稿」：只在进入自定义/恢复 URL 时播种，渲染不再回写，
	// 否则用户一边输入就被 patch 覆盖（排序/刷新任一帧都会触发）。
	// 明细视图开关
	const chartView = runtime.root.querySelector('[data-k="view.chart"]');
	const tableView = runtime.root.querySelector('[data-k="view.table"]');
	const pricesView = runtime.root.querySelector('[data-k="view.prices"]');
	if (chartView) chartView.classList.toggle("cps-hidden", q.view !== "chart");
	if (tableView) tableView.classList.toggle("cps-hidden", q.view !== "table");
	if (pricesView) pricesView.classList.toggle("cps-hidden", q.view !== "prices");
	const tokenPanel = runtime.root.querySelector('[data-k="tokens.panel"]');
	if (tokenPanel) tokenPanel.classList.toggle("cps-hidden", q.view !== "chart");
	renderFilters(d);
}

function renderFilters(d) {
	const st = runtime.state;
	const q = st.query;
	const f = st.data?.filters ?? {};
	const specs = [
		["model", f.models, d.allValues],
		["provider", f.providers, d.allValues],
		["project", f.projects, d.allValues],
	];
	for (const [key, list, allLabel] of specs) {
		const select = runtime.root.querySelector(`[data-k="filter.${key}"]`);
		if (!select) continue;
		const values = Array.isArray(list) ? list : [];
		const current = q[key] && q[key] !== "all" ? q[key] : "all";
		const items = [{ value: "all", label: allLabel }, ...values.map((v) => ({ value: v, label: v }))];
		if (current !== "all" && !values.includes(current)) items.push({ value: current, label: current });
		pool(select, items, {
			key: (item) => item.value,
			create: () => h("option"),
			update: (nodes, item) => {
				const option = nodes[0];
				if (option.value !== item.value) option.value = item.value;
				setText(option, item.label);
			},
		});
		if (select.value !== current) select.value = current;
	}
	// 状态多选（`all` 或逗号列表）
	const statusList = filterList(q.status);
	patch(runtime.root, {
		"filter.status.btn": {
			text: statusList.length ? d.statusPicked(statusList.length, STATUSES.length) : d.allValues,
			attrs: { "aria-expanded": st.table.statusOpen ? "true" : "false" },
		},
		"filter.status.panel": { hidden: !st.table.statusOpen },
	});
	for (const status of STATUSES) {
		patch(runtime.root, { [`filter.status.opt.${status}`]: { checked: statusList.length === 0 || statusList.includes(status) } });
	}
	const active = activeFilterCount(q);
	patch(runtime.root, {
		"filter.summary": { text: active ? d.filtersActive(active) : "" },
		"filter.clear": { hidden: active === 0 },
	});
}

function renderTruth(d) {
	const st = runtime.state;
	const data = st.data;
	if (!data) {
		patch(runtime.root, { "head.truth": "" });
		return;
	}
	const range = data.range ?? {};
	const kpi = data.kpi ?? {};
	const fresh = data.freshness ?? {};
	const from = F.fmtDateLocal(range.fromMs);
	const to = F.fmtDateLocal(range.toMs);
	const gran = range.gran ?? "1h";
	const granText = `${d.granValue ? d.granValue(gran) : gran}${range.granAuto ? d.granAutoSuffix : ""}`;
	const asOf = F.fmtTimeLocal(fresh.lastIngestAt ?? range.toMs);
	const text = `${from} → ${to} · ${F.fmtCount(kpi.calls)} ${d.truthCalls} · ${d.truthGran} ${granText} · ${d.truthAsOf} ${asOf} (${d.truthTz})`;
	patch(runtime.root, { "head.truth": text });
}

function renderBanners(d) {
	const st = runtime.state;
	const err = st.ui.lastError;
	const showError = Boolean(err);
	const code = err?.code ?? "unknown";
	const copy = d.errors[code] ?? d.errors.unknown;
	patch(runtime.root, {
		"banner.error": { hidden: !showError },
		"banner.error.title": showError ? copy.title : "",
		"banner.error.desc": showError
			? `${copy.desc}${err?.reason ? ` · ${err.reason}` : ""}`
			: "",
		"banner.error.hint": showError ? String(err?.hint || copy.hint) : "",
		"banner.error.grant": { hidden: code !== "no-fs-read" },
	});
	const stale = st.phase === "stale" && !showError;
	patch(runtime.root, {
		"banner.stale": { hidden: !stale },
		"banner.stale.text": stale ? d.banner.staleAsOf(F.fmtTimeLocal(st.data?.freshness?.lastIngestAt)) : "",
	});
	const importing = isImportRunning();
	patch(runtime.root, { "banner.importing": { hidden: !importing } });
	const notice = st.ui.notice;
	patch(runtime.root, { "banner.notice": { hidden: !notice }, "banner.notice.text": notice ?? "" });
}

// ──────────────────────────────────────────────────────────── 渲染 · KPI

function renderKpis(d) {
	const st = runtime.state;
	const kpi = st.data?.kpi ?? null;
	const series = st.data?.series ?? [];
	const values = {};
	for (const card of KPI_CARDS) {
		values[`kpi.${card.id}.label`] = d.kpi[card.id];
		if (card.spark) values[`kpi.${card.id}.spark`] = { title: d.kpi.spark };
	}
	if (!kpi) {
		for (const card of KPI_CARDS) {
			values[`kpi.${card.id}.value`] = F.fmtInt(null);
			values[`kpi.${card.id}.note`] = "";
		}
		patch(runtime.root, values);
		for (const [, spark] of runtime.sparks) spark.update([]);
		return;
	}
	const calls = F.numOrNull(kpi.calls) ?? 0;
	const ok = F.numOrNull(kpi.ok) ?? 0;
	const error = F.numOrNull(kpi.error) ?? 0;
	const incomplete = F.numOrNull(kpi.incomplete) ?? 0;
	const aborted = F.numOrNull(kpi.aborted) ?? 0;
	const denom = Math.max(0, calls - incomplete - aborted);
	const ttft = kpi.ttft ?? {};
	const e2e = kpi.e2e ?? {};
	const cost = kpi.cost ?? {};
	const tokens = kpi.tokens ?? {};
	const costAmount = F.numOrNull(cost.amount);
	const estimateShare = F.numOrNull(cost.estimateShare);
	const unpriced = F.numOrNull(cost.unpricedCalls) ?? 0;
	values["kpi.calls.value"] = F.fmtCount(calls);
	values["kpi.calls.note"] = d.kpi.callsNote(F.fmtCount(ok), F.fmtCount(error));
	values["kpi.calls.title"] = `${d.kpi.calls}：${F.fmtCount(calls)}（成功 ${F.fmtCount(ok)} · 失败 ${F.fmtCount(error)} · 未收全 ${F.fmtCount(incomplete)} · 取消 ${F.fmtCount(aborted)}）`;
	values["kpi.successRate.value"] = F.fmtRate(kpi.successRate);
	values["kpi.successRate.note"] = d.kpi.successNote(F.fmtCount(ok), F.fmtCount(denom));
	values["kpi.successRate.title"] = d.kpi.successNote(F.fmtCount(ok), F.fmtCount(denom));
	values["kpi.ttft.value"] = `${F.fmtMs(ttft.p50)} / ${F.fmtMs(ttft.p90)}`;
	values["kpi.ttft.note"] = d.kpi.ttftNote(F.fmtCount(ttft.samples ?? 0), F.fmtRate(ttft.coverage));
	values["kpi.ttft.title"] = `${d.kpi.ttftApprox}${ttft.approx === false ? "（exact）" : ""}`;
	values["kpi.latency.value"] = `${F.fmtMs(e2e.p50)} / ${F.fmtMs(e2e.p90)}`;
	values["kpi.latency.note"] = d.kpi.latencyNote(F.fmtCount(e2e.samples ?? 0));
	values["kpi.latency.title"] = d.kpi.latencyNote(F.fmtCount(e2e.samples ?? 0));
	values["kpi.tokps.value"] = F.fmtTokps(kpi.tokPerSec);
	values["kpi.tokps.note"] = d.kpi.tokpsNote(F.fmtTokps(kpi.tokPerSecMean), F.fmtCount(kpi.tokPerSecSamples ?? 0));
	values["kpi.tokps.title"] = d.kpi.tokpsNote(F.fmtTokps(kpi.tokPerSecMean), F.fmtCount(kpi.tokPerSecSamples ?? 0));
	values["kpi.cost.value"] = F.fmtCost(costAmount, { lowerBound: Boolean(cost.isLowerBound) && unpriced > 0 });
	values["kpi.cost.note"] = costAmount === null
		? d.kpi.costNone
		: d.kpi.costNote(estimateShare === null ? "--" : F.fmtShare(estimateShare), unpriced);
	values["kpi.cost.title"] = `${d.kpi.cost}：SDK ${F.fmtCost(cost.sdkAmount)} + 估算 ${F.fmtCost(cost.estimatedAmount, { estimate: true })} · token ${F.fmtInt(tokens.total)}`;
	patch(runtime.root, values);

	const tail = series.slice(-24);
	runtime.sparks.get("calls")?.update(tail.map((p) => p.calls), "var(--accent, #8b5cf6)");
	runtime.sparks.get("ttftP50")?.update(tail.map((p) => p.ttftP50), "var(--amber, #f59e0b)");
	runtime.sparks.get("e2eP50")?.update(tail.map((p) => p.e2eP50), "var(--green, #34d399)");
	runtime.sparks.get("success")?.update(
		tail.map((p) => {
			const calls = F.numOrNull(p.calls) ?? 0;
			return calls > 0 ? (F.numOrNull(p.ok) ?? 0) / calls : null;
		}),
		"var(--green, #34d399)",
	);

	const sig = [calls, kpi.successRate, ttft.p50, e2e.p50, kpi.tokPerSec, costAmount].join("|");
	if (sig !== st.ui.kpiSig) {
		st.ui.kpiSig = sig;
		patch(runtime.root, {
			"live.kpi": `${d.a11y.kpiLive}: ${d.kpi.calls} ${F.fmtCount(calls)}, ${d.kpi.successRate} ${F.fmtRate(kpi.successRate)}, TTFT p50 ${F.fmtMs(ttft.p50)}, ${d.kpi.cost} ${F.fmtCost(costAmount)}`,
		});
	}
}

// ──────────────────────────────────────────────────────────── 渲染 · 图表与排行

function renderCharts(d) {
	const st = runtime.state;
	const data = st.data;
	const sig = `${data?.version ?? -1}|${querySig(st.query)}|${st.lang}|${data?.series?.length ?? 0}`;
	if (sig === runtime.chartSig) return;
	runtime.chartSig = sig;
	const gran = data?.range?.gran ?? "1h";
	const loading = st.phase === "loading";
	const points = data?.series ?? [];
	const callsInfo = runtime.charts.calls?.update({ points, gran, d, loading });
	runtime.charts.latency?.update({ points, gran, d, loading });
	// 降采样必须在面板上写出来（不能悄悄改口径）
	const factor = Math.max(callsInfo?.factor ?? 1, 1);
	patch(runtime.root, {
		"chart.calls.note": factor > 1 ? `${d.charts.downsample(factor)} · ${d.charts.hint}` : d.charts.hint,
		"chart.latency.note": factor > 1 ? `${d.charts.downsample(factor)} · ${d.charts.hint}` : d.charts.hint,
	});
}

function renderRank(container, items, d, emptyText) {
	if (!container) return;
	if (!Array.isArray(items) || !items.length) {
		clear(container);
		container.appendChild(h("div", { class: "cps-rank-empty", text: emptyText }));
		return;
	}
	pool(container, items, {
		key: (item) => String(item?.name ?? ""),
		create: () => {
			const name = h("span", { class: "cps-rank-name" });
			const meta = h("span", { class: "cps-rank-meta" });
			const track = h("span", { class: "cps-rank-track" }, [h("i")]);
			return [h("div", { class: "cps-rank-row" }, [name, meta, track])];
		},
		update: (nodes, item) => {
			const row = nodes[0];
			const name = row.children[0];
			const meta = row.children[1];
			const fill = row.children[2].firstChild;
			setText(name, item?.name ?? "");
			name.setAttribute("title", String(item?.name ?? ""));
			const share = F.numOrNull(item?.share) ?? 0;
			setText(
				meta,
				`${F.fmtCount(item?.calls ?? 0)} ${d.top.calls} · ${F.fmtShare(share)} · ${F.fmtCost(item?.cost)} · TTFT ${F.fmtMs(item?.ttftP50)} · ${F.fmtRate(item?.errorRate)}`,
			);
		fill.style.width = `${Math.max(0, Math.min(100, share * 100)).toFixed(1)}%`;
		},
	});
}

function renderModelTokens(d) {
	const body = runtime.root?.querySelector('[data-k="tokens.body"]');
	const empty = runtime.root?.querySelector('[data-k="tokens.empty"]');
	if (!body) return;
	const items = runtime.state?.data?.topModels ?? [];
	if (!items.length) {
		clear(body);
		if (empty) {
			empty.hidden = false;
			setText(empty, d.top.empty);
		}
		return;
	}
	if (empty) empty.hidden = true;
	pool(body, items, {
		key: (item) => String(item?.name ?? ""),
		create: () => {
			const cells = ["model", "calls", "input", "output", "cacheRead", "cacheWrite", "total", "cost"].map((key) =>
				h("td", { attrs: { "data-col": key } }),
			);
			return [h("tr", {}, cells)];
		},
		update: (nodes, item) => {
			const cells = nodes[0].children;
			const tok = item?.tokens ?? {};
			const values = [
				item?.name ?? "",
				F.fmtCount(item?.calls),
				F.fmtInt(tok.input),
				F.fmtInt(tok.output),
				F.fmtInt(tok.cacheRead),
				F.fmtInt(tok.cacheWrite),
				F.fmtInt(tok.total),
				F.fmtCost(item?.cost),
			];
			const exact = [
				item?.name ?? "",
				F.fmtCount(item?.calls),
				F.fmtCount(tok.input),
				F.fmtCount(tok.output),
				F.fmtCount(tok.cacheRead),
				F.fmtCount(tok.cacheWrite),
				F.fmtCount(tok.total),
				F.fmtCost(item?.cost),
			];
			for (let i = 0; i < cells.length; i++) {
				setText(cells[i], values[i]);
				cells[i].setAttribute("title", exact[i]);
			}
			cells[6].classList.add("cps-tok-total");
		},
	});
}

function renderPriceSources(d) {
	const box = runtime.root?.querySelector('[data-k="prices.sources"]');
	if (!box) return;
	const prices = runtime.state?.data?.prices ?? {};
	const when = prices.fetchedAt ? F.fmtDateTimeLocal(prices.fetchedAt) : d.foot.pricesNever;
	const summary =
		prices.version && prices.entries
			? d.prices.summary(prices.version, F.fmtCount(prices.entries), when)
			: d.prices.never;
	patch(runtime.root, { "prices.summary": summary });
	const sources = Array.isArray(prices.sources) ? prices.sources : [];
	if (!sources.length) {
		clear(box);
		box.appendChild(h("div", { class: "cps-rank-empty", text: d.prices.empty }));
		return;
	}
	pool(box, sources, {
		key: (src) => String(src?.id ?? src?.label ?? ""),
		create: () => {
			const name = h("span", { class: "cps-rank-name" });
			const meta = h("span", { class: "cps-rank-meta" });
			return [h("div", { class: "cps-rank-row" }, [name, meta])];
		},
		update: (nodes, src) => {
			const row = nodes[0];
			setText(row.children[0], src?.label || src?.id || "");
			const state = src?.ok ? d.prices.ok : d.prices.failed;
			const err = src?.error ? ` · ${src.error}` : "";
			setText(row.children[1], `${state} · ${d.prices.rows} ${F.fmtCount(src?.count ?? 0)}${err}`);
		row.children[1].classList.toggle("cps-src-ok", Boolean(src?.ok));
		row.children[1].classList.toggle("cps-src-bad", !src?.ok);
		},
	});
}

// ──────────────────────────────────────────────────────────── 渲染 · 明细表

function visibleColumns() {
	const hidden = new Set(Array.isArray(runtime.state.table.hidden) ? runtime.state.table.hidden : []);
	const cols = COLUMNS.filter((col) => !hidden.has(col.key));
	return cols.length ? cols : [COLUMNS[0]];
}

function sortValue(record, key) {
	const raw = record?.[key];
	if (raw === null || raw === undefined) return key === "ts" ? 0 : Number.NEGATIVE_INFINITY;
	if (typeof raw === "number") return raw;
	const n = Number(raw);
	return Number.isFinite(n) ? n : String(raw);
}

function sortedRecords() {
	const { key, dir } = runtime.state.query.sort;
	const rows = [...runtime.state.records.items];
	const mul = dir === "asc" ? 1 : -1;
	rows.sort((a, b) => {
		const av = sortValue(a, key);
		const bv = sortValue(b, key);
		if (typeof av === "string" || typeof bv === "string") return String(av).localeCompare(String(bv)) * mul;
		return (av - bv) * mul;
	});
	return rows;
}

function statusBadgeClass(status) {
	if (status === "ok") return "cps-badge ok";
	if (status === "incomplete" || status === "aborted") return "cps-badge warn";
	if (status === "rate_limited") return "cps-badge warn";
	if (status) return "cps-badge bad";
	return "cps-badge mute";
}

function cellText(record, col, d) {
	switch (col.key) {
		case "time":
			return F.fmtDateTimeLocal(record.ts);
		case "model":
			return record.model ?? "--";
		case "provider":
			return record.provider ?? "--";
		case "project":
			return record.project ?? "--";
		case "status":
			return d.statuses[record.status] ?? record.status ?? "--";
		case "input":
			return F.fmtInt(record.input);
		case "output":
			return F.fmtInt(record.output);
		case "total":
			return F.fmtInt(record.total);
		case "cache":
			return `${F.fmtInt(record.cacheRead)}/${F.fmtInt(record.cacheWrite)}`;
		case "cacheHit":
			return F.fmtRate(record.cacheHitRate);
		case "ttft":
			return F.fmtMs(record.ttft);
		case "gen":
			return F.fmtMs(record.gen);
		case "e2e":
			return F.fmtMs(record.e2e);
		case "cost":
			return F.fmtCost(record.cost, { estimate: record.costSource === "estimate" });
		case "origin":
			return d.origins[record.origin] ?? record.origin ?? "--";
		case "session":
			return record.sessionId ? String(record.sessionId).slice(0, 8) : "--";
		default:
			return "";
	}
}

function cellTitle(record, col, d) {
	switch (col.key) {
		case "cost":
			return `${d.table.costSource}: ${d.table.costSources[record.costSource] ?? record.costSource ?? "--"}${record.priceId ? ` · ${d.table.priceId} ${record.priceId}` : ""}`;
		case "cacheHit":
			return "Σ cache_read ÷ (input + cache_read + cache_write)";
		case "time":
			return F.fmtFullLocal(record.ts);
		case "status":
			return record.stopReason ? `${d.table.stopReason}: ${record.stopReason}` : "";
		default:
			return "";
	}
}

function detailText(record, d) {
	const parts = [
		`${d.table.detail}: input ${F.fmtInt(record.input)} · output ${F.fmtInt(record.output)} · cacheRead ${F.fmtInt(record.cacheRead)} · cacheWrite ${F.fmtInt(record.cacheWrite)} · reasoning ${F.fmtInt(record.reasoning)} · total ${F.fmtInt(record.total)} · prompt ${F.fmtInt(record.promptTok)}`,
		`${d.table.origin}: ${d.origins[record.origin] ?? record.origin ?? "--"} · ${d.table.costSource}: ${d.table.costSources[record.costSource] ?? record.costSource ?? "--"}${record.priceId ? ` · ${d.table.priceId} ${record.priceId}` : ""} · ${d.table.stopReason}: ${record.stopReason ?? "--"}`,
		`${d.table.session}: ${record.sessionId ?? "--"} · ${d.table.recordId}: ${record.id ?? "--"}`,
	];
	return parts.join("　|　");
}

function renderTable(d) {
	const st = runtime.state;
	const thead = runtime.root.querySelector('[data-k="table.head"]');
	const tbody = runtime.root.querySelector('[data-k="table.body"]');
	if (!thead || !tbody) return;
	const cols = visibleColumns();
	let headRow = thead.firstElementChild;
	if (!headRow) {
		headRow = h("tr");
		thead.appendChild(headRow);
	}
	const sort = st.query.sort;
	pool(headRow, cols, {
		key: (col) => col.key,
		create: (col) => h("th", { attrs: { scope: "col", "data-col": col.key } }),
		update: (nodes, col) => {
			const th = nodes[0];
			const isSorted = sort.key === col.sort;
			th.setAttribute("aria-sort", isSorted ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
			th.setAttribute("title", d.table.sortHint);
			const arrow = isSorted ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
			setText(th, `${d.table.cols[col.key] ?? col.key}${arrow}`);
		},
	});

	const rows = sortedRecords();
	const emptyText = (() => {
		if (st.records.items.length > 0) return "";
		if (st.records.error) return (d.errors[st.records.error] ?? d.errors.unknown).title;
		if (st.records.loading) return "";
		if (!st.data) return d.empty.noImport;
		if (!(st.data.kpi?.calls > 0)) return d.empty.noCalls;
		return d.table.empty;
	})();
	patch(runtime.root, {
		"table.empty": { text: emptyText, hidden: Boolean(st.records.items.length) || st.records.loading },
	});
	const colSig = cols.map((col) => col.key).join(",");
	pool(tbody, rows, {
		key: (record) => String(record.id ?? record.ts),
		create: () => {
			const main = h("tr", { attrs: { role: "row", "data-rid": "", tabindex: "0", "aria-expanded": "false" } });
			const detailCell = h("td");
			const detail = h("tr", { class: "cps-detail cps-hidden" }, [detailCell]);
			main.__detail = detail;
			main.__detailCell = detailCell;
			main.__colsSig = "";
			return [main, detail];
		},
		update: (nodes, record) => {
			const main = nodes[0];
			const detail = main.__detail;
			const detailCell = main.__detailCell;
			const expanded = String(st.records.expandedId ?? "") === String(record.id ?? "");
			main.setAttribute("data-rid", String(record.id ?? ""));
			main.setAttribute("aria-expanded", expanded ? "true" : "false");
			if (main.__colsSig !== colSig) {
				main.__colsSig = colSig;
				clear(main);
				for (const col of cols) {
					const span = h("span");
					const td = h("td", { class: col.num ? "cps-c-num" : undefined }, [span]);
					td.setAttribute("data-col", col.key);
					main.appendChild(td);
				}
			}
			cols.forEach((col, index) => {
				const td = main.children[index];
				if (!td) return;
				const span = td.firstChild;
				setText(span, cellText(record, col, d));
				if (col.key === "status") span.className = statusBadgeClass(record.status);
				else if (span.className) span.className = "";
				const title = cellTitle(record, col, d);
				if (title) td.setAttribute("title", title);
				else td.removeAttribute("title");
			});
			detailCell.setAttribute("colspan", String(cols.length));
			detailCell.textContent = detailText(record, d);
			detail.classList.toggle("cps-hidden", !expanded);
		},
	});

	const count = st.records.items.length;
	const total = st.records.total;
	patch(runtime.root, {
		"table.count": `${d.table.loaded(F.fmtCount(count))}${total ? ` · ${d.table.total(F.fmtCount(total))}` : ""}`,
		"table.hint": d.table.hint(F.fmtCount(count)),
		"table.prev": { text: `‹ ${d.table.prev}`, disabled: st.records.stack.length === 0 || st.records.loading },
		"table.next": { text: `${d.table.next} ›`, disabled: !st.records.nextCursor || st.records.loading },
		"table.colsPanel": { hidden: !st.table.showCols },
		"table.colsBtn": { text: d.columns, attrs: { "aria-expanded": st.table.showCols ? "true" : "false" } },
	});
	const sizeSelect = runtime.root.querySelector('[data-k="table.pageSize"]');
	if (sizeSelect) {
		pool(sizeSelect, TABLE_SIZES, {
			key: (n) => String(n),
			create: (n) => h("option", { attrs: { value: String(n) } }),
			update: (nodes, n) => setText(nodes[0], `${n}${d.table.rowsPerPage}`),
		});
		if (sizeSelect.value !== String(st.records.limit)) sizeSelect.value = String(st.records.limit);
	}
	const hidden = new Set(st.table.hidden);
	for (const key of COLUMN_KEYS) {
		patch(runtime.root, { [`table.col.${key}`]: { value: !hidden.has(key) } });
	}
}

// ──────────────────────────────────────────────────────────── 渲染 · 导入 / 页脚

function renderImport(d) {
	const st = runtime.state;
	const status = st.importStatus;
	const phase = status?.phase ?? "idle";
	const phaseLabel = d.import.phase[phase] ?? phase;
	const filesTotal = Number(status?.filesTotal) || 0;
	const filesDone = Number(status?.filesDone) || 0;
	const rows = Number(status?.rowsTotal) || 0;
	const running = IMPORT_RUNNING.has(phase);
	const showPanel = running || phase === "migrating" || phase === "error" || phase === "recalc";
	const percent = filesTotal > 0 ? Math.max(0, Math.min(100, Math.round((filesDone / filesTotal) * 100))) : running ? 0 : 0;
	patch(runtime.root, {
		"import.panel": { hidden: !showPanel },
		"import.phase": phaseLabel,
		"import.progress": status ? d.import.progress(F.fmtCount(filesDone), F.fmtCount(filesTotal)) : "",
		"import.rows": status ? d.import.rows(F.fmtCount(rows)) : "",
		"import.eta": status?.etaMs ? d.import.eta(F.fmtEta(status.etaMs)) : "",
		"import.bar": {
			attrs: {
				"aria-valuenow": String(percent),
				"aria-valuetext": `${percent}% · ${phaseLabel}`,
				"aria-label": d.import.barLabel,
			},
		},
		"import.fill": { style: { width: `${percent}%` } },
		"import.meta": [
			status?.lastError ? d.import.lastError(status.lastError) : "",
			status?.finishedAt ? d.import.lastRun(F.fmtDateTimeLocal(status.finishedAt)) : d.import.never,
			status && status.workerAlive === false ? d.import.workerDown : "",
		]
			.filter(Boolean)
			.join(" · "),
		"import.start": { hidden: running },
		"import.pause": { hidden: !(phase === "scanning" || phase === "importing") },
		"import.resume": { hidden: phase !== "paused" },
		"import.cancel": { hidden: !running },
	});
}

function renderFoot(d) {
	const st = runtime.state;
	const data = st.data;
	if (!data) {
		patch(runtime.root, { "foot.meta": "" });
		return;
	}
	const range = data.range ?? {};
	const fresh = data.freshness ?? {};
	const prices = data.prices ?? {};
	const coverage = fresh.coverage ?? {};
	const meta = [
		`${d.foot.engine} v3`,
		d.foot.rollup(data.version ?? 0),
		fresh.ledgerRecords !== undefined ? d.foot.ledger(F.fmtCount(fresh.ledgerRecords)) : "",
		coverage.eligible ? d.foot.sessions(F.fmtCount(coverage.imported ?? 0), F.fmtCount(coverage.eligible)) : "",
		range.timezone ? d.foot.tz(`${range.timezone}${range.tzLabel ? ` ${range.tzLabel}` : ""}`) : "",
		prices.overridesError ? `priceOverrides: ${prices.overridesError}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	patch(runtime.root, { "foot.meta": meta });
}

// ──────────────────────────────────────────────────────────── 总渲染

function render() {
	if (!runtime.root || !runtime.state) return;
	const st = runtime.state;
	const d = runtime.d;
	runtime.root.dataset.phase = st.phase;
	runtime.root.dataset.hasData = st.data ? "1" : "0";
	renderTexts(d);
	renderBanners(d);
	renderQueryState(d);
	renderTruth(d);
	renderKpis(d);
	renderCharts(d);
	renderRank(runtime.root.querySelector('[data-k="top.models.list"]'), st.data?.topModels ?? [], d, d.top.empty);
	renderRank(runtime.root.querySelector('[data-k="top.projects.list"]'), st.data?.topProjects ?? [], d, d.top.empty);
	renderModelTokens(d);
	renderPriceSources(d);
	renderTable(d);
	renderImport(d);
	renderFoot(d);
}

// ──────────────────────────────────────────────────────────── 交互

function setNotice(text) {
	const st = runtime.state;
	st.ui.notice = text;
	clearTimeout(runtime.noticeTimer);
	runtime.noticeTimer = setTimeout(() => {
		st.ui.notice = "";
		render();
	}, NOTICE_MS);
	render();
}

/** 把 query.from/to 播种到两个日期输入框（只在进入自定义、恢复 URL 时调用）。 */
function seedCustomInputs() {
	const st = runtime.state;
	if (!st) return;
	const from = runtime.root?.querySelector('[data-k="range.from"]');
	const to = runtime.root?.querySelector('[data-k="range.to"]');
	if (from) from.value = st.query.from ?? "";
	if (to) to.value = st.query.to ?? "";
}

function setRange(value) {
	const st = runtime.state;
	if (value === "custom") {
		if (!st.query.from || !st.query.to) {
			const range = st.data?.range;
			const to = range?.toMs ?? Date.now();
			const from = range?.fromMs ?? to - 24 * 3_600_000;
			st.query.from = F.toDateInput(from);
			st.query.to = F.toDateInput(to);
		}
		seedCustomInputs();
	}
	if (st.query.range === value) return;
	st.query.range = value;
	onQueryChanged();
}

function applyCustomRange() {
	const st = runtime.state;
	const from = runtime.root.querySelector('[data-k="range.from"]')?.value ?? "";
	const to = runtime.root.querySelector('[data-k="range.to"]')?.value ?? "";
	st.query.from = from;
	st.query.to = to;
	st.query.range = "custom";
	onQueryChanged();
}

function setGran(value) {
	const st = runtime.state;
	if (st.query.gran === value) return;
	st.query.gran = value;
	onQueryChanged();
}

function setView(value) {
	const st = runtime.state;
	if (st.query.view === value) return;
	st.query.view = value;
	syncHash();
	render();
	if (value === "table") ensureRecords();
}

function applyFilter(key, value) {
	const st = runtime.state;
	const next = value || "all";
	if (st.query[key] === next) return;
	st.query[key] = next;
	onQueryChanged();
}

function toggleStatusFilter(status) {
	const st = runtime.state;
	st.query.status = toggleFilter(st.query.status, status);
	onQueryChanged();
}

function clearFilters() {
	const st = runtime.state;
	st.query.model = "all";
	st.query.provider = "all";
	st.query.project = "all";
	st.query.status = "all";
	onQueryChanged();
}

function toggleSort(key) {
	const st = runtime.state;
	const current = st.query.sort;
	if (!key) return;
	if (current.key === key) current.dir = current.dir === "asc" ? "desc" : "asc";
	else {
		current.key = key;
		current.dir = key === "ts" ? "desc" : "desc";
	}
	syncHash();
	render();
}

function toggleColumn(key) {
	const st = runtime.state;
	const hidden = new Set(st.table.hidden);
	if (hidden.has(key)) hidden.delete(key);
	else hidden.add(key);
	// 至少留一列，避免表格塌成空行
	if (hidden.size >= COLUMN_KEYS.length) hidden.delete("time");
	st.table.hidden = [...hidden].filter((k) => COLUMN_KEYS.includes(k));
	writeStore(LS_HIDDEN_COLS, st.table.hidden);
	render();
}

function toggleRecord(id) {
	const st = runtime.state;
	st.records.expandedId = String(st.records.expandedId ?? "") === String(id) ? null : String(id);
	render();
}

function nextPage() {
	const st = runtime.state;
	if (!st.records.nextCursor || st.records.loading) return;
	st.records.stack.push(st.records.cursor);
	void loadRecords({ reset: false, cursor: st.records.nextCursor });
}

function prevPage() {
	const st = runtime.state;
	if (!st.records.stack.length || st.records.loading) return;
	const cursor = st.records.stack.pop();
	void loadRecords({ reset: true, cursor });
}

function exportCsv() {
	const st = runtime.state;
	const params = apiParams(st.query);
	const anchor = document.createElement("a");
	anchor.href = `${apiBase()}/api/v3/export?format=csv&${params.toString()}`;
	anchor.download = `usage-ledger-${st.query.range}-${F.toDateInput(Date.now())}.csv`;
	anchor.rel = "noopener";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setNotice(runtime.d.notice.exportStarted);
}

function onClick(event) {
	const target = event.target instanceof Element ? event.target : null;
	if (!target || !runtime.root?.contains(target)) return;
	// 表格行展开（点行内任意位置）
	const row = target.closest("tr[data-rid]");
	const inTable = target.closest('[data-k="table.table"]');
	const header = target.closest("th[data-col]");
	if (header && inTable) {
		const col = COLUMNS.find((c) => c.key === header.getAttribute("data-col"));
		toggleSort(col?.sort);
		return;
	}
	// 点击空白处关闭弹层
	if (!target.closest(".cps-pop") && !target.closest('[data-act="toggle-status"]')) {
		if (runtime.state.table.statusOpen || runtime.state.table.showCols) {
			runtime.state.table.statusOpen = false;
			runtime.state.table.showCols = false;
			render();
		}
	}
	// 复选框改由 change 事件处理（click 与 change 都监听会导致「翻两次 = 不变」）
	const actOnInput = target.getAttribute?.("data-act");
	if (target.tagName === "INPUT" && (actOnInput === "col" || actOnInput === "status")) return;
	const actionNode = target.closest("[data-act]");
	if (!actionNode) {
		if (row && inTable) toggleRecord(row.getAttribute("data-rid"));
		return;
	}
	const act = actionNode.getAttribute("data-act");
	const value = actionNode.getAttribute("data-value") ?? "";
	switch (act) {
		case "range":
			setRange(value);
			return;
		case "range-apply":
			applyCustomRange();
			return;
		case "gran":
			setGran(value);
			return;
		case "view":
			setView(value);
			return;
		case "refresh":
			void loadOverview();
			void loadImportStatus();
			return;
		case "prices-refresh":
			void refreshPrices();
			return;
		case "export":
			exportCsv();
			return;
		case "toggle-status":
			runtime.state.table.statusOpen = !runtime.state.table.statusOpen;
			runtime.state.table.showCols = false;
			render();
			return;
		case "status":
			toggleStatusFilter(value);
			return;
		case "clear-filters":
			clearFilters();
			return;
		case "toggle-cols":
			runtime.state.table.showCols = !runtime.state.table.showCols;
			runtime.state.table.statusOpen = false;
			render();
			return;
		case "col":
			toggleColumn(value);
			return;
		case "page-size":
			return;
		case "prev-page":
			prevPage();
			return;
		case "next-page":
			nextPage();
			return;
		case "import-start":
			void postAction("/api/v3/import/start");
			return;
		case "import-pause":
			void postAction("/api/v3/import/pause");
			return;
		case "import-resume":
			void postAction("/api/v3/import/resume");
			return;
		case "import-cancel":
			void postAction("/api/v3/import/cancel");
			return;
		case "grant":
			void postAction("/api/v3/grant", { reload: true });
			return;
		default:
			break;
	}
	if (row && inTable) toggleRecord(row.getAttribute("data-rid"));
}

function onChange(event) {
	const target = event.target instanceof Element ? event.target : null;
	if (!target) return;
	const act = target.getAttribute?.("data-act");
	if (act === "filter-model" || act === "filter-provider" || act === "filter-project") {
		applyFilter(act.replace("filter-", ""), target.value);
		return;
	}
	if (act === "page-size") {
		const size = Number(target.value);
		if (!TABLE_SIZES.includes(size)) return;
		runtime.state.records.limit = size;
		void loadRecords({ reset: true, cursor: null });
		return;
	}
	if (act === "col") {
		const key = target.getAttribute("data-value");
		if (key) toggleColumn(key);
		return;
	}
	if (act === "status") {
		const value = target.getAttribute("data-value");
		if (value) toggleStatusFilter(value);
	}
}

function onKeyDown(event) {
	const target = event.target instanceof Element ? event.target : null;
	if (!target) return;
	// tablist 方向键切换（自动激活，符合 WAI-ARIA tabs 模式）
	const group = target.closest('[role="tablist"]');
	if (group && target.getAttribute("role") === "tab") {
		const tabs = [...group.querySelectorAll('[role="tab"]')];
		const index = tabs.indexOf(target);
		if (index < 0) return;
		let next = -1;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
		else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = tabs.length - 1;
		else if (event.key === "Enter" || event.key === " ") next = index;
		if (next < 0) return;
		event.preventDefault();
		const tab = tabs[next];
		tab.focus();
		tab.click();
		return;
	}
	// 表格行：Enter/Space 展开
	const row = target.closest?.("tr[data-rid]");
	if (row && (event.key === "Enter" || event.key === " ")) {
		event.preventDefault();
		toggleRecord(row.getAttribute("data-rid"));
	}
}

// ──────────────────────────────────────────────────────────── 轮询与观察器

function scheduleOverviewPoll(delay) {
	clearTimeout(runtime.pollTimer);
	runtime.pollTimer = setTimeout(() => {
		runtime.pollTimer = null;
		if (!runtime.mounted) return;
		if (document.visibilityState === "hidden" || !viewVisible()) {
			scheduleOverviewPoll(POLL_HIDDEN_MS);
			return;
		}
		void loadOverview();
		scheduleOverviewPoll(POLL_VISIBLE_MS);
	}, delay);
}

/** 宿主把非当前视图留在 DOM 里（display:none），别为看不见的看板打请求。 */
function viewVisible() {
	try {
		const root = runtime.root;
		if (!root || !root.isConnected) return false;
		if (typeof root.checkVisibility === "function") return root.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
		return true;
	} catch {
		return true;
	}
}

function scheduleImportPoll(delay) {
	clearTimeout(runtime.importTimer);
	runtime.importTimer = setTimeout(() => {
		runtime.importTimer = null;
		if (!runtime.mounted) return;
		void loadImportStatus().then(() => {
			if (!runtime.mounted) return;
			// 运行中 2s、空闲 30s；页面不可见时一律退到 30s
			const next = document.visibilityState === "hidden" ? POLL_IMPORT_IDLE_MS : isImportRunning() ? POLL_IMPORT_RUNNING_MS : POLL_IMPORT_IDLE_MS;
			scheduleImportPoll(next);
		});
	}, delay);
}

/** 滚到底部才拉明细（首屏不发第三个请求）。 */
function ensureSentinelObserver() {
	const sentinel = runtime.root?.querySelector('[data-k="records.sentinel"]');
	if (!sentinel || typeof IntersectionObserver === "undefined") return;
	let first = true;
	try {
		runtime.sentinelObserver = new IntersectionObserver((entries) => {
			// 首次回调只反映挂载瞬间的可见性，不能当成「用户滚到底部」
			if (first) {
				first = false;
				return;
			}
			if (entries.some((entry) => entry.isIntersecting)) ensureRecords();
		});
		runtime.sentinelObserver.observe(sentinel);
	} catch {
		runtime.sentinelObserver = null;
	}
}

function stopSentinelObserver() {
	try {
		runtime.sentinelObserver?.disconnect();
	} catch {
		/* ignore */
	}
	runtime.sentinelObserver = null;
}

function onVisibilityChange() {
	if (!runtime.mounted) return;
	if (document.visibilityState === "visible") {
		void loadOverview();
		void loadImportStatus();
	}
}

function applyLang() {
	if (!runtime.mounted) return;
	const next = detectLang();
	if (next === runtime.state.lang) return;
	runtime.state.lang = next;
	runtime.d = dict(next);
	runtime.chartSig = "";
	render();
}

// ──────────────────────────────────────────────────────────── 生命周期

function readHiddenCols() {
	const stored = readStore(LS_HIDDEN_COLS, []);
	const list = Array.isArray(stored) ? stored.filter((key) => COLUMN_KEYS.includes(key)) : [];
	return list.length >= COLUMN_KEYS.length ? [] : list;
}

function bind(container) {
	const st = runtime.state;
	const root = h("div", { class: "cps-root", attrs: { "data-phase": "loading" } });
	runtime.root = root;
	container.appendChild(root);
	runtime.refs = buildSkeleton(root);

	runtime.charts.calls = createChart(runtime.refs.chartCalls, {
		key: "calls",
		kind: "bars",
		titleKey: "callsTitle",
		yKind: "count",
		series: CHART_CALLS_SERIES,
	});
	runtime.charts.latency = createChart(runtime.refs.chartLatency, {
		key: "latency",
		kind: "lines",
		titleKey: "latencyTitle",
		yKind: "ms",
		series: CHART_LATENCY_SERIES,
	});
	runtime.sparks.clear();
	for (const [key, host] of runtime.refs.sparks) runtime.sparks.set(key, createSparkline(host));

	const add = (target, type, handler, options) => {
		target.addEventListener(type, handler, options);
		runtime.cleanups.push(() => target.removeEventListener(type, handler, options));
	};
	add(root, "click", onClick);
	add(root, "change", onChange);
	add(root, "keydown", onKeyDown);
	add(document, "visibilitychange", onVisibilityChange);
	add(window, "hashchange", applyHash);

	// 语言：宿主 onLocale 优先，documentElement.lang 变化兜底
	try {
		const host = window.__piWebUiHost;
		if (host && typeof host.onLocale === "function") {
			const off = host.onLocale(() => applyLang());
			if (typeof off === "function") runtime.offLocale = off;
		}
		if (host && typeof host.onViewChange === "function") {
			const off = host.onViewChange((view) => {
				if (view === VIEW_NAME && runtime.mounted) {
					void loadOverview();
					void loadImportStatus();
				}
			});
			if (typeof off === "function") runtime.offViewChange = off;
		}
	} catch {
		/* 宿主没提供对应钩子：仅靠 lang 观察器 */
	}
	if (typeof MutationObserver !== "undefined") {
		runtime.langObserver = new MutationObserver(() => applyLang());
		runtime.langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
	}

	st.lang = detectLang();
	runtime.d = dict(st.lang);
	render();

	// 首屏：只发 overview + import/status（表格视图从 URL 恢复时才补 records）
	void loadOverview();
	void loadImportStatus();
	if (st.query.view === "table") ensureRecords();
	ensureSentinelObserver();
	scheduleOverviewPoll(POLL_VISIBLE_MS);
	scheduleImportPoll(POLL_IMPORT_RUNNING_MS);
	seedCustomInputs();
	syncHash();
}

/**
 * 挂载看板。
 * @param {HTMLElement} container 宿主给的普通 div
 * @returns {() => void} cleanup
 */
export function mount(container) {
	if (!container) return () => {};
	// 宿主若在同一容器上重复 mount（视图重建），先收掉旧实例：runtime 是模块级单例
	if (typeof runtime.activeCleanup === "function") {
		try {
			runtime.activeCleanup();
		} catch {
			/* 旧实例已坏：继续挂新的 */
		}
		runtime.activeCleanup = null;
	}
	ensureStyles();
	const parsed = parseHash(typeof location !== "undefined" ? location.hash : "");
	runtime.state = createState({ lang: detectLang(), query: parsed.query, hidden: readHiddenCols() });
	runtime.mounted = true;
	runtime.chartSig = "";
	bind(container);

	const cleanup = () => {
		runtime.mounted = false;
		for (const fn of runtime.cleanups.splice(0)) {
			try {
				fn();
			} catch {
				/* ignore */
			}
		}
		clearTimeout(runtime.pollTimer);
		clearTimeout(runtime.importTimer);
		clearTimeout(runtime.noticeTimer);
		runtime.pollTimer = null;
		runtime.importTimer = null;
		runtime.noticeTimer = null;
		stopSentinelObserver();
		try {
			runtime.overviewCtl?.abort();
			runtime.recordsCtl?.abort();
		} catch {
			/* ignore */
		}
		runtime.overviewCtl = null;
		runtime.recordsCtl = null;
		try {
			runtime.offLocale?.();
			runtime.offViewChange?.();
		} catch {
			/* ignore */
		}
		runtime.offLocale = null;
		runtime.offViewChange = null;
		try {
			runtime.langObserver?.disconnect();
		} catch {
			/* ignore */
		}
		runtime.langObserver = null;
		for (const chart of Object.values(runtime.charts)) {
			try {
				chart?.destroy?.();
			} catch {
				/* ignore */
			}
		}
		runtime.charts = { calls: null, latency: null };
		runtime.sparks.clear();
		try {
			runtime.root?.remove();
		} catch {
			/* ignore */
		}
		runtime.root = null;
		runtime.refs = null;
		runtime.state = null;
		runtime.chartSig = "";
		if (runtime.activeCleanup === cleanup) runtime.activeCleanup = null;
	};
	runtime.activeCleanup = cleanup;
	return cleanup;
}

/** 底栏徽标（`usage-ledger:open`）→ 切到本插件视图（走宿主 setView，不碰宿主 DOM）。 */
function openView() {
	try {
		window.__piWebUiHost?.setView?.(VIEW_NAME);
	} catch {
		/* 宿主没有 setView（旧版本）：静默失败 */
	}
}

function register() {
	try {
		const host = window.__piWebUiHost;
		if (host && typeof host.onUiAction === "function") host.onUiAction(ACTION_OPEN, () => openView());
	} catch {
		/* ignore */
	}
}

if (typeof window !== "undefined") {
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", register, { once: true });
	else register();
}

export default { mount };
