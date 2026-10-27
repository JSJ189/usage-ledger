/**
 * usage-ledger 客户端看板
 *
 * 职责：
 *  1. 底栏徽标（bottombar 槽位）点击 → 切到本插件视图（走宿主 setView，不碰宿主 DOM）；
 *  2. 视图内渲染看板：指标卡（请求/成功率/取消/TTFT p50·p90·p99/平均时延/平均 tok·s⁻¹/token 合计）、
 *     按小时双图（请求数 + TTFT p90）、按模型汇总表、最近事件明细（可点开看单条 token 拆分）；
 *  3. 窗口（今日/7 天/30 天）与客户端族（全部/仅 pi）筛选，全部参数经宿主路由白名单校验；
 *  4. 图表手写 SVG，零外部 CDN、零新增依赖；样式全在插件自己的 <style> 里，前缀 cps-。
 *
 * 数字口径（与 README / 服务端一致）：
 *  - `TTFT` = 代理侧「收到请求 → 上游首包」，与 response-speed 插件的客户端 TTFT 不是一回事；
 *  - `tok/s` = output_tokens / ((latency - ttft)/1000)，只有 latency > ttft 且 output > 0 的行参与；
 *  - 失败率按 `failed ∪ canceled` 并集计一次。
 */
// 独立仓库：不引 `@pi-web-ui/plugin-sdk/client`（浏览器里是裸 ESM，解析不到宿主别名），
// 把用到的两个纯函数内联在这里，语义与 plugin-sdk/client-utils.mjs 完全一致。

/** HTML 转义（同 SDK：& < > " '）。 */
function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

/** 插件 API 前缀（同 SDK：/plugins-api/<pluginId>）。 */
function sharedApiBase(pluginId) {
	return `/plugins-api/${pluginId}`;
}

const ACTION_OPEN = "usage-ledger:open";
const VIEW_NAME = "plugin:usage-ledger";
const STYLE_ID = "usage-ledger-styles";
const REFRESH_MS = 60_000;

// ──────────────────────────────────────────────────────────── 文案

const ZH = {
	title: "用量账本",
	subtitle: "EasyCLIProxyAPI 用量账本（只读）",
	win: { today: "今日", "7d": "7 天", "30d": "30 天" },
	clientAll: "全部客户端",
	clientPi: "仅 pi 家族",
	refresh: "刷新",
	loading: "加载中…",
	calls: "总请求",
	successRate: "成功率",
	canceled: "取消 / 失败",
	ttftP50: "TTFT p50",
	ttftP90: "TTFT p90",
	ttftP99: "TTFT p99",
	latencyAvg: "平均时延",
	tokPerSec: "平均 tok·s⁻¹",
	tokensIn: "输入 token",
	tokensOut: "输出 token",
	cacheRead: "缓存读 token",
	chartCalls: "按小时 · 请求数",
	chartTtft: "按小时 · TTFT 分位",
	modelTable: "按模型汇总",
	eventTable: "最近事件",
	thModel: "模型",
	thCalls: "请求",
	thFail: "失败率",
	thTtft: "TTFT p50",
	thTokps: "tok·s⁻¹",
	thTokens: "token 合计",
	thTime: "时间",
	thClient: "客户端",
	thStatus: "状态",
	thLatency: "时延",
	thDetail: "拆分明细",
	statusOk: "成功",
	statusFailed: "失败",
	statusCanceled: "取消",
	empty: "该窗口没有代理记录。",
	noDb: "未找到账本",
	hintNoDb: "在插件设置里填 usage.db 绝对路径，或用环境变量 CLIPROXY_USAGE_DB 指定；也支持任意兼容 schema 的 SQLite 用量账本。",
	hintTried: "已尝试的位置",
	hintPath: "账本",
	samples: "样本",
	metaSaved: "缓存命中",
	noSamples: "无样本",
	legendCalls: "请求",
	legendFailed: "失败/取消",
	legendP50: "p50",
	legendP90: "p90",
	kvIn: "输入",
	kvOut: "输出",
	kvReasoning: "推理",
	kvCacheRead: "缓存读",
	kvCacheCreate: "缓存写",
	kvTotal: "合计",
	retry: "重试",
	cost: "估算成本",
	costNote: "未知价",
	groupBy: "分组",
	dim: { model: "模型", provider: "路由", executor: "执行器", endpoint: "接口", client: "客户端" },
	thKey: "名称",
	thCost: "≈ 成本",
	routeTable: "按维度汇总",
	price: "价格快照",
	priceNone: "价格未同步（成本显示 --）",
	priceFailed: "刷新失败",
	priceSrc: "来源",
	priceRefresh: "刷新价目表",
	estimate: "估算（USD，按 1M tokens 单价）",
	overrideErr: "价格覆盖配置有误",
	unknownShare: "未知价占比",
	unknownCount: "未知价",
	unknownTimes: "次",
	// R7：跨源价格分歧（价表里同模型多源报价不一致时选中的那一个）
	multiSource: "多源不一致",
	multiSourceHint: "跨源价格分歧：",
	multiSourceTimes: "次请求",
	excluded: "已排除未知价请求",
	allPriced: "全部有价",
	noPriced: "无有价请求",
};

