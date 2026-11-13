/**
 * 用量账本 v3 · 骨架与样式
 *
 * 只看板骨架**建一次**：所有可变处都带 `data-k` 键，之后由 `patch()` 写 textContent/属性，
 * 不再出现「整页 innerHTML 赋值」（合同 §六）。
 * 样式全部挂在插件自己的 `<style id="usage-ledger-styles">`，前缀 `cps-`，只用宿主主题变量。
 */

import { h } from "./dom.mjs";
import { RANGES, GRANS, STATUSES, VIEWS, COLUMNS } from "./state.mjs";

export const STYLE_ID = "usage-ledger-styles";

/** KPI 卡定义：`spark` 存在时该卡内挂迷你趋势线。 */
export const KPI_CARDS = [
	{ id: "calls", spark: "calls" },
	{ id: "successRate", spark: "success" },
	{ id: "ttft", spark: "ttftP50" },
	{ id: "latency", spark: "e2eP50" },
	{ id: "tokps" },
	{ id: "cost" },
];

const CSS = `
.cps-root {
	display: flex; flex-direction: column; gap: 10px;
	padding: 14px 16px 28px; height: 100%; overflow: auto;
	overscroll-behavior: contain; box-sizing: border-box;
	color: var(--text, #e6e8ef); background: var(--bg, #14161d);
	font-size: 13px; line-height: 1.5; min-width: 0; max-width: 100%;
}
.cps-root *, .cps-root *::before, .cps-root *::after { box-sizing: border-box; }
.cps-hidden { display: none !important; }
.cps-sr {
	position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
	overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.cps-root :focus-visible { outline: 2px solid var(--accent, #8b5cf6); outline-offset: 1px; border-radius: 6px; }

/* ── 顶栏 */
.cps-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.cps-title { font-size: 15px; font-weight: 600; letter-spacing: .2px; }
.cps-sub { color: var(--text-dim, #8b90a0); font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
.cps-spacer { flex: 1 1 auto; }
.cps-truth {
	color: var(--text-dim, #8b90a0); font-size: 11.5px; font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere; display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline;
}
.cps-truth b { color: var(--text, #e6e8ef); font-weight: 600; }

/* ── 控件 */
.cps-seg { display: inline-flex; border: 1px solid var(--border, #2a2e3a); border-radius: 8px; overflow: hidden; }
.cps-tab, .cps-btn, .cps-chip {
	background: transparent; color: var(--text-dim, #8b90a0); border: 0; cursor: pointer;
	padding: 4px 10px; font-size: 12px; font-family: inherit; white-space: nowrap;
}
.cps-tab { border-right: 1px solid var(--border, #2a2e3a); }
.cps-tab:last-child { border-right: 0; }
.cps-tab:hover:not(.on) { color: var(--text, #e6e8ef); }
.cps-tab.on, .cps-tab[aria-selected="true"] { background: var(--accent, #8b5cf6); color: #fff; }
.cps-btn {
	background: var(--bg-elev2, #1a1d26); color: var(--text, #e6e8ef);
	border: 1px solid var(--border, #2a2e3a); border-radius: 8px;
}
.cps-btn:hover:not(:disabled) { border-color: var(--accent, #8b5cf6); }
.cps-btn:disabled { opacity: .5; cursor: default; }
.cps-btn.primary { border-color: var(--accent, #8b5cf6); color: var(--accent, #8b5cf6); }
.cps-chip {
	display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px;
	border: 1px solid color-mix(in srgb, var(--accent, #8b5cf6) 45%, transparent);
	color: var(--accent, #8b5cf6); font-size: 11.5px;
}
.cps-sel {
	background: var(--bg-elev2, #1a1d26); color: var(--text, #e6e8ef);
	border: 1px solid var(--border, #2a2e3a); border-radius: 6px;
	font-size: 12px; padding: 3px 5px; font-family: inherit; max-width: 180px;
}
.cps-input {
	background: var(--bg-elev2, #1a1d26); color: var(--text, #e6e8ef);
	border: 1px solid var(--border, #2a2e3a); border-radius: 6px;
	font-size: 12px; padding: 3px 6px; font-family: inherit;
}
.cps-custom { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim, #8b90a0); font-size: 12px; }

/* ── 筛选栏 */
.cps-filters { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; color: var(--text-dim, #8b90a0); font-size: 12px; }
.cps-filter { display: inline-flex; align-items: center; gap: 5px; position: relative; }
.cps-pop {
	position: absolute; top: calc(100% + 4px); left: 0; z-index: 30;
	background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #2a2e3a);
	border-radius: 8px; padding: 8px 10px; min-width: 180px;
	box-shadow: 0 10px 30px rgba(0, 0, 0, .35);
	display: flex; flex-direction: column; gap: 4px;
}
.cps-pop label { display: flex; align-items: center; gap: 6px; color: var(--text, #e6e8ef); font-size: 12px; cursor: pointer; }

/* ── banner */
.cps-banner {
	border: 1px solid var(--border, #2a2e3a); border-left-width: 3px; border-radius: 8px;
	padding: 8px 10px; font-size: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
	background: var(--bg-elev2, #1a1d26);
}
.cps-banner > .cps-banner-body { flex: 1 1 320px; min-width: 0; }
.cps-banner h4 { margin: 0 0 2px; font-size: 12.5px; font-weight: 600; }
.cps-banner p { margin: 0; color: var(--text-dim, #8b90a0); overflow-wrap: anywhere; }
.cps-banner code { font-size: 11.5px; overflow-wrap: anywhere; }
.cps-banner.stale { border-left-color: var(--amber, #f59e0b); }
.cps-banner.error { border-left-color: var(--red, #f87171); }
.cps-banner.importing { border-left-color: var(--accent, #8b5cf6); }
.cps-banner.notice { border-left-color: var(--green, #34d399); }

/* ── 卡片 */
.cps-kpis { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(172px, 1fr)); }
.cps-card {
	position: relative; background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #2a2e3a);
	border-radius: 10px; padding: 9px 11px 8px; min-width: 0; display: flex; flex-direction: column; gap: 1px;
}
.cps-card .k { color: var(--text-dim, #8b90a0); font-size: 11.5px; }
.cps-card .v { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.cps-card .n { color: var(--text-faint, #6b7080); font-size: 11px; overflow-wrap: anywhere; }
.cps-card .cps-spark-host { height: 22px; margin-top: 4px; }
.cps-card .cps-spark { display: block; width: 100%; height: 22px; opacity: .85; }
.cps-card[title] { cursor: help; }

/* 加载骨架：只加遮罩，不清数据 */
.cps-root[data-phase="loading"][data-has-data="1"] .cps-kpis { opacity: .72; }
.cps-root[data-phase="loading"][data-has-data="0"] .cps-card .v,
.cps-root[data-phase="loading"][data-has-data="0"] .cps-card .n {
	color: transparent;
	background: linear-gradient(90deg, var(--bg-elev2, #1a1d26) 25%, var(--border, #2a2e3a) 37%, var(--bg-elev2, #1a1d26) 63%);
	background-size: 400% 100%; border-radius: 4px; animation: cps-shimmer 1.4s ease infinite;
	min-height: 1em;
}
.cps-root[data-phase="loading"] .cps-chart-svg { opacity: .45; transition: opacity .15s; }
.cps-root[data-phase="stale"] .cps-chart-svg { opacity: .8; }
@keyframes cps-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
@media (prefers-reduced-motion: reduce) {
	.cps-root[data-phase="loading"][data-has-data="0"] .cps-card .v,
	.cps-root[data-phase="loading"][data-has-data="0"] .cps-card .n { animation: none; }
}
.cps-progress { height: 4px; width: 100%; background: var(--border, #2a2e3a); border-radius: 999px; overflow: hidden; }
.cps-progress > i { display: block; height: 100%; width: 0; background: var(--accent, #8b5cf6); transition: width .2s; }
.cps-root[data-phase="loading"] .cps-progress > i { width: 40%; animation: cps-indeterminate 1.1s ease-in-out infinite; }
@keyframes cps-indeterminate { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }

/* ── 面板 */
.cps-panel {
	background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #2a2e3a);
	border-radius: 10px; padding: 10px 12px; min-width: 0;
}
.cps-panel > header { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.cps-panel h3 { margin: 0; font-size: 12.5px; font-weight: 600; color: var(--text, #e6e8ef); }
.cps-panel .cps-panel-sub { color: var(--text-faint, #6b7080); font-size: 11px; overflow-wrap: anywhere; }
.cps-grid2 { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); }
.cps-hint { color: var(--text-faint, #6b7080); font-size: 11px; margin-top: 4px; overflow-wrap: anywhere; }

/* ── 图表 */
.cps-chart { position: relative; min-width: 0; }
.cps-chart-svg { display: block; width: 100%; height: auto; overflow: visible; touch-action: pan-y; }
.cps-chart-svg:focus-visible { outline: 2px solid var(--accent, #8b5cf6); outline-offset: 2px; }
.cps-crosshair { pointer-events: none; }
.cps-chart-empty {
	display: flex; align-items: center; justify-content: center; min-height: 120px;
	color: var(--text-faint, #6b7080); font-size: 12px; text-align: center;
}
.cps-chart-empty.cps-skel {
	min-height: 132px; border-radius: 8px;
	background: linear-gradient(90deg, var(--bg-elev2, #1a1d26) 25%, var(--border, #2a2e3a) 37%, var(--bg-elev2, #1a1d26) 63%);
	background-size: 400% 100%; animation: cps-shimmer 1.4s ease infinite;
}
@media (prefers-reduced-motion: reduce) {
	.cps-chart-empty.cps-skel { animation: none; }
}
.cps-chart-tip {
	position: absolute; top: 4px; transform: translateX(-50%); pointer-events: none; z-index: 5;
	background: color-mix(in srgb, var(--bg, #14161d) 92%, #000);
	border: 1px solid var(--border, #2a2e3a); border-radius: 8px; padding: 6px 9px;
	font-size: 11.5px; min-width: 150px; box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
}
.cps-tip-head { color: var(--text, #e6e8ef); font-weight: 600; margin-bottom: 3px; font-variant-numeric: tabular-nums; }
.cps-tip-rows { display: flex; flex-direction: column; gap: 1px; }
.cps-tip-row { display: flex; justify-content: space-between; gap: 12px; color: var(--text-dim, #8b90a0); }
.cps-tip-row .cps-tip-v { color: var(--text, #e6e8ef); font-variant-numeric: tabular-nums; }
.cps-tip-row.cps-tip-note { color: var(--text-faint, #6b7080); font-size: 10.5px; }
.cps-legend { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
.cps-legend-item {
	display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
	background: transparent; border: 0; color: var(--text-dim, #8b90a0);
	font-size: 11.5px; font-family: inherit; padding: 1px 4px; border-radius: 5px;
}
.cps-legend-item i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.cps-legend-item.off { opacity: .45; text-decoration: line-through; }
.cps-legend-item:hover { color: var(--text, #e6e8ef); }

/* ── 排行 */
.cps-rank { display: flex; flex-direction: column; gap: 5px; }
.cps-rank-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; align-items: baseline; font-size: 12px; }
.cps-rank-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cps-rank-meta { color: var(--text-faint, #6b7080); font-size: 11px; font-variant-numeric: tabular-nums; }
.cps-rank-track { grid-column: 1 / -1; height: 5px; border-radius: 999px; background: var(--border, #2a2e3a); overflow: hidden; }
.cps-rank-track > i { display: block; height: 100%; background: var(--accent, #8b5cf6); border-radius: 999px; }
.cps-rank-empty, .cps-empty { color: var(--text-faint, #6b7080); font-size: 12px; padding: 10px 0; text-align: center; }

/* ── 表格 */
.cps-tbl-wrap { overflow: auto; max-height: 60vh; min-width: 0; }
.cps-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.cps-tbl th, .cps-tbl td { text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--border, #2a2e3a); white-space: nowrap; font-variant-numeric: tabular-nums; }
.cps-tbl th:first-child, .cps-tbl td:first-child { text-align: left; }
.cps-tbl th {
	color: var(--text-dim, #8b90a0); font-weight: 500; font-size: 11.5px;
	position: sticky; top: 0; background: var(--bg-elev2, #1a1d26); z-index: 2; cursor: pointer; user-select: none;
}
.cps-tbl th[aria-sort="ascending"], .cps-tbl th[aria-sort="descending"] { color: var(--accent, #8b5cf6); }
.cps-tbl tbody tr[data-rid] { cursor: pointer; }
.cps-tbl tbody tr[data-rid]:hover { background: color-mix(in srgb, var(--accent, #8b5cf6) 10%, transparent); }
.cps-tbl tbody tr[data-rid][aria-expanded="true"] { background: color-mix(in srgb, var(--accent, #8b5cf6) 8%, transparent); }
.cps-tbl td.cps-c-dim, .cps-c-dim { color: var(--text-dim, #8b90a0); }
.cps-detail td {
	text-align: left; white-space: normal; overflow-wrap: anywhere;
	color: var(--text-dim, #8b90a0);
	background: color-mix(in srgb, var(--accent, #8b5cf6) 6%, transparent);
	font-size: 11.5px;
}
.cps-detail b { color: var(--text, #e6e8ef); font-weight: 600; }
.cps-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
.cps-badge.ok { background: color-mix(in srgb, var(--green, #34d399) 22%, transparent); color: var(--green, #34d399); }
.cps-badge.bad { background: color-mix(in srgb, var(--red, #f87171) 22%, transparent); color: var(--red, #f87171); }
.cps-badge.warn { background: color-mix(in srgb, var(--amber, #f59e0b) 22%, transparent); color: var(--amber, #f59e0b); }
.cps-badge.mute { background: var(--border, #2a2e3a); color: var(--text-dim, #8b90a0); }
.cps-tbl-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-faint, #6b7080); }
.cps-tbl-bar .cps-spacer { min-width: 8px; }

/* ── 导入 */
.cps-import { display: flex; flex-direction: column; gap: 6px; }
.cps-import-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.cps-import-meta { color: var(--text-faint, #6b7080); font-size: 11px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.cps-foot { color: var(--text-faint, #6b7080); font-size: 11px; overflow-wrap: anywhere; display: flex; gap: 4px 12px; flex-wrap: wrap; }
.cps-foot code { font-size: 11px; }
.cps-btn-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.cps-tbl td.cps-tok-total { font-weight: 650; }
.cps-src-ok { color: var(--green, #34d399); }
.cps-src-bad { color: var(--red, #f87171); }
`;

