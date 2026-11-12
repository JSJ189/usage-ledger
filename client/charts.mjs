/**
 * 用量账本 v3 · 手写 SVG 图表（零外部依赖，零 CDN）
 *
 * 设计（docs §2.6.4）：
 *  - 每个系列一个 `<path>`：数据变化只改 `d`，不重建 SVG 节点；
 *  - `crosshair` 竖线 + 单一 tooltip 覆盖层（该桶区间 / calls / TTFT p50·p90 / 成本）；
 *  - 图例可点击隐藏系列（只影响绘制，不触发查询）；
 *  - 点数 > 240 降采样为均值（并在 tooltip 里标出合并了多少桶）；
 *  - 单点 / 全 0 不画图形，回退「无数据 / 桶太少」文案；
 *  - 每张图有 `<title>` + `aria-label`，可聚焦并用 ← → 移动准线。
 */

import { h, svgNode, setText, pool } from "./dom.mjs";
import * as F from "./format.mjs";

export const VB_W = 760;
/** 超过这个点数就降采样（合同要求 ≤240 时原样绘制）。 */
export const MAX_POINTS = 240;
const X_TICKS = 6;

const TONE = {
	accent: "var(--accent, #8b5cf6)",
	green: "var(--green, #34d399)",
	red: "var(--red, #f87171)",
	amber: "var(--amber, #f59e0b)",
	dim: "var(--text-dim, #8b90a0)",
	faint: "var(--text-faint, #6b7080)",
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function niceMax(v) {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return 1;
	const exp = Math.floor(Math.log10(n));
	const base = 10 ** exp;
	const x = n / base;
	const mult = x <= 1 ? 1 : x <= 2 ? 2 : x <= 2.5 ? 2.5 : x <= 5 ? 5 : 10;
	return mult * base;
}

/** 单点数值（bars 用 ok/error/incomplete/other 拆分）。 */
function partsOf(point) {
	const ok = F.numOrNull(point.ok) ?? 0;
	const error = F.numOrNull(point.error) ?? 0;
	const incomplete = F.numOrNull(point.incomplete) ?? 0;
	const calls = F.numOrNull(point.calls) ?? 0;
	const other = Math.max(0, calls - ok - error - incomplete);
	return { ok, error, incomplete, other, calls, cost: F.numOrNull(point.cost) ?? 0 };
}

function meanOf(values) {
	let sum = 0;
	let n = 0;
	for (const v of values) {
		const x = F.numOrNull(v);
		if (x === null) continue;
		sum += x;
		n += 1;
	}
	return n ? sum / n : null;
}

function meanPoint(slice) {
	return {
		t: slice[0].t,
		calls: meanOf(slice.map((p) => p.calls)) ?? 0,
		ok: meanOf(slice.map((p) => p.ok)) ?? 0,
		error: meanOf(slice.map((p) => p.error)) ?? 0,
		incomplete: meanOf(slice.map((p) => p.incomplete)) ?? 0,
		cost: meanOf(slice.map((p) => p.cost)) ?? 0,
		ttftP50: meanOf(slice.map((p) => p.ttftP50)),
		ttftP90: meanOf(slice.map((p) => p.ttftP90)),
		e2eP50: meanOf(slice.map((p) => p.e2eP50)),
		outTok: meanOf(slice.map((p) => p.outTok)) ?? 0,
	};
}

/** 点数 > MAX_POINTS 时按均值降采样（桶宽一致，均值即「每桶速率」）。 */
export function downsample(points) {
	const list = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(Number(p.t))) : [];
	if (list.length <= MAX_POINTS) return { points: list, factor: 1 };
	const factor = Math.ceil(list.length / MAX_POINTS);
	const out = [];
	for (let i = 0; i < list.length; i += factor) out.push(meanPoint(list.slice(i, i + factor)));
	return { points: out, factor };
}

/** `key` 是否属于 bars 的拆分字段。 */
const SPLIT_KEYS = new Set(["ok", "error", "incomplete", "other"]);