const EN = {
	title: "Usage Ledger",
	subtitle: "EasyCLIProxyAPI usage ledger (read-only)",
	win: { today: "Today", "7d": "7 days", "30d": "30 days" },
	clientAll: "All clients",
	clientPi: "pi family only",
	refresh: "Refresh",
	loading: "Loading…",
	calls: "Requests",
	successRate: "Success rate",
	canceled: "Canceled / failed",
	ttftP50: "TTFT p50",
	ttftP90: "TTFT p90",
	ttftP99: "TTFT p99",
	latencyAvg: "Avg latency",
	tokPerSec: "Avg tok·s⁻¹",
	tokensIn: "Input tokens",
	tokensOut: "Output tokens",
	cacheRead: "Cache-read tokens",
	chartCalls: "Hourly · requests",
	chartTtft: "Hourly · TTFT percentiles",
	modelTable: "By model",
	eventTable: "Recent events",
	thModel: "Model",
	thCalls: "Requests",
	thFail: "Fail rate",
	thTtft: "TTFT p50",
	thTokps: "tok·s⁻¹",
	thTokens: "Tokens",
	thTime: "Time",
	thClient: "Client",
	thStatus: "Status",
	thLatency: "Latency",
	thDetail: "Token breakdown",
	statusOk: "ok",
	statusFailed: "failed",
	statusCanceled: "canceled",
	empty: "No proxy records in this window.",
	noDb: "Ledger not found",
	hintNoDb: "Set the absolute usage.db path in the plugin settings, or point CLIPROXY_USAGE_DB at it; any SQLite usage ledger with a compatible schema works.",
	hintTried: "Locations tried",
	hintPath: "Ledger",
	samples: "samples",
	metaSaved: "cached",
	noSamples: "no samples",
	legendCalls: "requests",
	legendFailed: "failed/canceled",
	legendP50: "p50",
	legendP90: "p90",
	kvIn: "input",
	kvOut: "output",
	kvReasoning: "reasoning",
	kvCacheRead: "cache read",
	kvCacheCreate: "cache write",
	kvTotal: "total",
	retry: "Retry",
	cost: "Est. cost",
	costNote: "unknown price",
	groupBy: "Group",
	dim: { model: "model", provider: "route", executor: "executor", endpoint: "endpoint", client: "client" },
	thKey: "Name",
	thCost: "≈ Cost",
	routeTable: "Breakdown",
	price: "Price snapshot",
	priceNone: "Prices not synced (cost shows --)",
	priceFailed: "refresh failed",
	priceSrc: "sources",
	priceRefresh: "Refresh prices",
	estimate: "estimate (USD per 1M tokens)",
	overrideErr: "price overrides invalid",
	unknownShare: "unknown-price share",
	unknownCount: "unknown price",
	unknownTimes: " call(s)",
	multiSource: "multi-source",
	multiSourceHint: "cross-source price divergence: ",
	multiSourceTimes: " call(s)",
	excluded: "unknown-price calls excluded",
	allPriced: "all priced",
	noPriced: "no priced call",
};

function detectLang() {
	try {
		const lang = String(document.documentElement.lang || "").toLowerCase();
		if (lang.startsWith("zh")) return "zh";
		if (lang) return "en";
	} catch {
		/* 极老浏览器：走回落 */
	}
	try {
		return String(navigator.language || "")
			.toLowerCase()
			.startsWith("zh")
			? "zh"
			: "en";
	} catch {
		return "zh";
	}
}

export function dict(lang) {
	return lang === "en" ? EN : ZH;
}

// ──────────────────────────────────────────────────────────── 格式化

function fmtInt(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return "--";
	if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
	if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
	if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
	return String(Math.round(v));
}