/** 注入插件样式（宿主只加载一次，重复挂载复用同一个 style 节点）。 */
export function ensureStyles() {
	if (typeof document === "undefined") return;
	let style = document.getElementById(STYLE_ID);
	if (!style) {
		style = document.createElement("style");
		style.id = STYLE_ID;
		(document.head ?? document.documentElement).appendChild(style);
	}
	style.textContent = CSS;
}

function segment(act, values, ariaLabel) {
	const list = h("div", {
		class: "cps-seg",
		attrs: { role: "tablist", "aria-label": ariaLabel, "data-k": `${act}.tabs`, "data-act-group": act },
	});
	for (const value of values) {
		list.appendChild(
			h("button", {
				class: "cps-tab",
				attrs: {
					type: "button",
					role: "tab",
					"aria-selected": "false",
					tabindex: "-1",
					"data-act": act,
					"data-value": value,
					"data-k": `${act}.tab.${value}`,
				},
			}),
		);
	}
	return list;
}

function kpiCard(card) {
	const cardEl = h("div", { class: "cps-card", attrs: { "data-k": `kpi.${card.id}` } }, [
		h("div", { class: "k", attrs: { "data-k": `kpi.${card.id}.label` } }),
		h("div", { class: "v", attrs: { "data-k": `kpi.${card.id}.value` } }),
		h("div", { class: "n", attrs: { "data-k": `kpi.${card.id}.note` } }),
	]);
	if (card.spark) {
		cardEl.appendChild(h("div", { class: "cps-spark-host", attrs: { "data-k": `kpi.${card.id}.spark` } }));
	}
	return cardEl;
}