/**
 * 建一张图。
 * @param {HTMLElement} host 骨架里的图表挂载点
 * @param {{
 *   key: string,
 *   kind: "bars" | "lines",
 *   height?: number,
 *   yKind: "count" | "ms",
 *   titleKey: string,
 *   series: Array<{key: string, labelKey: string, tone: string, dash?: boolean}>
 * }} cfg
 */
export function createChart(host, cfg) {
	const H = cfg.height ?? 172;
	const PAD = { l: 50, r: 14, t: 14, b: 26 };
	const innerW = VB_W - PAD.l - PAD.r;
	const innerH = H - PAD.t - PAD.b;
	const yFmt = cfg.yKind === "ms" ? F.fmtAxisMs : F.fmtAxisNum;

	const root = h("div", { class: "cps-chart", attrs: { "data-chart": cfg.key } });
	const svgEl = svgNode("svg", {
		class: "cps-chart-svg",
		viewBox: `0 0 ${VB_W} ${H}`,
		role: "img",
		tabindex: "0",
		"aria-label": "",
	});
	const titleEl = svgNode("title");
	svgEl.appendChild(titleEl);

	const gGrid = svgNode("g");
	const grid = [0, 1, 2].map(() => {
		const line = svgNode("line", {
			stroke: "var(--border, #2a2e3a)",
			"stroke-dasharray": "3 4",
			"stroke-width": "1",
		});
		const text = svgNode("text", { "font-size": "10", fill: TONE.faint, "text-anchor": "end" });
		gGrid.appendChild(line);
		gGrid.appendChild(text);
		return { line, text };
	});

	const gSeries = svgNode("g");
	const paths = new Map();
	for (const s of cfg.series) {
		const path = svgNode("path", {
			"data-series": s.key,
			fill: cfg.kind === "bars" ? TONE[s.tone] ?? TONE.accent : "none",
			stroke: cfg.kind === "bars" ? "none" : TONE[s.tone] ?? TONE.accent,
			"stroke-width": cfg.kind === "bars" ? "0" : "1.8",
			"stroke-linejoin": "round",
			"stroke-linecap": "round",
		});
		if (s.dash) path.setAttribute("stroke-dasharray", "4 3");
		gSeries.appendChild(path);
		paths.set(s.key, path);
	}

	const gDots = svgNode("g");
	const dots = new Map();
	for (const s of cfg.series) {
		const dot = svgNode("circle", { r: "3", fill: TONE[s.tone] ?? TONE.accent, class: "cps-hidden" });
		gDots.appendChild(dot);
		dots.set(s.key, dot);
	}

	const gX = svgNode("g");
	const xTicks = Array.from({ length: X_TICKS }, () => {
		const text = svgNode("text", { "font-size": "10", fill: TONE.faint });
		gX.appendChild(text);
		return text;
	});

	const crosshair = svgNode("line", {
		class: "cps-crosshair cps-hidden",
		stroke: "var(--accent, #8b5cf6)",
		"stroke-width": "1",
		"stroke-dasharray": "3 3",
	});
	svgEl.appendChild(gGrid);
	svgEl.appendChild(gSeries);
	svgEl.appendChild(gDots);
	svgEl.appendChild(gX);
	svgEl.appendChild(crosshair);

	const empty = h("div", { class: "cps-chart-empty cps-hidden" }, [h("span", { attrs: { "data-k": `chart.${cfg.key}.empty` } })]);
	const tip = h("div", { class: "cps-chart-tip cps-hidden", attrs: { role: "status", "aria-live": "off" } });
	const tipHead = h("div", { class: "cps-tip-head" });
	const tipRows = h("div", { class: "cps-tip-rows" });
	tip.appendChild(tipHead);
	tip.appendChild(tipRows);

	const legend = h("div", { class: "cps-legend", attrs: { role: "group" } });
	const legendButtons = new Map();
	for (const s of cfg.series) {
		const swatch = h("i", { attrs: { "aria-hidden": "true" } });
		swatch.style.background = TONE[s.tone] ?? TONE.accent;
		const label = h("span");
		const btn = h("button", {
			class: "cps-legend-item",
			attrs: { type: "button", "data-legend": s.key, "aria-pressed": "true" },
			on: {
				click: () => {
					if (state.hidden.has(s.key)) state.hidden.delete(s.key);
					else state.hidden.add(s.key);
					render();
				},
			},
		});
		btn.appendChild(swatch);
		btn.appendChild(label);
		legend.appendChild(btn);
		legendButtons.set(s.key, { btn, label });
	}

	root.appendChild(svgEl);
	root.appendChild(empty);
	root.appendChild(tip);
	root.appendChild(legend);
	host.appendChild(root);

	const state = {
		points: [],
		gran: "1h",
		factor: 1,
		hidden: new Set(),
		hover: -1,
		d: null,
		loading: false,
		max: 1,
	};

	const TOOLTIP_ROWS = cfg.kind === "bars"
		? [
				{ key: "ok", labelKey: "ok", fmt: F.fmtInt },
				{ key: "error", labelKey: "error", fmt: F.fmtInt },
				{ key: "incomplete", labelKey: "incomplete", fmt: F.fmtInt },
				{ key: "other", labelKey: "other", fmt: F.fmtInt },
				{ key: "calls", labelKey: "calls", fmt: F.fmtInt },
				{ key: "ttftP50", labelKey: "ttftP50", fmt: F.fmtMs },
				{ key: "ttftP90", labelKey: "ttftP90", fmt: F.fmtMs },
				{ key: "cost", labelKey: "cost", fmt: (v) => F.fmtCost(v) },
			]
		: [
				{ key: "calls", labelKey: "calls", fmt: F.fmtInt },
				{ key: "ttftP50", labelKey: "ttftP50", fmt: F.fmtMs },
				{ key: "ttftP90", labelKey: "ttftP90", fmt: F.fmtMs },
				{ key: "e2eP50", labelKey: "e2eP50", fmt: F.fmtMs },
				{ key: "outTok", labelKey: "outTok", fmt: F.fmtInt },
				{ key: "cost", labelKey: "cost", fmt: (v) => F.fmtCost(v) },
			];

	const xOf = (i) => {
		const n = state.points.length;
		if (n <= 1) return PAD.l + innerW / 2;
		if (cfg.kind === "bars") return PAD.l + (i + 0.5) * (innerW / n);
		return PAD.l + (i * innerW) / (n - 1);
	};
	const yOf = (v) => PAD.t + innerH - (Math.max(0, v) / state.max) * innerH;

	function valueOf(point, key) {
		if (SPLIT_KEYS.has(key)) return partsOf(point)[key] ?? 0;
		return F.numOrNull(point[key]);
	}

	function visibleSeries() {
		return cfg.series.filter((s) => !state.hidden.has(s.key));
	}

	function computeMax(visible) {
		let max = 0;
		if (cfg.kind === "bars") {
			for (const point of state.points) {
				let sum = 0;
				for (const s of visible) sum += Math.max(0, valueOf(point, s.key) ?? 0);
				if (sum > max) max = sum;
			}
		} else {
			for (const point of state.points) {
				for (const s of visible) {
					const v = F.numOrNull(valueOf(point, s.key));
					if (v !== null && v > max) max = v;
				}
			}
		}
		return niceMax(max);
	}

	function drawGrid() {
		const values = [state.max, state.max / 2, 0];
		grid.forEach((row, i) => {
			const y = yOf(values[i]);
			row.line.setAttribute("x1", String(PAD.l));
			row.line.setAttribute("x2", String(VB_W - PAD.r));
			row.line.setAttribute("y1", y.toFixed(1));
			row.line.setAttribute("y2", y.toFixed(1));
			row.text.setAttribute("x", String(PAD.l - 6));
			row.text.setAttribute("y", (y + 3.5).toFixed(1));
			setText(row.text, yFmt(values[i]));
		});
	}

	function drawXTicks() {
		const n = state.points.length;
		const indices = [];
		if (n <= X_TICKS) for (let i = 0; i < n; i += 1) indices.push(i);
		else for (let k = 0; k < X_TICKS; k += 1) indices.push(Math.round((k * (n - 1)) / (X_TICKS - 1)));
		xTicks.forEach((node, slot) => {
			const idx = indices[slot];
			if (idx === undefined) {
				node.classList.add("cps-hidden");
				return;
			}
			node.classList.remove("cps-hidden");
			const prev = idx > 0 ? state.points[idx - 1]?.t : undefined;
			const x = xOf(idx);
			node.setAttribute("x", clamp(x, PAD.l, VB_W - PAD.r).toFixed(1));
			node.setAttribute("y", String(H - 8));
			node.setAttribute("text-anchor", slot === 0 ? "start" : slot === indices.length - 1 ? "end" : "middle");
			setText(node, F.fmtBucketTick(state.points[idx].t, state.gran, prev));
		});
	}

	function drawBars(visible) {
		const n = state.points.length;
		const step = innerW / n;
		const barW = Math.max(1, Math.min(26, step * 0.8));
		const order = cfg.series.filter((s) => visible.includes(s)); // 堆叠顺序固定，不受隐藏影响
		for (const series of cfg.series) {
			const path = paths.get(series.key);
			if (!visible.includes(series)) {
				path.setAttribute("d", "");
				continue;
			}
			const segments = [];
			for (let i = 0; i < n; i += 1) {
				const point = state.points[i];
				let base = 0;
				for (const s of order) {
					const v = Math.max(0, valueOf(point, s.key) ?? 0);
					if (s.key === series.key) {
						if (v > 0) {
							const x = PAD.l + i * step + (step - barW) / 2;
							const yTop = yOf(base + v);
							const height = Math.max(0.5, yOf(base) - yTop);
							segments.push(`M${x.toFixed(2)},${yTop.toFixed(2)}h${barW.toFixed(2)}v${height.toFixed(2)}h${(-barW).toFixed(2)}Z`);
						}
						break;
					}
					base += v;
				}
			}
			path.setAttribute("d", segments.join(""));
		}
	}

	function drawLines(visible) {
		for (const series of cfg.series) {
			const path = paths.get(series.key);
			const dot = dots.get(series.key);
			if (!visible.includes(series)) {
				path.setAttribute("d", "");
				dot.classList.add("cps-hidden");
				continue;
			}
			const segments = [];
			let current = [];
			state.points.forEach((point, i) => {
				const v = F.numOrNull(valueOf(point, series.key));
				if (v === null || v <= 0) {
					if (current.length) segments.push(current.join(" "));
					current = [];
					return;
				}
				current.push(`${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`);
			});
			if (current.length) segments.push(current.join(" "));
			path.setAttribute("d", segments.map((seg) => `M${seg.replace(/ /g, "L")}`).join(""));
		}
	}

	function drawHoverDots(visible) {
		if (cfg.kind === "bars") return;
		const idx = state.hover;
		for (const series of cfg.series) {
			const dot = dots.get(series.key);
			const point = idx >= 0 ? state.points[idx] : null;
			const v = point && visible.includes(series) ? F.numOrNull(valueOf(point, series.key)) : null;
			if (v === null || v <= 0) {
				dot.classList.add("cps-hidden");
				continue;
			}
			dot.classList.remove("cps-hidden");
			dot.setAttribute("cx", xOf(idx).toFixed(1));
			dot.setAttribute("cy", yOf(v).toFixed(1));
		}
	}

	function renderTooltip(d) {
		const idx = state.hover;
		if (idx < 0 || !state.points[idx]) {
			tip.classList.add("cps-hidden");
			return;
		}
		const point = state.points[idx];
		tip.classList.remove("cps-hidden");
		setText(tipHead, F.fmtBucketRange(point.t, state.gran));
		const parts = partsOf(point);
		const rows = TOOLTIP_ROWS.map((row) => {
			const raw = row.key === "cost" ? parts.cost : SPLIT_KEYS.has(row.key) ? parts[row.key] : point[row.key];
			const shown = row.key === "calls" ? F.fmtInt(parts.calls) : row.fmt(raw);
			return { key: row.key, label: d.tooltip[row.labelKey] ?? row.labelKey, value: shown };
		});
		if (state.factor > 1) rows.push({ key: "__factor", label: "", value: d.tooltip.bucketMean(state.factor) });
		pool(
			tipRows,
			rows,
			{
				key: (row) => row.key,
				create: () => [h("div", { class: "cps-tip-row" }, [h("span", { class: "cps-tip-k" }), h("span", { class: "cps-tip-v" })])],
				update: (nodes, row) => {
					const el = nodes[0];
					setText(el.children[0], row.label);
					setText(el.children[1], row.value);
					el.classList.toggle("cps-tip-note", row.key === "__factor");
				},
			},
		);
		const x = (xOf(idx) / VB_W) * 100;
		tip.style.left = `${clamp(x, 14, 86)}%`;
	}

	function render() {
		const d = state.d;
		if (!d) return;
		for (const [key, entry] of legendButtons) {
			const series = cfg.series.find((s) => s.key === key);
			const label = series ? d.charts[series.labelKey] ?? key : key;
			setText(entry.label, label);
			const visible = !state.hidden.has(key);
			entry.btn.classList.toggle("off", !visible);
			entry.btn.setAttribute("aria-pressed", visible ? "true" : "false");
			entry.btn.setAttribute("aria-label", d.charts.legendToggle(label));
		}
		const visible = visibleSeries();
		const n = state.points.length;
		const hasAny = visible.some((s) =>
			state.points.some((point) => {
				const v = valueOf(point, s.key);
				return F.numOrNull(v) !== null && Number(v) > 0;
			}),
		);
		const drawable = n >= 2 && hasAny && visible.length > 0;
		svgEl.classList.toggle("cps-hidden", !drawable);
		empty.classList.toggle("cps-hidden", drawable);
		if (!drawable) {
			const loading = Boolean(state.loading) && n === 0;
			setText(empty.firstChild, loading ? "" : n === 1 ? d.charts.fewPoints : d.charts.noData);
			empty.classList.toggle("cps-skel", loading);
			state.hover = -1;
			crosshair.classList.add("cps-hidden");
			tip.classList.add("cps-hidden");
		} else {
			empty.classList.remove("cps-skel");
		}
		const first = state.points[0]?.t;
		const last = state.points[n - 1]?.t;
		const label = d.charts.chartAria(
			d.charts[cfg.titleKey] ?? "",
			F.fmtBucketRange(first, state.gran),
			F.fmtBucketRange(last, state.gran),
			n,
		);
		setAttrSafe(svgEl, "aria-label", label);
		setText(titleEl, label);
		if (!drawable) return;
		state.max = computeMax(visible);
		drawGrid();
		drawXTicks();
		if (cfg.kind === "bars") drawBars(visible);
		else drawLines(visible);
		drawHoverDots(visible);
		crosshair.classList.toggle("cps-hidden", state.hover < 0);
		if (state.hover >= 0) {
			const x = xOf(state.hover);
			crosshair.setAttribute("x1", x.toFixed(1));
			crosshair.setAttribute("x2", x.toFixed(1));
			crosshair.setAttribute("y1", String(PAD.t));
			crosshair.setAttribute("y2", String(PAD.t + innerH));
		}
		renderTooltip(d);
	}

	function setHover(index) {
		if (!state.d) return;
		const n = state.points.length;
		const next = index < 0 || n === 0 ? -1 : clamp(index, 0, n - 1);
		if (next === state.hover) return;
		state.hover = next;
		render();
	}

	function indexAt(clientX) {
		const rect = svgEl.getBoundingClientRect();
		const n = state.points.length;
		if (!rect.width || n === 0) return -1;
		const px = ((clientX - rect.left) / rect.width) * VB_W;
		if (cfg.kind === "bars") {
			const step = innerW / n;
			return clamp(Math.floor((px - PAD.l) / step), 0, n - 1);
		}
		const step = n > 1 ? innerW / (n - 1) : 1;
		return clamp(Math.round((px - PAD.l) / step), 0, n - 1);
	}

	const onPointerMove = (event) => {
		setHover(indexAt(event.clientX));
	};
	const onPointerLeave = () => setHover(-1);
	const onKeyDown = (event) => {
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			const dir = event.key === "ArrowLeft" ? -1 : 1;
			const from = state.hover < 0 ? (dir > 0 ? 0 : state.points.length - 1) : state.hover + dir;
			setHover(from);
		} else if (event.key === "Escape") {
			setHover(-1);
		}
	};
	svgEl.addEventListener("pointermove", onPointerMove);
	svgEl.addEventListener("pointerleave", onPointerLeave);
	svgEl.addEventListener("focus", () => {
		if (state.hover < 0) setHover(0);
	});
	svgEl.addEventListener("blur", () => setHover(-1));
	svgEl.addEventListener("keydown", onKeyDown);

	return {
		el: root,
		/**
		 * @param {{points: Array, gran: string, d: object}} input
		 */
		/** @returns {{factor:number, points:number}} 供调用方在面板脚注里标注降采样 */
		update(input) {
			const sampled = downsample(input.points);
			state.points = sampled.points;
			state.factor = sampled.factor;
			state.gran = input.gran || "1h";
			state.d = input.d;
			state.loading = Boolean(input.loading);
			state.hover = -1;
			render();
			return { factor: sampled.factor, points: sampled.points.length };
		},
		destroy() {
			svgEl.removeEventListener("pointermove", onPointerMove);
			svgEl.removeEventListener("pointerleave", onPointerLeave);
			svgEl.removeEventListener("keydown", onKeyDown);
			root.remove();
		},
	};
}