export function fmtMs(ms) {
	const v = Number(ms);
	if (!Number.isFinite(v) || v <= 0) return "--";
	if (v < 1000) return `${Math.round(v)}ms`;
	if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)}s`;
	return `${Math.floor(v / 60_000)}m${String(Math.round((v % 60_000) / 1000)).padStart(2, "0")}s`;
}

/** 坐标轴刻度：0 也是有效刻度，不能像 fmtMs 那样回落 "--"。 */
function fmtAxisMs(ms) {
	const v = Number(ms);
	if (!Number.isFinite(v)) return "--";
	if (v === 0) return "0";
	return fmtMs(v);
}

function fmtRate(x) {
	const v = Number(x);
	if (!Number.isFinite(v)) return "--";
	return `${(v * 100).toFixed(1)}%`;
}

function fmtTokps(x) {
	const v = Number(x);
	if (!Number.isFinite(v) || v < 0) return "--";
	return v.toFixed(v < 10 ? 2 : 0);
}

export function fmtCost(amount, d) {
	const v = Number(amount);
	if (amount === null || amount === undefined || !Number.isFinite(v)) return "--";
	const digits = v < 1 ? 4 : 2;
	return `≈$${v.toFixed(digits)}`;
}

function fmtPct(x) {
	const v = Number(x);
	if (!Number.isFinite(v)) return "--";
	return `${(v * 100).toFixed(v > 0 && v < 0.01 ? 2 : 1)}%`;
}

function fmtHour(hour, lang) {
	// 服务端下发的是本地小时键 `YYYY-MM-DDTHH:00:00`
	const s = String(hour ?? "");
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
	if (!m) return s;
	return `${m[2]}-${m[3]} ${m[4]}:00`;
}

function fmtTime(iso) {
	const s = String(iso ?? "");
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
	if (!m) return s;
	return `${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

function apiBase() {
	return sharedApiBase("usage-ledger");
}

// ──────────────────────────────────────────────────────────── 样式

function ensureStyles() {
	if (typeof document === "undefined") return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		.cps-root {
			display: flex; flex-direction: column; gap: 12px;
			padding: 14px 16px 24px; height: 100%; overflow: auto;
			overscroll-behavior: contain;
			color: var(--text, #e6e8ef); background: var(--bg, #14161d);
			font-size: 13px; line-height: 1.5;
			min-width: 0; max-width: 100%;
		}
		.cps-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
		.cps-title { font-size: 15px; font-weight: 600; }
		.cps-sub { color: var(--text-dim, #8b90a0); font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
		.cps-spacer { flex: 1 1 auto; }
		.cps-seg { display: inline-flex; border: 1px solid var(--border, #2a2e3a); border-radius: 8px; overflow: hidden; }
		.cps-seg button {
			background: transparent; color: var(--text-dim, #8b90a0); border: 0; cursor: pointer;
			padding: 4px 10px; font-size: 12px; font-family: inherit;
		}
		.cps-seg button.on { background: var(--accent, #7c5cff); color: var(--accent-contrast, #fff); }
		.cps-btn {
			background: var(--bg-elev2, #1a1d26); color: var(--text, #e6e8ef);
			border: 1px solid var(--border, #2a2e3a); border-radius: 8px;
			padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
		}
		.cps-btn:hover { border-color: var(--accent, #7c5cff); }
		.cps-btn:disabled { opacity: 0.55; cursor: default; }
		.cps-cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); }
		.cps-card {
			background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #2a2e3a);
			border-radius: 10px; padding: 10px 12px; min-width: 0;
		}
		.cps-card .k { color: var(--text-dim, #8b90a0); font-size: 11.5px; }
		.cps-card .v { font-size: 18px; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }
		.cps-card .n { color: var(--text-faint, #6b7080); font-size: 11px; margin-top: 2px; }
		.cps-panel {
			background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #2a2e3a);
			border-radius: 10px; padding: 10px 12px; min-width: 0;
		}
		.cps-panel > h3 { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; color: var(--text-dim, #8b90a0); }
		.cps-legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-faint, #6b7080); margin-top: 4px; }
		.cps-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
		.cps-svg { display: block; width: 100%; height: auto; overflow: visible; }
		.cps-grid2 { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
		.cps-tbl-wrap { overflow-x: auto; min-width: 0; }
		.cps-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
		.cps-tbl th, .cps-tbl td {
			text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--border, #2a2e3a);
			white-space: nowrap;
		}
		.cps-tbl th:first-child, .cps-tbl td:first-child { text-align: left; }
		.cps-tbl th { color: var(--text-dim, #8b90a0); font-weight: 500; font-size: 11.5px; }
		.cps-tbl tbody tr { cursor: pointer; }
		.cps-tbl tbody tr:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 10%, transparent); }
		.cps-tbl td.mono { font-variant-numeric: tabular-nums; }
		.cps-detail td {
			text-align: left; color: var(--text-dim, #8b90a0); background: color-mix(in srgb, var(--accent, #7c5cff) 6%, transparent);
			white-space: normal; overflow-wrap: anywhere;
		}
		.cps-detail b { color: var(--text, #e6e8ef); font-weight: 600; }
		.cps-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
		.cps-badge.ok { background: color-mix(in srgb, var(--green, #10b981) 22%, transparent); color: var(--green, #10b981); }
		.cps-badge.bad { background: color-mix(in srgb, var(--red, #ef4444) 22%, transparent); color: var(--red, #ef4444); }
		.cps-badge.cancel { background: color-mix(in srgb, var(--amber, #f59e0b) 22%, transparent); color: var(--amber, #f59e0b); }
		.cps-badge.multi { background: color-mix(in srgb, var(--amber, #f59e0b) 14%, transparent); color: var(--amber, #f59e0b); font-weight: 500; margin-left: 5px; }
		.cps-notice {
			border: 1px solid color-mix(in srgb, var(--amber, #f59e0b) 45%, transparent);
			background: color-mix(in srgb, var(--amber, #f59e0b) 12%, transparent);
			border-radius: 10px; padding: 12px; font-size: 12.5px;
		}
		.cps-notice h3 { margin: 0 0 6px; font-size: 13px; }
		.cps-notice p { margin: 4px 0; color: var(--text-dim, #8b90a0); overflow-wrap: anywhere; }
		.cps-notice code { font-size: 11.5px; overflow-wrap: anywhere; }
		.cps-notice .cps-tried { margin: 6px 0; font-size: 11.5px; }
		.cps-notice .cps-tried summary { cursor: pointer; color: var(--text-dim, #8b90a0); }
		.cps-notice .cps-tried ul { margin: 4px 0 0; padding-left: 16px; max-height: 160px; overflow: auto; }
		.cps-notice .cps-tried li { color: var(--text-faint, #6b7080); overflow-wrap: anywhere; }
		.cps-empty { color: var(--text-faint, #6b7080); text-align: center; padding: 18px 0; font-size: 12.5px; }
		.cps-meta { color: var(--text-faint, #6b7080); font-size: 11.5px; overflow-wrap: anywhere; }
		.cps-meta code { font-size: 11.5px; }
		.cps-c-red { color: var(--red, #ef4444); }
		.cps-c-amber { color: var(--amber, #f59e0b); }
		.cps-c-dim { color: var(--text-dim, #8b90a0); }
	`;
	document.head.appendChild(style);
}

// ──────────────────────────────────────────────────────────── SVG 图表

const CHART_W = 760;
const CHART_H = 150;
const PAD_L = 42;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 22;

/** 线性映射：值 → y 像素（y 轴向下）。 */
function yOf(value, max) {
	const inner = CHART_H - PAD_T - PAD_B;
	const safeMax = max > 0 ? max : 1;
	return PAD_T + inner - (value / safeMax) * inner;
}

/** 空数据占位 SVG。 */
function emptyChart(text) {
	return `<div class="cps-empty">${esc(text)}</div>`;
}

/**
 * 请求数柱状图（失败/取消部分叠色）。
 * @param {Array<{hour: string, calls: number, bad: number}>} hours
 */
export function callsChart(hours, d) {
	if (!hours.length) return emptyChart(d.empty);
	const max = Math.max(...hours.map((h) => Number(h.calls) || 0), 1);
	const inner = CHART_W - PAD_L - PAD_R;
	const step = inner / hours.length;
	const barW = Math.max(2, Math.min(22, step * 0.72));
	const parts = [];
	// y 轴网格
	for (const ratio of [0, 0.5, 1]) {
		const y = yOf(max * ratio, max);
		parts.push(
			`<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${CHART_W - PAD_R}" y2="${y.toFixed(1)}" stroke="var(--border, #2a2e3a)" stroke-dasharray="3 4" stroke-width="1"/>`,
		);
		parts.push(
			`<text x="${PAD_L - 6}" y="${(y + 3.5).toFixed(1)}" font-size="10" fill="var(--text-faint, #6b7080)" text-anchor="end">${esc(fmtInt(max * ratio))}</text>`,
		);
	}
	hours.forEach((h, i) => {
		const calls = Number(h.calls) || 0;
		const bad = Math.min(Number(h.bad) || 0, calls);
		const x = PAD_L + i * step + (step - barW) / 2;
		const yTop = yOf(calls, max);
		const yBadTop = yOf(calls - bad, max);
		const bottom = yOf(0, max);
		parts.push(
			`<rect x="${x.toFixed(1)}" y="${yBadTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, bottom - yTop).toFixed(1)}" fill="var(--accent, #7c5cff)" opacity="0.85" rx="1"><title>${esc(`${fmtHour(h.hour)} · ${d.legendCalls} ${calls} / ${d.legendFailed} ${bad}`)}</title></rect>`,
		);
		if (bad > 0) {
			parts.push(
				`<rect x="${x.toFixed(1)}" y="${yBadTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, yBadTop - yTop).toFixed(1)}" fill="var(--red, #ef4444)" opacity="0.9" rx="1"/>`,
			);
		}
	});
	// x 轴首末标签
	const labelIdx = hours.length > 1 ? [0, hours.length - 1] : [0];
	for (const i of labelIdx) {
		const x = PAD_L + i * step + step / 2;
		parts.push(
			`<text x="${x.toFixed(1)}" y="${CHART_H - 6}" font-size="10" fill="var(--text-faint, #6b7080)" text-anchor="${i === 0 ? "start" : "end"}">${esc(fmtHour(hours[i].hour))}</text>`,
		);
	}
	return `<svg class="cps-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" role="img">${parts.join("")}</svg>`;
}

/**
 * TTFT 分位折线图（p50 / p90，毫秒）。
 * @param {Array<{hour: string, ttftP50: number|null, ttftP90: number|null}>} hours
 */
export function ttftChart(hours, d) {
	const usable = hours.filter((h) => Number(h.ttftP90) > 0 || Number(h.ttftP50) > 0);
	if (!usable.length) return emptyChart(d.noSamples);
	const max = Math.max(...usable.map((h) => Math.max(Number(h.ttftP90) || 0, Number(h.ttftP50) || 0)), 1);
	const inner = CHART_W - PAD_L - PAD_R;
	const step = hours.length > 1 ? inner / (hours.length - 1) : 0;
	const parts = [];
	for (const ratio of [0, 0.5, 1]) {
		const y = yOf(max * ratio, max);
		parts.push(
			`<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${CHART_W - PAD_R}" y2="${y.toFixed(1)}" stroke="var(--border, #2a2e3a)" stroke-dasharray="3 4" stroke-width="1"/>`,
		);
		parts.push(
			`<text x="${PAD_L - 6}" y="${(y + 3.5).toFixed(1)}" font-size="10" fill="var(--text-faint, #6b7080)" text-anchor="end">${esc(fmtAxisMs(max * ratio))}</text>`,
		);
	}
	const line = (key, color) => {
		const pts = [];
		hours.forEach((h, i) => {
			const v = Number(h[key]);
			if (!Number.isFinite(v) || v <= 0) return;
			pts.push(`${(PAD_L + i * step).toFixed(1)},${yOf(v, max).toFixed(1)}`);
		});
		if (!pts.length) return "";
		const dots = pts
			.map((p) => {
				const [x, y] = p.split(",");
				return `<circle cx="${x}" cy="${y}" r="2.2" fill="${color}"/>`;
			})
			.join("");
		return `<polyline fill="none" stroke="${color}" stroke-width="1.8" points="${pts.join(" ")}"/>${dots}`;
	};
	parts.push(line("ttftP90", "var(--amber, #f59e0b)"));
	parts.push(line("ttftP50", "var(--accent, #7c5cff)"));
	const labelIdx = hours.length > 1 ? [0, hours.length - 1] : [0];
	for (const i of labelIdx) {
		const x = hours.length > 1 ? PAD_L + i * step : PAD_L;
		parts.push(
			`<text x="${x.toFixed(1)}" y="${CHART_H - 6}" font-size="10" fill="var(--text-faint, #6b7080)" text-anchor="${i === 0 ? "start" : "end"}">${esc(fmtHour(hours[i].hour))}</text>`,
		);
	}
	return `<svg class="cps-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" role="img">${parts.join("")}</svg>`;
}

function legend(items) {
	return `<div class="cps-legend">${items
		.map((it) => `<span><i style="background:${it.color}"></i>${esc(it.label)}</span>`)
		.join("")}</div>`;
}

// ──────────────────────────────────────────────────────────── 渲染

function card(label, value, note, title, valueHtml) {
	return `<div class="cps-card"${title ? ` title="${esc(title)}"` : ""}><div class="k">${esc(label)}</div><div class="v">${valueHtml ?? esc(value)}</div>${
		note ? `<div class="n">${esc(note)}</div>` : ""
	}</div>`;
}

/**
 * 跨源价格分歧小标记（R7 / F-11）：金额后跟一个小标签，悬停说明分歧次数。
 * 没次数就什么都不画（绝不把「没分歧」也画成痕）。
 * @param {{ multiSourceCalls?: number, multiSourceRatio?: number|null }|null} cost
 */
export function multiMark(cost, d) {
	const n = Number(cost?.multiSourceCalls) || 0;
	if (!(n > 0)) return "";
	const title = `${d.multiSourceHint}${fmtInt(n)} ${d.multiSourceTimes}`;
	return ` <span class="cps-badge multi" title="${esc(title)}">${esc(d.multiSource)}</span>`;
}

/**
 * 未知价占比（容错版）：优先 `unknownRatio`，回落旧名 `unknownRate` 与自算；
 * 总请求数为 0 时返回 "--"（绝不显示 0%）。
 * @param {{ amount?: number|null, totalCalls?: number, pricedCalls?: number, unknownCalls?: number, unknownRatio?: number|null, unknownRate?: number|null }|null} cost
 */
export function costShare(cost) {
	if (!cost || typeof cost !== "object") return "--";
	const priced = Number(cost.pricedCalls) || 0;
	const unknown = Number(cost.unknownCalls) || 0;
	const total =
		Number.isFinite(Number(cost.totalCalls)) && cost.totalCalls !== undefined
			? Number(cost.totalCalls)
			: priced + unknown;
	if (!(total > 0)) return "--";
	const ratio =
		typeof cost.unknownRatio === "number"
			? cost.unknownRatio
			: typeof cost.unknownRate === "number"
				? cost.unknownRate
				: unknown / total;
	return fmtPct(ratio);
}

/** 悬停标题：估算口径 + 样本/未知价 + 跨源分歧（分组表格与指标卡共用）。 */
function costExtraTitle(cost, d) {
	const n = Number(cost?.multiSourceCalls) || 0;
	return n > 0 ? ` · ${d.multiSourceHint}${fmtInt(n)} ${d.multiSourceTimes}` : "";
}

function groupCostTitle(cost, d) {
	if (!cost) return d.priceNone;
	const unknown =
		cost.unknownCalls > 0
			? ` · ${d.excluded} ${fmtInt(cost.unknownCalls)} ${d.unknownTimes}（${costShare(cost)}）`
			: ` · ${d.allPriced}`;
	return `${d.estimate} · ${d.samples} ${cost.pricedCalls}/${cost.totalCalls}${unknown}${costExtraTitle(cost, d)}`;
}

function renderCards(summary, d) {
	const s = summary;
	const rate = s.calls > 0 ? fmtRate(s.successRate) : "--";
	const cost = s.cost;
	// R5：必须显示「未知价 N 次（占 X%）」；0 请求时占比是 null（显示 --，绝不显示 0%）
	const share = costShare(cost);
	const costNote = cost
		? cost.totalCalls > 0
			? `${d.unknownCount} ${fmtInt(cost.unknownCalls)} ${d.unknownTimes}（${share}）`
			: `${d.estimate} · --`
		: d.priceNone;
	const costTitle = cost
		? `${d.estimate}${cost.unknownCalls > 0 ? ` · ${d.excluded} ${fmtInt(cost.unknownCalls)} ${d.unknownTimes}（${share}）` : " · " + d.allPriced}${costExtraTitle(cost, d)}`
		: d.priceNone;
	return `<div class="cps-cards">
		${card(d.calls, fmtInt(s.calls), `${d.canceled}: ${s.failed} / ${s.canceled}`)}
		${card(d.successRate, rate, `${d.statusOk} ${fmtInt(s.success)}`)}
		${card(d.cost, fmtCost(cost?.amount ?? null, d), costNote, costTitle, `${esc(fmtCost(cost?.amount ?? null, d))}${multiMark(cost, d)}`)}
		${card(d.ttftP50, fmtMs(s.ttft.p50), `${d.samples} ${s.ttft.samples}`)}
		${card(d.ttftP90, fmtMs(s.ttft.p90), s.ttft.p99 ? `p99 ${fmtMs(s.ttft.p99)}` : "")}
		${card(d.latencyAvg, fmtMs(s.latencyAvg), s.latencyMax ? `max ${fmtMs(s.latencyMax)}` : "")}
		${card(d.tokPerSec, fmtTokps(s.tokPerSec), `${d.samples} ${s.tokPerSecSamples}`)}
		${card(d.tokensIn, fmtInt(s.tokens.input), "")}
		${card(d.tokensOut, fmtInt(s.tokens.output), s.tokens.reasoning ? `${d.kvReasoning} ${fmtInt(s.tokens.reasoning)}` : "")}
		${card(d.cacheRead, fmtInt(s.tokens.cacheRead), s.tokens.cacheCreation ? `${d.kvCacheCreate} ${fmtInt(s.tokens.cacheCreation)}` : "")}
	</div>`;
}

/** 按维度汇总表（模型 / 路由 / 执行器 / 接口 / 客户端），带估算成本与未知价占比。 */
function renderGroups(groups, d) {
	if (!groups?.length) return `<div class="cps-empty">${esc(d.empty)}</div>`;
	const rows = groups
		.map(
			(g) => `<tr>
			<td>${esc(g.key)}</td>
			<td class="mono">${esc(fmtInt(g.calls))}</td>
			<td class="mono ${g.bad > 0 ? "cps-c-red" : "cps-c-dim"}">${esc(g.calls > 0 ? fmtRate(g.failRate) : "--")}</td>
			<td class="mono">${esc(fmtMs(g.ttftP50))}</td>
			<td class="mono">${esc(fmtMs(g.ttftP90))}</td>
			<td class="mono">${esc(fmtTokps(g.tokPerSec))}</td>
			<td class="mono">${esc(fmtInt(g.tokens.total))}</td>
			<td class="mono" title="${esc(groupCostTitle(g.cost, d))}">${esc(fmtCost(g.cost?.amount ?? null, d))}${multiMark(g.cost, d)}</td>
		</tr>`,
		)
		.join("");
	return `<div class="cps-tbl-wrap"><table class="cps-tbl">
		<thead><tr>
			<th>${esc(d.thKey)}</th><th>${esc(d.thCalls)}</th><th>${esc(d.thFail)}</th>
			<th>${esc(d.thTtft)}</th><th>p90</th><th>${esc(d.thTokps)}</th>
			<th>${esc(d.thTokens)}</th><th>${esc(d.thCost)}</th>
		</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function statusBadge(ev, d) {
	if (ev.canceled) return `<span class="cps-badge cancel">${esc(d.statusCanceled)}</span>`;
	if (ev.failed) return `<span class="cps-badge bad">${esc(d.statusFailed)}</span>`;
	return `<span class="cps-badge ok">${esc(d.statusOk)}</span>`;
}

function renderEvents(events, d, expandedId) {
	if (!events?.length) return `<div class="cps-empty">${esc(d.empty)}</div>`;
	const rows = events
		.map((ev) => {
			const tokps =
				ev.ttftMs !== null && ev.latencyMs > ev.ttftMs && ev.outputTokens > 0
					? fmtTokps(ev.outputTokens / ((ev.latencyMs - ev.ttftMs) / 1000))
					: "--";
			const main = `<tr data-rid="${ev.id}">
				<td>${esc(fmtTime(ev.timestamp))}</td>
				<td>${esc(ev.client)}</td>
				<td>${esc(ev.model || "--")}</td>
				<td>${statusBadge(ev, d)}</td>
				<td class="mono">${esc(fmtMs(ev.ttftMs))}</td>
				<td class="mono">${esc(fmtMs(ev.latencyMs))}</td>
				<td class="mono">${esc(tokps)}</td>
				<td class="mono">${esc(fmtInt(ev.totalTokens || ev.inputTokens + ev.outputTokens))}</td>
				<td class="mono">${esc(fmtCost(ev.costAmount ?? null, d))}</td>
			</tr>`;
			if (ev.id !== expandedId) return main;
			const detail = `<tr class="cps-detail"><td colspan="9">
				${esc(d.thDetail)}: ${esc(d.kvIn)} <b>${esc(fmtInt(ev.inputTokens))}</b> ·
				${esc(d.kvOut)} <b>${esc(fmtInt(ev.outputTokens))}</b> ·
				${esc(d.kvReasoning)} <b>${esc(fmtInt(ev.reasoningTokens))}</b> ·
				${esc(d.kvCacheRead)} <b>${esc(fmtInt(ev.cacheReadTokens))}</b> ·
				${esc(d.kvTotal)} <b>${esc(fmtInt(ev.totalTokens))}</b> ·
				${esc(d.cost)} <b>${esc(fmtCost(ev.costAmount ?? null, d))}</b>
			</td></tr>`;
			return main + detail;
		})
		.join("");
	return `<div class="cps-tbl-wrap"><table class="cps-tbl">
		<thead><tr>
			<th>${esc(d.thTime)}</th><th>${esc(d.thClient)}</th><th>${esc(d.thModel)}</th>
			<th>${esc(d.thStatus)}</th><th>TTFT</th><th>${esc(d.thLatency)}</th>
			<th>${esc(d.thTokps)}</th><th>${esc(d.thTokens)}</th><th>${esc(d.thCost)}</th>
		</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderNotice(state, d) {
	const err = state.error;
	if (!err) return "";
	// 发现链给的结构化空态（db-not-found / bad-path）与其它错误分开标题
	const title = err.code === "db-not-found" || err.code === "bad-path" ? d.noDb : (err.code ?? "error");
	const detail = state.lang === "en" ? err.reasonEn : err.reason;
	const path = err.meta?.dbPath || err.path || "";
	const tried = Array.isArray(err.candidates) ? err.candidates.filter((p) => typeof p === "string" && p) : [];
	const hint = (state.lang === "en" ? err.hintEn : err.hint) || d.hintNoDb;
	return `<div class="cps-notice">
		<h3>${esc(String(title))}</h3>
		<p>${esc(String(detail || ""))}</p>
		${path ? `<p>${esc(d.hintPath)}: <code>${esc(path)}</code></p>` : ""}
		${
			tried.length
				? `<details class="cps-tried"><summary>${esc(d.hintTried)}（${tried.length}）</summary><ul>${tried
						.slice(0, 30)
						.map((p) => `<li><code>${esc(p)}</code></li>`)
						.join("")}</ul></details>`
				: ""
		}
		<p>${esc(String(hint || ""))}</p>
		<button class="cps-btn" data-act="refresh">${esc(d.retry)}</button>
	</div>`;
}

/** 价格快照状态行：来源 + 抓取时间 + 失败态（金额一律标注「估算」）。 */
function renderPriceLine(price, d) {
	if (!price) return "";
	const when = price.fetchedAt ? new Date(price.fetchedAt).toLocaleString() : "--";
	const parts = [];
	parts.push(`${d.price}: <code>${esc(when)}</code>`);
	if (price.available) {
		parts.push(`${esc(d.priceSrc)}: ${esc((price.sourceLabels ?? []).join(" / ") || "--")}`);
		parts.push(`${esc(d.estimate)}`);
		if (price.unknownRatio !== undefined && price.unknownRatio !== null) {
			parts.push(`${esc(d.unknownShare)} ${esc(fmtPct(price.unknownRatio))}`);
		}
	} else {
		parts.push(`<span class="cps-c-amber">${esc(d.priceNone)}</span>`);
	}
	if (price.failedSources?.length) {
		parts.push(`<span class="cps-c-amber">${esc(d.priceFailed)}: ${esc(price.failedSources.join(" / "))}</span>`);
	}
	if (price.refreshFailedAt) {
		parts.push(
			`<span class="cps-c-amber">${esc(d.priceFailed)} @ ${esc(new Date(price.refreshFailedAt).toLocaleString())}</span>`,
		);
	}
	if (price.overridesError) parts.push(`<span class="cps-c-amber">${esc(d.overrideErr)}</span>`);
	return `<div class="cps-meta">${parts.join(" · ")} <button class="cps-btn" data-act="prices">${esc(d.priceRefresh)}</button></div>`;
}

function segmented(values, current, act) {
	return `<div class="cps-seg">${values
		.map(
			(v) =>
				`<button data-act="${act}" data-value="${esc(v.value)}" class="${v.value === current ? "on" : ""}">${esc(v.label)}</button>`,
		)
		.join("")}</div>`;
}

const GROUP_KEYS = ["model", "provider", "executor", "endpoint", "client"];

function renderDashboard(state, d) {
	const segWin = segmented(
		[
			{ value: "today", label: d.win.today },
			{ value: "7d", label: d.win["7d"] },
			{ value: "30d", label: d.win["30d"] },
		],
		state.window,
		"window",
	);
	const segClient = segmented(
		[
			{ value: "all", label: d.clientAll },
			{ value: "pi", label: d.clientPi },
		],
		state.client,
		"client",
	);
	const segGroup = segmented(
		GROUP_KEYS.map((key) => ({ value: key, label: d.dim[key] })),
		state.groupBy,
		"groupBy",
	);
	const meta = state.summary?.meta;
	const price = meta?.price ?? null;
	const metaLine = meta
		? `${d.hintPath}: <code>${esc(meta.dbPath || "--")}</code> · ${esc(new Date(meta.generatedAt).toLocaleTimeString())}${
				meta.cached ? ` · ${esc(d.metaSaved)}` : ""
			}`
		: "";
	const body = state.summary?.ok
		? `${renderCards(state.summary.summary, d)}
			<div class="cps-grid2">
				<div class="cps-panel">
					<h3>${esc(d.chartCalls)}</h3>
					${callsChart(state.hours ?? [], d)}
					${legend([
						{ color: "var(--accent, #7c5cff)", label: d.legendCalls },
						{ color: "var(--red, #ef4444)", label: d.legendFailed },
					])}
				</div>
				<div class="cps-panel">
					<h3>${esc(d.chartTtft)}</h3>
					${ttftChart(state.hours ?? [], d)}
					${legend([
						{ color: "var(--accent, #7c5cff)", label: d.legendP50 },
						{ color: "var(--amber, #f59e0b)", label: d.legendP90 },
					])}
				</div>
			</div>
			<div class="cps-panel">
				<h3>${esc(d.routeTable)} · ${esc(d.groupBy)}：${esc(d.dim[state.groupBy] ?? state.groupBy)}</h3>
				${renderGroups(state.summary.groups, d)}
			</div>
			<div class="cps-panel">
				<h3>${esc(d.eventTable)}</h3>
				${renderEvents(state.events ?? [], d, state.expandedId)}
			</div>`
		: `${renderNotice(state, d)}${state.loading ? `<div class="cps-empty">${esc(d.loading)}</div>` : ""}`;
	return `<div class="cps-head">
			<span class="cps-title">📊 ${esc(d.title)}</span>
			<span class="cps-sub">${esc(d.subtitle)}</span>
			<span class="cps-spacer"></span>
			${segWin}${segClient}${segGroup}
			<button class="cps-btn" data-act="refresh" ${state.loading ? "disabled" : ""}>${esc(state.loading ? d.loading : d.refresh)}</button>
		</div>
		${metaLine ? `<div class="cps-meta">${metaLine}</div>` : ""}
		${renderPriceLine(price, d)}
		${body}`;
}

// ──────────────────────────────────────────────────────────── 运行时

const runtime = {
	container: null,
	root: null,
	timer: null,
	viewObserver: null,
	inflight: null,
	langObserver: null,
	offLocale: null,
	lang: "zh",
	state: {
		window: "today",
		client: "all",
		groupBy: "model",
		summary: null,
		hours: null,
		events: null,
		error: null,
		loading: false,
		expandedId: null,
	},
};

function paint() {
	if (!runtime.root) return;
	const d = dict(runtime.state.lang);
	runtime.root.innerHTML = renderDashboard(runtime.state, d);
}

/** 拉取三路数据（并行 + 可中断）；失败只写 state.error，绝不抛错。 */
async function load() {
	if (runtime.inflight) {
		try {
			runtime.inflight.abort();
		} catch {
			/* ignore */
		}
	}
	const controller = new AbortController();
	runtime.inflight = controller;
	runtime.state.loading = true;
	paint();
	const qs =
		`window=${encodeURIComponent(runtime.state.window)}` +
		`&client=${encodeURIComponent(runtime.state.client)}` +
		`&groupBy=${encodeURIComponent(runtime.state.groupBy)}`;
	const base = apiBase();
	const get = async (path) => {
		const res = await fetch(`${base}${path}?${qs}`, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json();
	};
	try {
		const [summary, series, events] = await Promise.all([get("/api/summary"), get("/api/series"), get("/api/events")]);
		if (controller.signal.aborted) return;
		runtime.state.summary = summary;
		runtime.state.hours = series?.ok ? series.hours : null;
		runtime.state.events = events?.ok ? events.events : null;
		runtime.state.error = summary?.ok ? null : summary;
	} catch (err) {
		if (controller.signal.aborted) return;
		// 网络/路由错误也走空态，不刷 console 噪声
		runtime.state.error = {
			code: "request-failed",
			reason: `无法读取统计接口：${err?.message ?? err}`,
			reasonEn: `Cannot reach the stats API: ${err?.message ?? err}`,
			meta: runtime.state.summary?.meta,
		};
	} finally {
		if (!controller.signal.aborted) {
			runtime.state.loading = false;
			runtime.inflight = null;
			paint();
		}
	}
}

function onRootClick(event) {
	const target = event.target instanceof Element ? event.target : null;
	if (!target) return;
	const actNode = target.closest("[data-act]");
	if (actNode) {
		const act = actNode.getAttribute("data-act");
		if (act === "refresh") {
			void load();
			return;
		}
		if (act === "prices") {
			void refreshPrices();
			return;
		}
		if (act === "window" || act === "client" || act === "groupBy") {
			const value = actNode.getAttribute("data-value") ?? "";
			if (!value) return;
			if (runtime.state[act] === value) return;
			runtime.state[act] = value;
			void load();
			return;
		}
	}
	const row = target.closest("tr[data-rid]");
	if (row) {
		const id = Number(row.getAttribute("data-rid"));
		runtime.state.expandedId = runtime.state.expandedId === id ? null : id;
		paint();
	}
}

/** 手动刷新价目表（POST；有副作用，不走 GET）。失败只置错误文案，不刷 console。 */
async function refreshPrices() {
	try {
		const res = await fetch(`${apiBase()}/api/prices/refresh`, {
			method: "POST",
			headers: { Accept: "application/json" },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch {
		/* 静默：状态行会显示「刷新失败」 */
	}
	void load();
}

function startTimer() {
	stopTimer();
	runtime.timer = setInterval(() => {
		// 视图切走时宿主只 display:none（不卸载）：没必要为了看不见的看板打请求
		if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
		if (!runtime.container || !runtime.container.isConnected) return;
		if (!runtime.root || runtime.root.offsetParent === null) {
			// offsetParent 变 null = 宿主已把视图隐藏：彻底停掉定时器，靠视图观察器恢复
			if (!runtime.viewObserver) stopTimer();
			return;
		}
		void load();
	}, REFRESH_MS);
}

/** 视图可见性观察器：宿主切走视图时停定时器，切回时补一次刷新并恢复轮询。
 *  没有 IntersectionObserver（极老浏览器）时静默不做，回退到定时器内的 offsetParent 早退。 */
function ensureViewObserver() {
	if (runtime.viewObserver || typeof IntersectionObserver === "undefined") return;
	const target = runtime.root;
	if (!target) return;
	try {
		runtime.viewObserver = new IntersectionObserver((entries) => {
			const visible = entries.some((e) => e.isIntersecting);
			if (visible) {
				if (!runtime.timer) {
					startTimer();
					void load();
				}
			} else {
				stopTimer();
			}
		});
		runtime.viewObserver.observe(target);
	} catch {
		/* 观察器不可用：保持原有定时器行为 */
		runtime.viewObserver = null;
	}
}

function stopViewObserver() {
	try {
		runtime.viewObserver?.disconnect();
	} catch {
		/* ignore */
	}
	runtime.viewObserver = null;
}

function stopTimer() {
	if (runtime.timer) {
		clearInterval(runtime.timer);
		runtime.timer = null;
	}
}

function applyLang() {
	const next = detectLang();
	if (next === runtime.state.lang && runtime.root?.childElementCount) {
		// 语言没变且已渲染：不重画（避免滚动位置丢失）
		if (runtime.state.summary || runtime.state.error) return;
	}
	runtime.state.lang = next;
	paint();
}

function mount(container) {
	if (!container) return () => {};
	ensureStyles();
	runtime.container = container;
	runtime.state.lang = detectLang();
	runtime.root = document.createElement("div");
	runtime.root.className = "cps-root";
	runtime.root.addEventListener("click", onRootClick);
	container.appendChild(runtime.root);
	paint();
	void load();
	startTimer();
	ensureViewObserver();
	// 跟随宿主语言切换（宿主会改 documentElement.lang）
	try {
		const host = window.__piWebUiHost;
		if (host && typeof host.onLocale === "function") {
			runtime.offLocale = host.onLocale(() => applyLang());
		}
		runtime.langObserver = new MutationObserver(() => applyLang());
		runtime.langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
	} catch {
		/* 没有 MutationObserver / 宿主不提供 onLocale：不跟随，纯静态文案 */
	}
	return () => {
		stopTimer();
		stopViewObserver();
		try {
			runtime.inflight?.abort();
		} catch {
			/* ignore */
		}
		runtime.inflight = null;
		try {
			runtime.offLocale?.();
		} catch {
			/* ignore */
		}
		runtime.offLocale = null;
		try {
			runtime.langObserver?.disconnect();
		} catch {
			/* ignore */
		}
		runtime.langObserver = null;
		try {
			runtime.root?.removeEventListener("click", onRootClick);
			runtime.root?.remove();
		} catch {
			/* ignore */
		}
		runtime.root = null;
		runtime.container = null;
	};
}

/** 底栏徽标点击 → 切到本插件视图（宿主动作，不改宿主 DOM）。 */
function openView() {
	try {
		window.__piWebUiHost?.setView?.(VIEW_NAME);
	} catch {
		/* 宿主没提供 setView（旧版本）：静默失败，不抛错 */
	}
}

function register() {
	try {
		const host = window.__piWebUiHost;
		if (host && typeof host.onUiAction === "function") {
			host.onUiAction(ACTION_OPEN, () => openView());
		}
	} catch {
		/* ignore */
	}
}

if (typeof window !== "undefined") {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", register, { once: true });
	} else {
		register();
	}
}

export default {
	mount,
};
