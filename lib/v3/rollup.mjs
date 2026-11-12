/**
 * 内存 rollup 索引：`overview` 的**唯一**数据来源（合同 §4.5）。
 *
 * 内存只保留最近 `RETAIN_HOURS`（45 天）的**小时桶**；更老的窗口走
 * `store.rollupRows({gran:'day'})`，结果缓存 60s（`aggregate` 内部处理）。
 *
 * 聚合是**单趟**的：一次遍历同时累加「全局 KPI / 每桶 / 每模型 / 每项目 + 筛选项」，
 * 因为 30d 窗口有几千行，跑 4 遍和跑 1 遍差 4 倍（合同 §三「一次查询驱动多视图」）。
 *
 * 口径全部复用 `metrics.mjs` 的累加器与构造函数，保证
 * `aggregate().kpi === summarizeRows(rows)`、`Σseries.calls === kpi.calls`。
 */
import { BINS } from "./hist.mjs";
import {
	clampBucket,
	createAccum,
	dayKeyOf,
	dayKeyToMs,
	emptyBucketAccums,
	accumulateRow,
	bucketStartOf,
	filterOptionsFromRows,
	kpiFromAccum,
	nextBucketStart,
	normalizeFilter,
	normalizeRollupRow,
	rowInWindow,
	rowMatches,
	seriesPlan,
	seriesPointFromAccum,
	sortTopRows,
	STATUSES,
	topItemFromAccum,
} from "./metrics.mjs";

/** 小时桶保留时长（小时）：45 天。 */
export const RETAIN_HOURS = 45 * 24;
/** 天桶查询缓存 TTL。 */
export const DAY_CACHE_TTL_MS = 60_000;
/** 默认 Top-N 条数。 */
export const TOP_LIMIT = 8;

const HOUR_MS = 3_600_000;
/** 默认点数上限：30d/1h = 720–721 点，留一天余量，避免边界多 1 点就跳 6h。 */
export const DEFAULT_MAX_BUCKETS = 744;