function setAttrSafe(node, name, value) {
	if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/**
 * KPI 卡内的迷你趋势线（无坐标轴、无交互）。
 * @param {HTMLElement} host
 */
export function createSparkline(host) {
	const W = 100;
	const H = 26;
	const svgEl = svgNode("svg", {
		class: "cps-spark",
		viewBox: `0 0 ${W} ${H}`,
		preserveAspectRatio: "none",
		"aria-hidden": "true",
		focusable: "false",
	});
	const path = svgNode("path", {
		fill: "none",
		stroke: "var(--accent, #8b5cf6)",
		"stroke-width": "1.4",
		"vector-effect": "non-scaling-stroke",
		"stroke-linejoin": "round",
		"stroke-linecap": "round",
	});
	svgEl.appendChild(path);
	host.appendChild(svgEl);
	let lastSig = "";
	return {
		el: svgEl,
		/**
		 * @param {Array<number|null>} values 最近 24 桶
		 * @param {string} [tone]
		 */
		update(values, tone) {
			const list = (values ?? []).map((v) => F.numOrNull(v));
			const usable = list.filter((v) => v !== null && v >= 0);
			const sig = `${tone ?? ""}|${list.join(",")}`;
			if (sig === lastSig) return;
			lastSig = sig;
			const hasLine = usable.length >= 2 && Math.max(...usable) > 0;
			svgEl.classList.toggle("cps-hidden", !hasLine);
			if (!hasLine) {
				path.setAttribute("d", "");
				return;
			}
			if (tone) path.setAttribute("stroke", tone);
			const max = Math.max(...usable);
			const n = list.length;
			const step = n > 1 ? W / (n - 1) : W;
			const points = [];
			list.forEach((v, i) => {
				if (v === null || v < 0) return;
				const y = H - 2 - (v / max) * (H - 4);
				points.push(`${(i * step).toFixed(2)},${y.toFixed(2)}`);
			});
			path.setAttribute("d", `M${points.join("L")}`);
		},
	};
}
