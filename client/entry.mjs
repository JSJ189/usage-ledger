/**
 * usage-ledger 2.0 客户端看板
 *
 * 职责：
 *  1. 底栏徽标（bottombar 槽位）点击 → 切到本插件视图（走宿主 setView，不碰宿主 DOM）；
 *  2. 视图内渲染看板：指标卡（调用次数/成功率/失败+未收全/TTFT p50·p90·p99/平均延迟/
 *     平均 tok·s⁻¹/token 合计/真实成本）、按模型汇总表（点行 = 只看该模型）、
 *     按小时或按天趋势双图、记录明细表（分页 + 状态筛选 + 点开去重明细）；
 *  3. 数据源全是 pi-web-ui 自己：实时运行事件（TTFT）+ 会话 JSONL（token/真实成本/耗时）。
 *     不读任何代理账本、不抓价目表、不估算成本。
 *  4. 图表手写 SVG，零外部 CDN、零新增依赖；样式全在插件自己的 <style> 里，前缀 cps-。
 *
 * 数字口径（与 lib/metrics.mjs / README 一致）：
 *  - `TTFT` = turn_start → 第一个流式包；**只能实时采集**，回填的历史条目没有 TTFT，
 *    所以看板必须显示 TTFT 覆盖率，不能把「样本少」伪装成「很快」；
 *  - `tok/s` = outputTokens / (durationMs/1000)，只有两者都 > 0 的调用参与均值；
 *  - 失败 = `status: "error"`；`incomplete` = 事件没收到 message 或会话没有 usage。
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
const PAGE_SIZE = 20;

// ──────────────────────────────────────────────────────────── 文案

const ZH = {
	title: "用量账本",
	subtitle: "pi-web-ui 自己的每次模型调用（TTFT 只实时采集）",
	win: { today: "今日", "7d": "7 天", "30d": "30 天", all: "全部" },
	bucket: { hour: "按小时", day: "按天" },
	refresh: "刷新",
	backfill: "回填",
	loading: "加载中…",
	calls: "调用次数",
	successRate: "成功率",
	failedIncomplete: "失败 / 未收全",
	ttftP50: "TTFT p50",
	ttftP90: "TTFT p90",
	ttftP99: "TTFT p99",
	latencyAvg: "平均延迟",
	tokPerSec: "平均 tok·s⁻¹",
	tokensTotal: "token 合计",
	cost: "真实成本",
	costNote: "SDK usage.cost.total",
	tokensIn: "输入",
	tokensOut: "输出",
	cacheRead: "缓存读",
	cacheWrite: "缓存写",
	reasoning: "思考",
	samples: "样本",
	ttftCoverage: "TTFT 覆盖",
	modelsCount: "模型",
	chartCalls: "按时间 · 调用次数",
	chartTtft: "按时间 · TTFT 分位",
	modelsTable: "按模型汇总",
	recordsTable: "记录明细",
	thModel: "模型",
	thCalls: "调用",
	thSuccess: "成功率",
	thTtftP50: "TTFT p50",
	thTtftP90: "TTFT p90",
	thLatency: "平均延迟",
	thTokps: "tok·s⁻¹",
	thTokens: "token 合计",
	thCost: "成本",
	thShare: "占比",
	thTime: "时间",
	thProvider: "provider",
	thThinking: "思考",
	thCache: "缓存读/写",
	thTtft: "首字",
	thDuration: "耗时",
	thStatus: "状态",
	thSource: "来源",
	thDetail: "拆分明细",
	statusOk: "成功",
	statusFailed: "失败",
	statusIncomplete: "未收全",
	statusAll: "全部",
	sourceLive: "实时",
	sourceBackfill: "回填",
	sourceBoth: "实时+回填",
	legendCalls: "调用",
	legendFailed: "失败",
	legendP50: "p50",
	legendP90: "p90",
	noSamples: "该窗口没有实时 TTFT 样本",
	empty: "还没有记录。跑一次对话，或授予 sessions 目录读取以导入历史。",
	emptyWindow: "该窗口没有记录，换个时间窗试试。",
	ttftNote:
		"TTFT 只能实时采集：历史回填的条目没有首字时间（不影响 token / 真实成本 / 延迟）。覆盖率 = 有 TTFT 的调用 / 全部调用。",
	liveOnly: "仅实时：没有 fs:read，token 与成本显示 --",
	grant: "授权并导入历史",
	grantHint: "读取 ~/.pi/agent/sessions（只读）以导入历史用量，插件绝不写那里。",
	backfillOk: "回填完成",
	backfillFail: "回填失败",
	noticeTitle: "读不到用量",
	retry: "重试",
	modelFilter: "只看",
	clearFilter: "看全部模型",
	page: (a, b) => `第 ${a} / ${b} 页`,
	prev: "上一页",
	next: "下一页",
	total: "共",
	rows: "条",
	ledger: "账本",
	sessionsRoot: "会话目录",
	lastBackfill: "上次回填",
	never: "未跑过",
	fileCoverage: "已导入",
	sessionFiles: "个会话文件",
	importing: "导入中…",
	stopImport: "停止导入",
	files: "文件",
	stopped: "停止原因",
	unknown: "(未知)",
	trace: "会话",
	kvIn: "输入",
	kvOut: "输出",
	kvReasoning: "推理",
	kvCacheRead: "缓存读",
	kvCacheWrite: "缓存写",
	kvTotal: "合计",
	id: "记录 id",
};

const EN = {
	title: "Usage Ledger",
	subtitle: "pi-web-ui's own model calls (TTFT is live-only)",
	win: { today: "Today", "7d": "7 days", "30d": "30 days", all: "All" },
	bucket: { hour: "Hourly", day: "Daily" },
	refresh: "Refresh",
	backfill: "Backfill",
	loading: "Loading…",
	calls: "Calls",
	successRate: "Success rate",
	failedIncomplete: "Failed / incomplete",
	ttftP50: "TTFT p50",
	ttftP90: "TTFT p90",
	ttftP99: "TTFT p99",
	latencyAvg: "Avg latency",
	tokPerSec: "Avg tok·s⁻¹",
	tokensTotal: "Tokens",
	cost: "Real cost",
	costNote: "SDK usage.cost.total",
	tokensIn: "input",
	tokensOut: "output",
	cacheRead: "cache read",
	cacheWrite: "cache write",
	reasoning: "reasoning",
	samples: "samples",
	ttftCoverage: "TTFT coverage",
	modelsCount: "models",
	chartCalls: "Calls over time",
	chartTtft: "TTFT percentiles over time",
	modelsTable: "By model",
	recordsTable: "Call records",
	thModel: "Model",
	thCalls: "Calls",
	thSuccess: "Success",
	thTtftP50: "TTFT p50",
	thTtftP90: "TTFT p90",
	thLatency: "Avg latency",
	thTokps: "tok·s⁻¹",
	thTokens: "Tokens",
	thCost: "Cost",
	thShare: "Share",
	thTime: "Time",
	thProvider: "provider",
	thThinking: "thinking",
	thCache: "cache r/w",
	thTtft: "first token",
	thDuration: "duration",
	thStatus: "Status",
	thSource: "Source",
	thDetail: "Breakdown",
	statusOk: "ok",
	statusFailed: "failed",
	statusIncomplete: "incomplete",
	statusAll: "all",
	sourceLive: "live",
	sourceBackfill: "backfill",
	sourceBoth: "live+backfill",
	legendCalls: "calls",
	legendFailed: "failed",
	legendP50: "p50",
	legendP90: "p90",
	noSamples: "No live TTFT samples in this window",
	empty: "No records yet. Run a conversation, or authorize the sessions directory to import history.",
	emptyWindow: "No records in this window; try another range.",
	ttftNote:
		"TTFT can only be captured live: backfilled records have no first-token time (tokens, cost and latency are unaffected). Coverage = calls with TTFT / all calls.",
	liveOnly: "Live only: no fs:read, tokens and cost show --",
	grant: "Authorize & import history",
	grantHint: "Reads ~/.pi/agent/sessions (read-only) to import past usage; the plugin never writes there.",
	backfillOk: "Backfill done",
	backfillFail: "Backfill failed",
	noticeTitle: "Cannot read usage",
	retry: "Retry",
	modelFilter: "Only",
	clearFilter: "All models",
	page: (a, b) => `Page ${a} / ${b}`,
	prev: "Prev",
	next: "Next",
	total: "Total",
	rows: "rows",
	ledger: "Ledger",
	sessionsRoot: "Sessions",
	lastBackfill: "Last backfill",
	never: "never",
	fileCoverage: "Imported",
	sessionFiles: "session files",
	importing: "importing…",
	stopImport: "Stop importing",
	files: "files",
	stopped: "stop reason",
	unknown: "(unknown)",
	trace: "session",
	kvIn: "input",
	kvOut: "output",
	kvReasoning: "reasoning",
	kvCacheRead: "cache read",
	kvCacheWrite: "cache write",
	kvTotal: "total",
	id: "record id",
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
	if (x === null || x === undefined) return "--";
	const v = Number(x);
	if (!Number.isFinite(v)) return "--";
	return `${(v * 100).toFixed(1)}%`;
}

export function fmtShare(x) {
	const v = Number(x);
	if (x === null || x === undefined || !Number.isFinite(v)) return "--";
	return `${(v * 100).toFixed(v > 0 && v < 0.01 ? 2 : 1)}%`;
}

function fmtTokps(x) {
	if (x === null || x === undefined) return "--";
	const v = Number(x);
	if (!Number.isFinite(v) || v < 0) return "--";
	return v.toFixed(v < 10 ? 2 : 0);
}

/** 真实成本（USD）。没有成本字段 → `--`（不是 $0）。 */
export function fmtCost(amount) {
	const v = Number(amount);
	if (amount === null || amount === undefined || !Number.isFinite(v)) return "--";
	return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function fmtHour(hour, _lang) {
	// 服务端下发的是本地时间键：小时 `YYYY-MM-DDTHH:00:00` 或天 `YYYY-MM-DD`
	const s = String(hour ?? "");
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
	if (m) return `${m[2]}-${m[3]} ${m[4]}:00`;
	const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (d) return `${d[2]}-${d[3]}`;
	return s;
}

function fmtTime(ts) {
	const v = Number(ts);
	if (!Number.isFinite(v) || v <= 0) return "--";
	const d = new Date(v);
	const p2 = (n) => String(n).padStart(2, "0");
	return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
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
		.cps-btn.primary { border-color: var(--accent, #7c5cff); color: var(--accent, #7c5cff); }
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
		.cps-hint { color: var(--text-faint, #6b7080); font-size: 11.5px; margin-top: 6px; overflow-wrap: anywhere; }
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
		.cps-tbl tbody tr[data-model], .cps-tbl tbody tr[data-rid] { cursor: pointer; }
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
		.cps-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.cps-chip {
			display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px;
			border: 1px solid color-mix(in srgb, var(--accent, #7c5cff) 45%, transparent);
			color: var(--accent, #7c5cff); font-size: 11.5px; cursor: pointer; background: transparent; font-family: inherit;
		}
		.cps-pager { display: flex; align-items: center; gap: 8px; justify-content: flex-end; font-size: 11.5px; color: var(--text-faint, #6b7080); }
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
		const good = calls - bad;
		const x = PAD_L + i * step + (step - barW) / 2;
		const bottom = yOf(0, max);
		// 整条柱（成功 + 失败）从 0 线往上长：y 取「成功部分」的顶，高度到 0 线为止
		const yGoodTop = yOf(good, max);
		parts.push(
			`<rect x="${x.toFixed(1)}" y="${yGoodTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, bottom - yGoodTop).toFixed(1)}" fill="var(--accent, #7c5cff)" opacity="0.85" rx="1"><title>${esc(`${fmtHour(h.hour)} · ${d.legendCalls} ${calls} / ${d.legendFailed} ${bad}`)}</title></rect>`,
		);
		if (bad > 0) {
			// 失败/取消段叠在柱顶：从柱子顶部往下 bad 那么多，永不越过 0 线
			const yTop = yOf(calls, max);
			parts.push(
				`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, yGoodTop - yTop).toFixed(1)}" fill="var(--red, #ef4444)" opacity="0.9" rx="1"><title>${esc(`${fmtHour(h.hour)} · ${d.legendFailed} ${bad}`)}</title></rect>`,
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

/** 指标卡组。`s` = /api/summary 的 summary；`d` = 文案。 */
export function renderCards(s, d) {
	if (!s) return "";
	const calls = Number(s.calls) || 0;
	const ttft = s.ttft ?? { samples: 0, p50: null, p90: null, p99: null, coverage: null };
	const tokens = s.tokens ?? {};
	const cost = s.cost ?? { amount: null, unpricedCalls: 0, totalCalls: 0 };
	const tokNote = `${s.tokPerSecSamples ?? 0} ${d.samples}`;
	const tokenNote = `${d.tokensIn} ${fmtInt(tokens.input)} · ${d.tokensOut} ${fmtInt(tokens.output)} · ${d.cacheRead} ${fmtInt(tokens.cacheRead)} · ${d.cacheWrite} ${fmtInt(tokens.cacheWrite)} · ${d.reasoning} ${fmtInt(tokens.reasoning)}`;
	const costNote =
		cost.amount === null
			? `${d.costNote} · ${d.samples} 0`
			: `${d.costNote}${cost.unpricedCalls ? ` · -- ${cost.unpricedCalls}` : ""}`;
	return `<div class="cps-cards">
		${card(d.calls, fmtInt(calls), `${s.models ?? 0} ${d.modelsCount}`, `调用次数：${calls}`)}
		${card(d.successRate, fmtRate(s.successRate), `${d.statusOk} ${s.ok ?? 0}`, `成功率 = 成功 / 全部调用（${s.ok ?? 0}/${calls}）`)}
		${card(
			d.failedIncomplete,
			`${fmtInt(s.failed ?? 0)} / ${fmtInt(s.incomplete ?? 0)}`,
			`${d.statusFailed} / ${d.statusIncomplete}`,
			`失败（status=error）与未收全（缺 message 或 usage）分开计数`,
		)}
		${card(d.ttftP50, ttft.p50 === null ? "--" : fmtMs(ttft.p50), `${d.samples} ${ttft.samples ?? 0}`, `首字时间 p50（只统计实时采集的调用）`)}
		${card(d.ttftP90, ttft.p90 === null ? "--" : fmtMs(ttft.p90), ttft.coverage === null ? "" : `${d.ttftCoverage} ${fmtRate(ttft.coverage)}`, `首字时间 p90`)}
		${card(d.ttftP99, ttft.p99 === null ? "--" : fmtMs(ttft.p99), `${d.samples} ${ttft.samples ?? 0}`, `首字时间 p99`)}
		${card(d.latencyAvg, s.latencyAvg === null ? "--" : fmtMs(s.latencyAvg), `${d.samples} ${s.latencySamples ?? 0}`, `单次调用耗时均值（会话 durationMs / turn 时长）`)}
		${card(d.tokPerSec, fmtTokps(s.tokPerSec), tokNote, `outputTokens / (durationMs/1000) 的均值`)}
		${card(d.tokensTotal, fmtInt(tokens.total), tokenNote, `token 合计：${tokenNote}`)}
		${card(d.cost, fmtCost(cost.amount), costNote, `真实成本：SDK usage.cost.total 求和`)}
	</div>`;
}

/** 按模型汇总表（点行 → 只看该模型）。 */
function renderModels(rows, d) {
	if (!Array.isArray(rows) || !rows.length) return `<div class="cps-empty">${esc(d.emptyWindow)}</div>`;
	const body = rows
		.map((row) => {
			const ttft = row.ttft ?? {};
			return `<tr data-model="${esc(row.model)}" title="${esc(`${d.modelFilter} ${row.model}`)}">
				<td>${esc(row.model)}</td>
				<td class="mono">${esc(fmtInt(row.calls))}</td>
				<td class="mono">${esc(fmtRate(row.successRate))}</td>
				<td class="mono">${esc(ttft.p50 === null || ttft.p50 === undefined ? "--" : fmtMs(ttft.p50))}</td>
				<td class="mono">${esc(ttft.p90 === null || ttft.p90 === undefined ? "--" : fmtMs(ttft.p90))}</td>
				<td class="mono">${esc(row.latencyAvg === null || row.latencyAvg === undefined ? "--" : fmtMs(row.latencyAvg))}</td>
				<td class="mono">${esc(fmtTokps(row.tokPerSec))}</td>
				<td class="mono" title="${esc(`${d.tokensIn} ${row.tokens?.input ?? 0} · ${d.tokensOut} ${row.tokens?.output ?? 0} · ${d.cacheRead} ${row.tokens?.cacheRead ?? 0} · ${d.cacheWrite} ${row.tokens?.cacheWrite ?? 0} · ${d.reasoning} ${row.tokens?.reasoning ?? 0}`)}">${esc(fmtInt(row.tokens?.total ?? 0))}</td>
				<td class="mono">${esc(fmtCost(row.cost?.amount ?? null))}</td>
				<td class="mono">${esc(fmtShare(row.costShare ?? row.callShare ?? null))}</td>
			</tr>`;
		})
		.join("");
	return `<div class="cps-tbl-wrap"><table class="cps-tbl cps-models">
		<thead><tr>
			<th>${esc(d.thModel)}</th><th>${esc(d.thCalls)}</th><th>${esc(d.thSuccess)}</th>
			<th>${esc(d.thTtftP50)}</th><th>${esc(d.thTtftP90)}</th><th>${esc(d.thLatency)}</th>
			<th>${esc(d.thTokps)}</th><th>${esc(d.thTokens)}</th><th>${esc(d.thCost)}</th><th>${esc(d.thShare)}</th>
		</tr></thead>
		<tbody>${body}</tbody>
	</table></div>`;
}

function statusBadge(status, d) {
	if (status === "error") return `<span class="cps-badge bad">${esc(d.statusFailed)}</span>`;
	if (status === "incomplete") return `<span class="cps-badge cancel">${esc(d.statusIncomplete)}</span>`;
	return `<span class="cps-badge ok">${esc(d.statusOk)}</span>`;
}

function sourceLabel(record, d) {
	const sources = Array.isArray(record.sources) && record.sources.length ? record.sources : [record.source];
	if (sources.length > 1) return d.sourceBoth;
	return sources[0] === "live" ? d.sourceLive : d.sourceBackfill;
}

/** 记录明细表（分页 + 点开明细）。 */
function renderRecords(state, d) {
	const list = Array.isArray(state.records) ? state.records : [];
	if (!list.length) return `<div class="cps-empty">${esc(state.summary?.calls ? d.emptyWindow : d.empty)}</div>`;
	const rows = list
		.map((r) => {
			const open = state.expandedId === r.id;
			const rid = esc(r.id);
			const tokps = Number(r.outputTokens) > 0 && Number(r.durationMs) > 0 ? Number(r.outputTokens) / (Number(r.durationMs) / 1000) : null;
			const main = `<tr data-rid="${rid}">
				<td class="mono">${esc(fmtTime(r.ts))}</td>
				<td>${esc(r.model ?? d.unknown)}</td>
				<td class="cps-c-dim">${esc(r.provider ?? "--")}</td>
				<td class="cps-c-dim">${esc(r.thinkingLevel ?? "--")}</td>
				<td class="mono">${esc(fmtInt(r.totalTokens ?? 0))}</td>
				<td class="mono cps-c-dim">${esc(`${fmtInt(r.cacheReadTokens ?? 0)}/${fmtInt(r.cacheWriteTokens ?? 0)}`)}</td>
				<td class="mono">${esc(r.ttftMs === null || r.ttftMs === undefined ? "--" : fmtMs(r.ttftMs))}</td>
				<td class="mono">${esc(r.durationMs === null || r.durationMs === undefined ? "--" : fmtMs(r.durationMs))}</td>
				<td class="mono">${esc(fmtTokps(tokps))}</td>
				<td class="mono">${esc(fmtCost(r.costUsd))}</td>
				<td>${statusBadge(r.status, d)}</td>
			</tr>`;
			if (!open) return main;
			const detail = `<tr class="cps-detail"><td colspan="11">
				${esc(d.thDetail)}：<b>${esc(d.kvIn)}</b> ${esc(fmtInt(r.inputTokens ?? 0))} ·
				<b>${esc(d.kvOut)}</b> ${esc(fmtInt(r.outputTokens ?? 0))} ·
				<b>${esc(d.kvCacheRead)}</b> ${esc(fmtInt(r.cacheReadTokens ?? 0))} ·
				<b>${esc(d.kvCacheWrite)}</b> ${esc(fmtInt(r.cacheWriteTokens ?? 0))} ·
				<b>${esc(d.kvReasoning)}</b> ${esc(fmtInt(r.reasoningTokens ?? 0))} ·
				<b>${esc(d.kvTotal)}</b> ${esc(fmtInt(r.totalTokens ?? 0))}<br/>
				${esc(d.thSource)}：${esc(sourceLabel(r, d))} ·
				${esc(d.stopped)}：${esc(r.stopReason ?? "--")} ·
				${esc(d.id)}：<code>${esc(r.id)}</code>
			</td></tr>`;
			return main + detail;
		})
		.join("");
	const pages = Math.max(1, Number(state.pages) || 1);
	const page = Math.min(pages, Math.max(1, Number(state.page) || 1));
	const pager = `<div class="cps-pager">
		<span>${esc(d.total)} ${esc(fmtInt(state.total ?? list.length))} ${esc(d.rows)} · ${esc(d.page(page, pages))}</span>
		<button class="cps-btn" data-act="page" data-value="${page - 1}" ${page <= 1 ? "disabled" : ""}>${esc(d.prev)}</button>
		<button class="cps-btn" data-act="page" data-value="${page + 1}" ${page >= pages ? "disabled" : ""}>${esc(d.next)}</button>
	</div>`;
	return `<div class="cps-tbl-wrap"><table class="cps-tbl cps-records">
		<thead><tr>
			<th>${esc(d.thTime)}</th><th>${esc(d.thModel)}</th><th>${esc(d.thProvider)}</th><th>${esc(d.thThinking)}</th>
			<th>${esc(d.thTokens)}</th><th>${esc(d.thCache)}</th><th>${esc(d.thTtft)}</th><th>${esc(d.thDuration)}</th>
			<th>${esc(d.thTokps)}</th><th>${esc(d.thCost)}</th><th>${esc(d.thStatus)}</th>
		</tr></thead>
		<tbody>${rows}</tbody>
	</table></div>${pager}`;
}

/** 顶部降级/授权提示（只在需要时出现）。 */
function renderNotice(state, d) {
	const meta = state.meta ?? {};
	const grant = meta.grant ?? null;
	const needsGrant = Boolean(grant?.required);
	const error = state.error;
	if (!error && !needsGrant) return "";
	const reason = error?.reason ?? grant?.reason ?? d.liveOnly;
	const reasonEn = error?.reasonEn ?? grant?.reasonEn ?? "";
	const hint = error?.hint ?? grant?.hint ?? "";
	const lines = [
		`${esc(reason)}${reasonEn && reasonEn !== reason ? ` · ${esc(reasonEn)}` : ""}`,
		hint ? `<p><code>${esc(hint)}</code></p>` : "",
	];
	const tried = Array.isArray(error?.candidates) && error.candidates.length
		? `<details class="cps-tried"><summary>${esc(d.sessionsRoot)}</summary><ul>${error.candidates
				.map((c) => `<li>${esc(c)}</li>`)
				.join("")}</ul></details>`
		: "";
	return `<div class="cps-notice">
		<h3>${esc(d.noticeTitle)}</h3>
		<p>${lines.join("")}</p>
		${needsGrant ? `<p>${esc(d.grantHint)}</p>` : ""}
		${tried}
		<div class="cps-filters">
			<button class="cps-btn" data-act="refresh">${esc(d.retry)}</button>
			${needsGrant ? `<button class="cps-btn primary" data-act="grant">${esc(d.grant)}</button>` : ""}
		</div>
	</div>`;
}

function segmented(values, current, act, labels) {
	return `<span class="cps-seg">${values
		.map(
			(v) =>
				`<button data-act="${esc(act)}" data-value="${esc(v)}" class="${current === v ? "on" : ""}">${esc(labels[v] ?? v)}</button>`,
		)
		.join("")}</span>`;
}

/** 顶栏状态行：账本规模 / 会话目录 / 上次回填 / 模式。 */
function renderMetaLine(state, d) {
	const meta = state.meta ?? {};
	const ledger = meta.ledger ?? {};
	const backfill = meta.backfill ?? null;
	const coverage = meta.coverage ?? backfill?.coverage ?? null;
	const last = backfill?.finishedAt ? fmtTime(backfill.finishedAt) : d.never;
	const importing = Boolean(meta.importing ?? backfill?.truncated);
	// 覆盖率必须看得见：不能让人拿「看着已导完」的数字做判断
	const coverageText =
		coverage && coverage.eligible > 0
			? `${esc(d.fileCoverage)} ${esc(fmtInt(coverage.imported))}/${esc(fmtInt(coverage.eligible))} ${esc(d.sessionFiles)}${importing ? ` <span class="cps-c-amber">${esc(d.importing)}</span>` : ""}`
			: "";
	const parts = [
		`${esc(d.ledger)} ${esc(fmtInt(ledger.records ?? 0))} ${esc(d.rows)}`,
		`${esc(d.sessionsRoot)} <code>${esc(meta.sessionsRoot ?? "--")}</code>`,
		`${esc(d.lastBackfill)} ${esc(last)}${backfill ? ` · ${esc(fmtInt(backfill.files ?? 0))} ${esc(d.files)}` : ""}`,
	];
	if (coverageText) parts.unshift(coverageText);
	if (meta.mode === "live-only") parts.push(`<span class="cps-c-amber">${esc(d.liveOnly)}</span>`);
	const stopBtn = importing ? `<button class="cps-btn" data-act="stopImport">${esc(d.stopImport)}</button>` : "";
	return `<div class="cps-meta">${parts.join(" · ")}${stopBtn ? ` ${stopBtn}` : ""}</div>`;
}

/** 整页渲染。 */
function renderDashboard(state, d) {
	const summary = state.summary;
	const meta = state.meta ?? {};
	const ok = Boolean(summary) && state.error === null;
	const winSeg = segmented(["today", "7d", "30d", "all"], state.window, "window", d.win);
	const bucketSeg = segmented(["hour", "day"], state.bucket, "bucket", d.bucket);
	const statusSeg = segmented(["all", "ok", "error", "incomplete"], state.status, "status", {
		all: d.statusAll,
		ok: d.statusOk,
		error: d.statusFailed,
		incomplete: d.statusIncomplete,
	});
	const modelChip = state.model
		? `<button class="cps-chip" data-act="clearModel" title="${esc(d.clearFilter)}">${esc(d.modelFilter)} ${esc(state.model)} ✕</button>`
		: "";
	const series = Array.isArray(state.series) ? state.series : [];
	const body = ok
		? `${renderCards(summary, d)}
			<div class="cps-grid2">
				<div class="cps-panel">
					<h3>${esc(d.chartCalls)}</h3>
					${callsChart(series, d)}
					${legend([
						{ color: "var(--accent, #7c5cff)", label: d.legendCalls },
						{ color: "var(--red, #ef4444)", label: d.legendFailed },
					])}
				</div>
				<div class="cps-panel">
					<h3>${esc(d.chartTtft)}</h3>
					${ttftChart(series, d)}
					${legend([
						{ color: "var(--accent, #7c5cff)", label: d.legendP50 },
						{ color: "var(--amber, #f59e0b)", label: d.legendP90 },
					])}
					<div class="cps-hint">${esc(d.ttftNote)}</div>
				</div>
			</div>
			<div class="cps-panel">
				<h3>${esc(d.modelsTable)}</h3>
				${renderModels(state.models ?? [], d)}
			</div>
			<div class="cps-panel">
				<h3>${esc(d.recordsTable)}</h3>
				<div class="cps-filters">${statusSeg}${modelChip}</div>
				${renderRecords(state, d)}
			</div>`
		: `${renderNotice(state, d)}${state.loading ? `<div class="cps-empty">${esc(d.loading)}</div>` : ""}`;
	const grantBtn = meta.grant?.required
		? `<button class="cps-btn primary" data-act="grant">${esc(d.grant)}</button>`
		: "";
	return `<div class="cps-head">
			<span class="cps-title">📊 ${esc(d.title)}</span>
			<span class="cps-sub">${esc(d.subtitle)}</span>
			<span class="cps-spacer"></span>
			${winSeg}${bucketSeg}${grantBtn}
			<button class="cps-btn" data-act="backfill" ${state.loading ? "disabled" : ""}>${esc(d.backfill)}</button>
			<button class="cps-btn" data-act="refresh" ${state.loading ? "disabled" : ""}>${esc(state.loading ? d.loading : d.refresh)}</button>
		</div>
		${renderMetaLine(state, d)}
		${ok ? renderNotice(state, d) : ""}
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
	busy: false,
	state: {
		window: "today",
		bucket: "hour",
		model: "",
		status: "all",
		page: 1,
		pageSize: PAGE_SIZE,
		summary: null,
		models: null,
		series: null,
		records: null,
		pages: 1,
		total: 0,
		meta: null,
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

/** 拉取四路数据（并行 + 可中断）；失败只写 state.error，绝不抛错。 */
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
	const st = runtime.state;
	const common =
		`window=${encodeURIComponent(st.window)}` +
		`&model=${encodeURIComponent(st.model)}` +
		`&bucket=${encodeURIComponent(st.bucket)}`;
	const recordsQs =
		`${common}&status=${encodeURIComponent(st.status)}` +
		`&page=${encodeURIComponent(String(st.page))}` +
		`&pageSize=${encodeURIComponent(String(st.pageSize))}`;
	const base = apiBase();
	const get = async (path, qs) => {
		const res = await fetch(`${base}${path}?${qs}`, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json();
	};
	try {
		const [summary, series, records, meta] = await Promise.all([
			get("/api/summary", common),
			get("/api/series", common),
			get("/api/records", recordsQs),
			get("/api/meta", ""),
		]);
		if (controller.signal.aborted) return;
		runtime.state.summary = summary?.ok ? summary.summary : null;
		runtime.state.models = summary?.ok ? (summary.models ?? []) : [];
		runtime.state.series = series?.ok ? (series.series ?? []) : [];
		runtime.state.records = records?.ok ? (records.records ?? []) : [];
		runtime.state.pages = records?.pages ?? 1;
		runtime.state.total = records?.total ?? 0;
		runtime.state.meta = meta?.ok ? meta.meta : (summary?.meta ?? null);
		runtime.state.error = summary?.ok ? null : (summary ?? { code: "unknown", reason: "统计接口没有返回" });
	} catch (err) {
		if (controller.signal.aborted) return;
		// 网络/路由错误也走空态，不刷 console 噪声
		runtime.state.error = {
			code: "request-failed",
			reason: `无法读取统计接口：${err?.message ?? err}`,
			reasonEn: `Cannot reach the stats API: ${err?.message ?? err}`,
			hint: "",
			candidates: [],
		};
	} finally {
		// 只有「当前请求」能复位 loading：被新请求接管或卸载时不能把标志留在 true
		if (runtime.inflight === controller) {
			runtime.state.loading = false;
			runtime.inflight = null;
			paint();
		}
	}
}

/** POST 动作（回填 / 授权）：有副作用不走 GET；失败只提示，不抛错。 */
async function postAction(path) {
	if (runtime.busy) return;
	runtime.busy = true;
	try {
		await fetch(`${apiBase()}${path}`, { method: "POST", headers: { Accept: "application/json" } });
	} catch {
		/* 静默：紧接着的 load() 会把状态显示出来 */
	} finally {
		runtime.busy = false;
	}
	runtime.state.page = 1;
	void load();
}

function onRootClick(event) {
	const target = event.target instanceof Element ? event.target : null;
	if (!target) return;
	const actNode = target.closest("[data-act]");
	if (actNode) {
		const act = actNode.getAttribute("data-act");
		const value = actNode.getAttribute("data-value") ?? "";
		if (act === "refresh") {
			void load();
			return;
		}
		if (act === "backfill") {
			void postAction("/api/backfill");
			return;
		}
		if (act === "stopImport") {
			void postAction("/api/backfill/stop");
			return;
		}
		if (act === "grant") {
			void postAction("/api/grant");
			return;
		}
		if (act === "clearModel") {
			runtime.state.model = "";
			runtime.state.page = 1;
			void load();
			return;
		}
		if (act === "window" || act === "bucket" || act === "status") {
			if (!value || runtime.state[act] === value) return;
			runtime.state[act] = value;
			runtime.state.page = 1;
			void load();
			return;
		}
		if (act === "page") {
			const next = Number(value);
			if (!Number.isFinite(next) || next === runtime.state.page) return;
			runtime.state.page = Math.max(1, Math.min(runtime.state.pages || 1, Math.trunc(next)));
			void load();
			return;
		}
	}
	const modelRow = target.closest("tr[data-model]");
	if (modelRow) {
		const model = modelRow.getAttribute("data-model") ?? "";
		runtime.state.model = runtime.state.model === model ? "" : model;
		runtime.state.page = 1;
		void load();
		return;
	}
	const row = target.closest("tr[data-rid]");
	if (row) {
		const id = row.getAttribute("data-rid") ?? "";
		runtime.state.expandedId = runtime.state.expandedId === id ? null : id;
		paint();
	}
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
	// 新挂载 = 新视图：瞬时状态与上一轮数据一律清掉（否则会沿用旧看板的
	// loading/展开行/数据，甚至把按钮永久 disabled）
	runtime.state.loading = false;
	runtime.state.error = null;
	runtime.state.expandedId = null;
	runtime.state.summary = null;
	runtime.state.models = null;
	runtime.state.series = null;
	runtime.state.records = null;
	runtime.state.meta = null;
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
		runtime.state.loading = false;
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