function toNum(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function toStr(v) {
	if (typeof v !== "string") return null;
	const s = v.trim();
	return s ? s : null;
}

/**
 * 创建内存索引。
 * @param {{rows?:object[], version?:number, log?:Function, store?:object,
 *          now?:Function, retainHours?:number, topLimit?:number}} [opts]
 */
export function createRollupIndex(opts = {}) {
	const log = typeof opts.log === "function" ? opts.log : () => {};
	let store = opts.store ?? null;
	const now = typeof opts.now === "function" ? opts.now : () => Date.now();
	const retainHours = Math.max(1, Math.trunc(toNum(opts.retainHours) ?? RETAIN_HOURS));
	const topLimit = Math.max(1, Math.trunc(toNum(opts.topLimit) ?? TOP_LIMIT));

	/** 小时桶：key = `${bucket}|${modelId}|${providerId}|${projectId}|${status}`。 */
	const hourRows = new Map();
	/** 天桶（lazy 从库里加载）。 */
	let dayRows = null;
	let dayLoadedAt = 0;
	let version = Math.trunc(toNum(opts.version) ?? 0);
	let lastDeltaAt = null;
	let droppedOld = 0;
	let warnedNoStore = false;

	function keyOf(row) {
		return `${row.bucket}|${row.modelId}|${row.providerId}|${row.projectId}|${row.status}`;
	}

	function retentionStart() {
		// 对齐到小时，避免同一桶一会儿在内存一会儿不在
		const t = now() - retainHours * HOUR_MS;
		return Math.floor(t / HOUR_MS) * HOUR_MS;
	}

	/** 加一行（可重复调用：同键就地合并，直方图逐桶相加）。 */
	function mergeHourRow(row) {
		if (row.bucket === null || row.bucket === undefined) return false;
		if (typeof row.bucket === "number" && row.bucket < retentionStart()) {
			droppedOld++;
			return false;
		}
		const key = keyOf(row);
		const existing = hourRows.get(key);
		if (!existing) {
			hourRows.set(key, row);
			return true;
		}
		for (const field of ACCUM_FIELDS) existing[field] += row[field];
		mergeHist(existing.ttftHist, row.ttftHist);
		mergeHist(existing.e2eHist, row.e2eHist);
		return true;
	}

	function mergeDayRow(row) {
		if (!dayRows) dayRows = new Map();
		const key = keyOf(row);
		const existing = dayRows.get(key);
		if (!existing) {
			dayRows.set(key, row);
			return true;
		}
		for (const field of ACCUM_FIELDS) existing[field] += row[field];
		mergeHist(existing.ttftHist, row.ttftHist);
		mergeHist(existing.e2eHist, row.e2eHist);
		return true;
	}

	function mergeHist(target, src) {
		if (!target || !src) return;
		const n = Math.min(BINS, target.length, src.length);
		for (let i = 0; i < n; i++) {
			const v = (target[i] || 0) + (src[i] || 0);
			target[i] = v > 0 ? v : 0;
		}
	}

	/** 把 worker 推来的 rollup delta 合并进内存（同结构，含小时桶与天桶）。 */
	function applyDelta(rows) {
		const list = Array.isArray(rows) ? rows : [];
		let n = 0;
		for (let i = 0; i < list.length; i++) {
			const row = normalizeRollupRow(list[i]);
			if (!row) continue;
			if (typeof row.bucket === "string") {
				if (dayRows) n += mergeDayRow(row) ? 1 : 0;
				else n += 0; // 天桶没加载就不维护（下次 aggregate 会从库里重新加载）
			} else {
				n += mergeHourRow(row) ? 1 : 0;
			}
			n += 0;
		}
		lastDeltaAt = now();
		return n;
	}

	/** 启动时从库加载（整表替换）。 */
	function replaceAll(rows, nextVersion) {
		hourRows.clear();
		dayRows = null;
		dayLoadedAt = 0;
		droppedOld = 0;
		const list = Array.isArray(rows) ? rows : [];
		for (let i = 0; i < list.length; i++) {
			// store.rollupRows 已经归一过（含稀疏桶对）→ 不再拷一遍
			const raw = list[i];
			const row = raw && raw.ttftPairs ? raw : normalizeRollupRow(raw);
			if (!row) continue;
			if (typeof row.bucket === "string") mergeDayRow(row);
			else mergeHourRow(row);
		}
		if (nextVersion !== undefined && nextVersion !== null) version = Math.trunc(toNum(nextVersion) ?? version);
		return { rows: hourRows.size + (dayRows ? dayRows.size : 0), version };
	}

	function bump() {
		version += 1;
		return version;
	}

	/** 确保天桶已加载（60s 缓存）。 */
	function ensureDayRows(force = false) {
		const at = now();
		if (!force && dayRows && at - dayLoadedAt < DAY_CACHE_TTL_MS) return dayRows;
		if (!store || typeof store.rollupRows !== "function") {
			// 没有 store 就拿不到天桶：≥45 天的窗口只能退回小时桶（更老的看不到）。
			// 只告警一次，不刷日志。
			if (!warnedNoStore) {
				warnedNoStore = true;
				log("warn", "rollup 索引未接到 store：天桶无法加载（≥45 天窗口会缺老数据）。请 createRollupIndex({store}) 或 index.setStore(store)。");
			}
			if (!dayRows) dayRows = new Map();
			dayLoadedAt = at;
			return dayRows;
		}
		try {
			const rows = store.rollupRows({ fromMs: 0, toMs: at, gran: "day" });
			dayRows = new Map();
			for (let i = 0; i < rows.length; i++) {
				const row = normalizeRollupRow(rows[i]);
				if (row) dayRows.set(keyOf(row), row);
			}
			dayLoadedAt = at;
		} catch (err) {
			log("warn", "天桶加载失败（按空处理）：", String(err?.message ?? err));
			if (!dayRows) dayRows = new Map();
			dayLoadedAt = at;
		}
		return dayRows;
	}

	/**
	 * 取窗口内的 rollup 行。
	 * 小时粒度但窗口早于保留期 → 自动改用天桶（`gran` 会被降级成 `1d`，见 aggregate）。
	 */
	function rowsFor(query = {}) {
		const fromMs = toNum(query.fromMs) ?? 0;
		const toMs = toNum(query.toMs) ?? now();
		const gran = query.gran === "day" || query.gran === "1d" ? "1d" : toNum(query.gran) === null ? "1h" : query.gran;
		const useDay = gran === "1d" || fromMs < retentionStart();
		const out = [];
		if (useDay) {
			const map = ensureDayRows(query.force);
			const fromKey = dayKeyOf(fromMs);
			const toKey = dayKeyOf(toMs);
			for (const row of map.values()) {
				const k = String(row.bucket);
				if (k < fromKey || k > toKey) continue;
				out.push(row);
			}
			return out;
		}
		const from = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
		for (const row of hourRows.values()) {
			if (row.bucket < from || row.bucket > toMs) continue;
			out.push(row);
		}
		return out;
	}

	/**
	 * 一次查询驱动多视图（合同 §5.1 / §4.5）。
	 *
	 * @param {{fromMs?:number, toMs?:number, gran?:string, filters?:object,
	 *          maxBuckets?:number, topLimit?:number}} query
	 * @returns {{kpi:object, series:object[], topModels:object[], topProjects:object[],
	 *            filters:object, coverage:object, range:object,
	 *            version:number, gran:string, granRequested:string,
	 *            granDowngraded:boolean, truncated:boolean}}
	 */
	function aggregate(query = {}) {
		const fromMs = toNum(query.fromMs) ?? 0;
		const toMs = toNum(query.toMs) ?? now();
		const wantGran = toStr(query.gran) ?? "auto";
		const gran1d = wantGran === "1d" || wantGran === "day";
		const useDay = gran1d || fromMs < retentionStart();
		const rows = rowsFor({ fromMs, toMs, gran: useDay ? "1d" : "1h" });
		const rowGran = useDay ? "1d" : "1h";

		// 有效粒度与桶枚举：复用 metrics 的 seriesPlan（含降级 / 升粒度 / 截断判定）
		const plan = seriesPlan({
			fromMs,
			toMs,
			gran: wantGran,
			rowGran,
			maxBuckets: query.maxBuckets ?? DEFAULT_MAX_BUCKETS,
		});

		const filters = {
			models: normalizeFilter(query.filters?.models ?? query.filters?.model),
			providers: normalizeFilter(query.filters?.providers ?? query.filters?.provider),
			projects: normalizeFilter(query.filters?.projects ?? query.filters?.project),
			statuses: normalizeFilter(query.filters?.statuses ?? query.filters?.status),
		};

		// ── 单趟：全局 / 桶 / 模型 / 项目 + 筛选项 ──
		const globalAcc = createAccum();
		const bucketAccs = emptyBucketAccums(plan);
		const firstT = plan.starts.length ? plan.starts[0] : null;
		const modelAccs = new Map();
		const projectAccs = new Map();
		let matched = 0;
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (!row || !rowInWindow(row, { fromMs, toMs })) continue;
			if (!rowMatches(row, filters)) continue;
			matched++;
			accumulateRow(globalAcc, row);
			if (plan.starts.length) {
				const rowStart = typeof row.bucket === "string" ? dayKeyToMs(row.bucket) : row.bucket;
				const at = clampBucket(bucketStartOf(rowStart, plan.gran), plan);
				const bucketAcc = bucketAccs.get(at);
				if (bucketAcc) accumulateRow(bucketAcc, row);
			}
			const modelName = String(row.model ?? "").trim() || "(unknown)";
			let mAcc = modelAccs.get(modelName);
			if (!mAcc) {
				mAcc = createAccum();
				modelAccs.set(modelName, mAcc);
			}
			accumulateRow(mAcc, row);
			const projectName = String(row.project ?? "").trim() || "(unknown)";
			let pAcc = projectAccs.get(projectName);
			if (!pAcc) {
				pAcc = createAccum();
				projectAccs.set(projectName, pAcc);
			}
			accumulateRow(pAcc, row);
		}

		const series = [];
		for (let i = 0; i < plan.starts.length; i++) {
			series.push(seriesPointFromAccum(bucketAccs.get(plan.starts[i]), plan.starts[i]));
		}

		const modelItems = [];
		for (const [name, acc] of modelAccs) modelItems.push(topItemFromAccum(name, acc, globalAcc.calls));
		const projectItems = [];
		for (const [name, acc] of projectAccs) projectItems.push(topItemFromAccum(name, acc, globalAcc.calls));

		const kpi = kpiFromAccum(globalAcc);
		const options = filterOptionsFromRows(rows);
		if (!options.statuses.length) options.statuses = STATUSES.slice();

		const useDayOut = rowGran === "1d";
		return {
			kpi,
			series,
			topModels: sortTopRows(modelItems, query.topLimit ?? topLimit),
			topProjects: sortTopRows(projectItems, query.topLimit ?? topLimit),
			filters: options,
			coverage: {
				rows: rows.length,
				matched,
				buckets: series.length,
				hourBuckets: hourRows.size,
				dayBuckets: dayRows ? dayRows.size : 0,
				retentionHours: retainHours,
				droppedOld,
				truncated: plan.truncated === true,
				granDowngraded: plan.granDowngraded === true,
				source: useDayOut ? "rollup_day" : "rollup_hour",
			},
			// `range` 是给 `/api/v3/overview.range` 直接用的，**全部可枚举**（JSON 里能看到），
			// 粒度降级 / 截断都在这里显式标出来，客户端不能靠猜
			range: {
				fromMs,
				toMs,
				gran: plan.gran,
				granRequested: plan.granRequested,
				granDowngraded: plan.granDowngraded === true,
				truncated: plan.truncated === true,
				buckets: plan.starts.length,
				timezone: timezoneLabel(),
			},
			version,
			gran: plan.gran,
			granRequested: plan.granRequested,
			granDowngraded: plan.granDowngraded === true,
			truncated: plan.truncated === true,
			rows: rows.length,
			lastDeltaAt,
		};
	}

	function stats() {
		return {
			version,
			hourBuckets: hourRows.size,
			dayBuckets: dayRows ? dayRows.size : 0,
			dayLoadedAt: dayLoadedAt || null,
			retainHours,
			retentionStart: retentionStart(),
			droppedOld,
			lastDeltaAt,
		};
	}

	// 构造时就吃掉 opts.rows（index.mjs 用 `createRollupIndex({rows, version})` 建索引，
	// 漏掉这一步会让线上所有窗口 KPI 恒为 0）
	if (Array.isArray(opts.rows)) replaceAll(opts.rows, opts.version);

	return {
		get version() {
			return version;
		},
		/** 运行期接上 store（天桶来源）。重复调用无害。 */
		setStore(next) {
			store = next ?? null;
			dayLoadedAt = 0;
			warnedNoStore = false;
			return store;
		},
		get store() {
			return store;
		},
		bump,
		applyDelta,
		aggregate,
		replaceAll,
		rowsFor,
		stats,
		/** 天桶强制重新加载（导入完成后调用）。 */
		invalidateDay() {
			dayLoadedAt = 0;
			ensureDayRows(true);
		},
	};
}

const ACCUM_FIELDS = [
	"calls",
	"inTok",
	"outTok",
	"cacheRead",
	"cacheWrite",
	"reasoningTok",
	"totalTok",
	"costSdk",
	"costEst",
	"unpriced",
	"e2eSum",
	"e2eN",
	"genSum",
	"genN",
	"outTokTput",
	"rateSum",
	"rateN",
	"cacheN",
];

/** 时区标签（`UTC+08:00`），合同 §5.1 `range.timezone`。 */
export function timezoneLabel(atMs = Date.now()) {
	const offset = -new Date(atMs).getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const abs = Math.abs(offset);
	return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export default createRollupIndex;