/**
 * 建骨架。
 * @param {HTMLElement} root `.cps-root` 容器
 * @returns {{chartCalls: HTMLElement, chartLatency: HTMLElement, sparks: Map<string, HTMLElement>}}
 */
export function buildSkeleton(root) {
	// ── banners
	const staleBanner = h("div", { class: "cps-banner stale cps-hidden", attrs: { "data-k": "banner.stale", role: "status" } }, [
		h("div", { class: "cps-banner-body" }, [
			h("h4", { attrs: { "data-k": "banner.stale.title" } }),
			h("p", { attrs: { "data-k": "banner.stale.text" } }),
		]),
		h("button", { class: "cps-btn", attrs: { type: "button", "data-act": "refresh", "data-k": "banner.stale.retry" } }),
	]);
	const errorBanner = h("div", { class: "cps-banner error cps-hidden", attrs: { "data-k": "banner.error", role: "alert" } }, [
		h("div", { class: "cps-banner-body" }, [
			h("h4", { attrs: { "data-k": "banner.error.title" } }),
			h("p", { attrs: { "data-k": "banner.error.desc" } }),
			h("p", {}, [h("code", { attrs: { "data-k": "banner.error.hint" } })]),
		]),
		h("div", { class: "cps-btn-row" }, [
			h("button", { class: "cps-btn", attrs: { type: "button", "data-act": "refresh", "data-k": "banner.error.retry" } }),
			h("button", { class: "cps-btn primary cps-hidden", attrs: { type: "button", "data-act": "grant", "data-k": "banner.error.grant" } }),
		]),
	]);
	const importingBanner = h("div", { class: "cps-banner importing cps-hidden", attrs: { "data-k": "banner.importing", role: "status" } }, [
		h("div", { class: "cps-banner-body" }, [
			h("h4", { attrs: { "data-k": "banner.importing.title" } }),
			h("p", { attrs: { "data-k": "banner.importing.desc" } }),
		]),
	]);
	const noticeBanner = h("div", { class: "cps-banner notice cps-hidden", attrs: { "data-k": "banner.notice", role: "status" } }, [
		h("div", { class: "cps-banner-body" }, [h("p", { attrs: { "data-k": "banner.notice.text" } })]),
	]);
	root.appendChild(staleBanner);
	root.appendChild(errorBanner);
	root.appendChild(importingBanner);
	root.appendChild(noticeBanner);

	// ── 顶栏
	const customRange = h("div", { class: "cps-custom cps-hidden", attrs: { "data-k": "range.custom" } }, [
		h("span", { attrs: { "data-k": "range.custom.from.label" } }),
		h("input", { class: "cps-input", attrs: { type: "date", "data-k": "range.from", "aria-label": "from" } }),
		h("span", { attrs: { "data-k": "range.custom.to.label" } }),
		h("input", { class: "cps-input", attrs: { type: "date", "data-k": "range.to", "aria-label": "to" } }),
		h("button", { class: "cps-btn", attrs: { type: "button", "data-act": "range-apply", "data-k": "range.apply" } }),
	]);
	const head = h("div", { class: "cps-head" }, [
		h("span", { class: "cps-title", attrs: { "data-k": "head.title" } }),
		h("span", { class: "cps-sub", attrs: { "data-k": "head.sub" } }),
		h("span", { class: "cps-spacer" }),
		segment("range", RANGES, "range"),
		customRange,
		segment("gran", GRANS, "granularity"),
		segment("view", VIEWS, "view"),
	]);
	root.appendChild(head);

	const toolbar = h("div", { class: "cps-filters" }, [
		h("label", { class: "cps-filter" }, [
			h("span", { attrs: { "data-k": "filter.model.label" } }),
			h("select", { class: "cps-sel", attrs: { "data-k": "filter.model", "data-act": "filter-model", "aria-label": "model" } }),
		]),
		h("label", { class: "cps-filter" }, [
			h("span", { attrs: { "data-k": "filter.provider.label" } }),
			h("select", { class: "cps-sel", attrs: { "data-k": "filter.provider", "data-act": "filter-provider", "aria-label": "provider" } }),
		]),
		h("label", { class: "cps-filter" }, [
			h("span", { attrs: { "data-k": "filter.project.label" } }),
			h("select", { class: "cps-sel", attrs: { "data-k": "filter.project", "data-act": "filter-project", "aria-label": "project" } }),
		]),
		h("div", { class: "cps-filter" }, [
			h("span", { attrs: { "data-k": "filter.status.label" } }),
			h("button", {
				class: "cps-btn",
				attrs: {
					type: "button",
					"data-act": "toggle-status",
					"data-k": "filter.status.btn",
					"aria-haspopup": "true",
					"aria-expanded": "false",
				},
			}),
			h(
				"div",
				{ class: "cps-pop cps-hidden", attrs: { "data-k": "filter.status.panel", role: "group" } },
				STATUSES.map((status) =>
					h("label", {}, [
						h("input", { attrs: { type: "checkbox", "data-act": "status", "data-value": status, "data-k": `filter.status.opt.${status}` } }),
						h("span", { attrs: { "data-k": `filter.status.text.${status}` } }),
					]),
				),
			),
		]),
		h("button", { class: "cps-btn cps-hidden", attrs: { type: "button", "data-act": "clear-filters", "data-k": "filter.clear" } }),
		h("span", { class: "cps-spacer" }),
		h("span", { attrs: { "data-k": "filter.summary" } }),
		h("button", { class: "cps-btn", attrs: { type: "button", "data-act": "refresh", "data-k": "head.refresh" } }),
		h("button", { class: "cps-btn", attrs: { type: "button", "data-act": "export", "data-k": "head.export" } }),
	]);
	root.appendChild(toolbar);

	const truth = h("div", { class: "cps-truth", attrs: { "data-k": "head.truth", "aria-live": "polite" } });
	root.appendChild(truth);

	// ── KPI
	const kpis = h("section", { class: "cps-kpis", attrs: { "data-k": "kpis", "aria-label": "kpi" } }, KPI_CARDS.map(kpiCard));
	root.appendChild(kpis);
	const live = h("div", { class: "cps-sr", attrs: { "data-k": "live.kpi", "aria-live": "polite", role: "status" } });
	root.appendChild(live);

	// ── 图表视图
	const chartCallsHost = h("div", { attrs: { "data-k": "chart.calls.host" } });
	const chartLatencyHost = h("div", { attrs: { "data-k": "chart.latency.host" } });
	const topModels = h("div", { class: "cps-rank", attrs: { "data-k": "top.models.list" } });
	const topProjects = h("div", { class: "cps-rank", attrs: { "data-k": "top.projects.list" } });
	const sentinel = h("div", { class: "cps-sentinel", attrs: { "data-k": "records.sentinel", "aria-hidden": "true" }, style: { height: "1px" } });
	const chartView = h("div", { class: "cps-view", attrs: { "data-k": "view.chart" } }, [
		h("div", { class: "cps-grid2" }, [
			h("section", { class: "cps-panel" }, [
				h("header", {}, [
					h("h3", { attrs: { "data-k": "chart.calls.title" } }),
					h("span", { class: "cps-panel-sub", attrs: { "data-k": "chart.calls.sub" } }),
				]),
				chartCallsHost,
				h("div", { class: "cps-hint", attrs: { "data-k": "chart.calls.note" } }),
			]),
			h("section", { class: "cps-panel" }, [
				h("header", {}, [
					h("h3", { attrs: { "data-k": "chart.latency.title" } }),
					h("span", { class: "cps-panel-sub", attrs: { "data-k": "chart.latency.sub" } }),
				]),
				chartLatencyHost,
				h("div", { class: "cps-hint", attrs: { "data-k": "chart.latency.note" } }),
			]),
		]),
		h("div", { class: "cps-grid2" }, [
			h("section", { class: "cps-panel" }, [
				h("header", {}, [h("h3", { attrs: { "data-k": "top.models.title" } })]),
				topModels,
			]),
			h("section", { class: "cps-panel" }, [
				h("header", {}, [h("h3", { attrs: { "data-k": "top.projects.title" } })]),
				topProjects,
			]),
		]),
		sentinel,
	]);
	root.appendChild(chartView);

	// ── 明细视图
	const tableHead = h("thead", { attrs: { "data-k": "table.head" } });
	const tableBody = h("tbody", { attrs: { "data-k": "table.body" } });
	const table = h("table", { class: "cps-tbl", attrs: { role: "table", "data-k": "table.table", "aria-label": "records" } }, [tableHead, tableBody]);
	const colsPanel = h(
		"div",
		{ class: "cps-pop cps-hidden", attrs: { "data-k": "table.colsPanel", role: "group" } },
		COLUMNS.map((col) =>
			h("label", {}, [
				h("input", { attrs: { type: "checkbox", "data-act": "col", "data-value": col.key, "data-k": `table.col.${col.key}` } }),
				h("span", { attrs: { "data-k": `table.colText.${col.key}` } }),
			]),
		),
	);
	const tableView = h("section", { class: "cps-panel cps-hidden", attrs: { "data-k": "view.table" } }, [
		h("header", {}, [
			h("h3", { attrs: { "data-k": "table.title" } }),
			h("span", { class: "cps-panel-sub", attrs: { "data-k": "table.hint" } }),
		]),
		h("div", { class: "cps-tbl-bar" }, [
			h("span", { attrs: { "data-k": "table.count" } }),
			h("span", { class: "cps-spacer" }),
			h("select", { class: "cps-sel", attrs: { "data-k": "table.pageSize", "data-act": "page-size", "aria-label": "page size" } }),
			h("button", { class: "cps-btn", attrs: { type: "button", "data-act": "prev-page", "data-k": "table.prev" } }),
			h("button", { class: "cps-btn", attrs: { type: "button", "data-act": "next-page", "data-k": "table.next" } }),
			h("div", { class: "cps-filter" }, [
				h("button", {
					class: "cps-btn",
					attrs: { type: "button", "data-act": "toggle-cols", "data-k": "table.colsBtn", "aria-expanded": "false" },
				}),
				colsPanel,
			]),
		]),
		h("div", { class: "cps-tbl-wrap" }, [table]),
		h("div", { class: "cps-empty cps-hidden", attrs: { "data-k": "table.empty" } }),
	]);
	root.appendChild(tableView);

	const tokenBody = h("tbody", { attrs: { "data-k": "tokens.body" } });
	const tokenTable = h("table", { class: "cps-tbl", attrs: { "data-k": "tokens.table" } }, [
		h("thead", {}, [
			h("tr", {}, [
				h("th", { attrs: { "data-k": "tokens.th.model" } }),
				h("th", { attrs: { "data-k": "tokens.th.calls" } }),
				h("th", { attrs: { "data-k": "tokens.th.input" } }),
				h("th", { attrs: { "data-k": "tokens.th.output" } }),
				h("th", { attrs: { "data-k": "tokens.th.cacheRead" } }),
				h("th", { attrs: { "data-k": "tokens.th.cacheWrite" } }),
				h("th", { attrs: { "data-k": "tokens.th.total" } }),
				h("th", { attrs: { "data-k": "tokens.th.cost" } }),
			]),
		]),
		tokenBody,
	]);
	root.appendChild(
		h("section", { class: "cps-panel", attrs: { "data-k": "tokens.panel" } }, [
			h("header", {}, [
				h("h3", { attrs: { "data-k": "tokens.title" } }),
				h("span", { class: "cps-panel-sub", attrs: { "data-k": "tokens.hint" } }),
			]),
			h("div", { class: "cps-tbl-wrap" }, [tokenTable]),
			h("div", { class: "cps-empty cps-hidden", attrs: { "data-k": "tokens.empty" } }),
		]),
	);

	const priceSources = h("div", { class: "cps-rank", attrs: { "data-k": "prices.sources" } });
	root.appendChild(
		h("section", { class: "cps-panel cps-hidden", attrs: { "data-k": "view.prices" } }, [
			h("header", {}, [
				h("h3", { attrs: { "data-k": "prices.title" } }),
				h("span", { class: "cps-panel-sub", attrs: { "data-k": "prices.summary" } }),
				h("span", { class: "cps-spacer" }),
				h("button", { class: "cps-btn", attrs: { type: "button", "data-act": "prices-refresh", "data-k": "prices.refresh" } }),
			]),
			priceSources,
		]),
	);

	// ── 导入面板
	const importFill = h("i", { attrs: { "data-k": "import.fill" } });
	const importBar = h("div", { class: "cps-progress", attrs: { "data-k": "import.bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" } }, [importFill]);
	const importing = h("section", { class: "cps-panel cps-import", attrs: { "data-k": "import.panel" } }, [
		h("div", { class: "cps-import-head" }, [
			h("h3", { attrs: { "data-k": "import.title" } }),
			h("span", { attrs: { "data-k": "import.phase" } }),
			h("span", { class: "cps-import-meta", attrs: { "data-k": "import.progress" } }),
			h("span", { class: "cps-import-meta", attrs: { "data-k": "import.rows" } }),
			h("span", { class: "cps-import-meta", attrs: { "data-k": "import.eta" } }),
			h("span", { class: "cps-spacer" }),
			h("button", { class: "cps-btn primary", attrs: { type: "button", "data-act": "import-start", "data-k": "import.start" } }),
			h("button", { class: "cps-btn cps-hidden", attrs: { type: "button", "data-act": "import-pause", "data-k": "import.pause" } }),
			h("button", { class: "cps-btn cps-hidden", attrs: { type: "button", "data-act": "import-resume", "data-k": "import.resume" } }),
			h("button", { class: "cps-btn cps-hidden", attrs: { type: "button", "data-act": "import-cancel", "data-k": "import.cancel" } }),
		]),
		importBar,
		h("div", { class: "cps-import-meta", attrs: { "data-k": "import.meta" } }),
	]);
	root.appendChild(importing);

	// ── 页脚
	root.appendChild(
		h("footer", { class: "cps-foot", attrs: { "data-k": "foot" } }, [
			h("span", { attrs: { "data-k": "foot.meta" } }),
			h("span", { attrs: { "data-k": "foot.paths" } }),
		]),
	);

	const sparks = new Map();
	for (const card of KPI_CARDS) {
		if (!card.spark) continue;
		const host = root.querySelector(`[data-k="kpi.${card.id}.spark"]`);
		if (host) sparks.set(card.spark, host);
	}
	return { chartCalls: chartCallsHost, chartLatency: chartLatencyHost, sparks };
}
