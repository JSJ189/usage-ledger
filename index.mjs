/**
 * usage-ledger 3.0 服务端入口。
 *
 * 职责（只做编排，不装业务）：
 *  1. 生命周期：解析状态目录 → 打开 SQLite → 载入内存 rollup → 起导入 worker → 注册路由 → 徽标；
 *  2. 路由 `/api/v3/*`：overview / records / record / import/* / meta / export / prices / grant；
 *  3. 实时采集：把宿主 `onRunEvent` 折成一次调用一条记录（1 条 = 1 次同步小事务，微秒级）；
 *  4. 降级：拿不到 `node:sqlite`、目录不可写、会话目录未授权 —— 一律 200 + `ok:false` + `code`，
 *     绝不 500、绝不抛错，看板按 `code` 给不同文案。
 *
 * 三条硬约束（见 docs/V3-CONTRACT.md §一）：
 *  · 主线程禁止重活（单次同步操作 ≤16ms）；
 *  · 热路径禁止 `host.getSettings()`（设置只在 activate / onSettingsChanged 读，之后走内存快照）；
 *  · 读路径只读内存 rollup（明细表只服务列表/导出，且必须走索引分页）。
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveLegacyLedgerPath, resolveSessionsRoot, resolveStateDir } from "./lib/v3/paths.mjs";
import { projectFromCwd } from "./lib/v3/parser.mjs";
import { openStore } from "./lib/v3/store.mjs";
import { createRollupIndex } from "./lib/v3/rollup.mjs";
import { createPriceBook } from "./lib/v3/prices.mjs";
import { createImporter } from "./lib/v3/importer.mjs";
import { createLiveCollector } from "./lib/live.mjs";

export const BADGE_ID = "usage-ledger-badge";
/** 徽标自检间隔（无变化不推送）。 */
const BADGE_INTERVAL_MS = 60_000;
/** 增量广播节流：worker 每批都会推 delta，但浏览器最多 2 秒收一次。 */
const BROADCAST_THROTTLE_MS = 2000;
/** 小时桶内存保留天数（更老的走天桶）。 */
const RETAIN_DAYS = 45;

const RANGE_KEYS = ["today", "24h", "7d", "30d", "90d", "all", "custom"];
const GRAN_KEYS = ["auto", "5m", "1h", "1d"];
const STATUS_KEYS = ["ok", "client_error", "rate_limited", "provider_error", "aborted", "incomplete"];

/** 「粒度自动」映射：保证任何范围的点数 ≤720（方案 §2.4.2）。 */
export function autoGran(fromMs, toMs) {
	const span = Math.max(0, toMs - fromMs);
	const hour = 3_600_000;
	if (span <= 26 * hour) return "5m";
	if (span <= 40 * 24 * hour) return "1h";
	return "1d";
}

/** 解析时间范围。`today` = 本地 00:00 起。 */
export function resolveRange(query = {}, nowMs = Date.now()) {
	const raw = String(query.range ?? "").trim();
	const fromNum = Number(query.from);
	const toNum = Number(query.to);
	const toMs = Number.isFinite(toNum) && toNum > 0 ? toNum : nowMs;
	if (Number.isFinite(fromNum) && fromNum > 0 && fromNum < toMs) {
		return { key: "custom", fromMs: fromNum, toMs };
	}
	const day = 86_400_000;
	const key = RANGE_KEYS.includes(raw) ? raw : "today";
	if (key === "all") return { key, fromMs: 0, toMs };
	if (key === "today") {
		const d = new Date(toMs);
		return { key, fromMs: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), toMs };
	}
	const days = key === "24h" ? 1 : key === "7d" ? 7 : key === "30d" ? 30 : key === "90d" ? 90 : 1;
	return { key, fromMs: toMs - days * day, toMs };
}

/** 解析筛选器：`all`/空 = 不过滤；多值用逗号。 */
export function resolveFilters(query = {}) {
	const pick = (v) => {
		const s = String(v ?? "").trim();
		if (!s || s === "all") return [];
		return s
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean)
			.slice(0, 20);
	};
	return {
		model: pick(query.model),
		provider: pick(query.provider),
		project: pick(query.project),
		status: pick(query.status).filter((s) => STATUS_KEYS.includes(s)),
		q: String(query.q ?? "").trim().slice(0, 120),
	};
}

function fmtInt(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return "--";
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
	return String(Math.round(v));
}

function fmtMs(ms) {
	const v = Number(ms);
	if (!Number.isFinite(v) || v <= 0) return "--";
	if (v < 1000) return `${Math.round(v)}ms`;
	if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
	return `${Math.round(v / 60_000)}m`;
}

/** 本地时区标签（如 UTC+08:00 / Asia/Shanghai）。 */
function timezoneInfo(now = new Date()) {
	const offsetMin = -now.getTimezoneOffset();
	const sign = offsetMin >= 0 ? "+" : "-";
	const abs = Math.abs(offsetMin);
	const hh = String(Math.floor(abs / 60)).padStart(2, "0");
	const mm = String(abs % 60).padStart(2, "0");
	let label = "";
	try {
		label = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
	} catch {
		label = "";
	}
	return { timezone: `UTC${sign}${hh}:${mm}`, tzLabel: label };
}

/**
 * 明细行 → 合同 §5.2 的对外形状（`client/` 已按这套字段名写死）。
 * 存储层用的是 §4.9 的落库名（`inTok/outTok/ttftMs/genMs/e2eMs`），这里做一次显式映射，
 * 保证 HTTP 契约不随存储改名而漂移。
 */
export function recordOut(r) {
	if (!r) return null;
	const inTok = numOrNull(r.inTok);
	const cacheRead = numOrNull(r.cacheRead);
	const cacheWrite = numOrNull(r.cacheWrite);
	const promptTok = inTok === null && cacheRead === null && cacheWrite === null ? null : (inTok ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
	const sdk = numOrNull(r.costSdk);
	const est = numOrNull(r.costEst);
	const cost = sdk !== null && sdk > 0 ? sdk : est;
	const costSource = r.costSource ?? (sdk !== null && sdk > 0 ? "sdk" : est !== null ? "estimate" : "unpriced");
	return {
		id: r.id ?? null,
		ts: r.ts ?? null,
		model: r.model ?? null,
		provider: r.provider ?? null,
		project: r.project ?? null,
		status: r.status ?? null,
		origin: r.origin ?? null,
		sessionId: r.convId ?? r.src ?? null,
		input: inTok,
		output: numOrNull(r.outTok),
		cacheRead,
		cacheWrite,
		reasoning: numOrNull(r.reasoningTok),
		total: numOrNull(r.totalTok),
		promptTok,
		cacheHitRate: promptTok && cacheRead !== null && promptTok > 0 ? cacheRead / promptTok : null,
		cost,
		costSource,
		priceId: r.priceId ?? null,
		priceVersion: r.priceVersion ?? null,
		ttft: numOrNull(r.ttftMs),
		gen: numOrNull(r.genMs),
		e2e: numOrNull(r.e2eMs),
		stopReason: r.stopReason ?? null,
	};
}

function numOrNull(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** 把 v2 live 采集器的记录折成 v3 明细行（见合同 §4.9）。 */
export function liveRowOf(rec, priceBook) {
	const status = rec?.status === "error" ? "provider_error" : rec?.status === "incomplete" ? "incomplete" : "ok";
	const e2e = Number(rec?.durationMs) > 0 ? Number(rec.durationMs) : null;
	const ttft = Number(rec?.ttftMs) > 0 ? Number(rec.ttftMs) : null;
	const gen = e2e !== null ? (ttft !== null ? Math.max(0, e2e - ttft) : e2e) : null;
	const costSdk = Number.isFinite(Number(rec?.costUsd)) && Number(rec.costUsd) > 0 ? Number(rec.costUsd) : null;
	const row = {
		ts: Number(rec?.ts) || Date.now(),
		entryKey: null,
		convId: rec?.conversationId ?? null,
		model: rec?.model ?? null,
		provider: rec?.provider ?? null,
		// 项目名与历史导入路径统一走 `projectFromCwd`：v2 的 `--C--Users-…--` 形态会被拆成另一个 refs 条目
		project: projectFromCwd(rec?.cwd ?? rec?.projectDir, homedir()) ?? rec?.projectDir ?? null,
		status,
		origin: "live",
		inTok: null,
		outTok: null,
		cacheRead: null,
		cacheWrite: null,
		reasoningTok: null,
		totalTok: null,
		costSdk,
		costEst: null,
		costSource: costSdk !== null ? "sdk" : null,
		priceId: null,
		priceVersion: null,
		ttftMs: ttft,
		genMs: gen,
		e2eMs: e2e,
		stopReason: rec?.stopReason ?? null,
	};
	if (row.costSource === null && priceBook) {
		try {
			const priced = priceBook.apply(row);
			row.costEst = priced?.costEst ?? null;
			row.costSource = priced?.costSource ?? "unpriced";
			row.priceId = priced?.priceId ?? null;
			row.priceVersion = priced?.priceVersion ?? null;
		} catch {
			row.costSource = "unpriced";
		}
	}
	return row;
}

/**
 * 插件入口。宿主按 `mod.default.activate(host)` 调用。
 * @param {object} host
 */
export function activate(host) {
	const log = (level, ...args) => {
		try {
			host.log?.(level, ...args);
		} catch {
			/* 日志失败不影响主流程 */
		}
	};
	const dataDir = typeof host.dataDir === "string" && host.dataDir ? host.dataDir : join(homedir(), ".pi-web-ui");
	const disposers = [];

	// ── 设置快照：只在 activate / onSettingsChanged 读一次，热路径只用内存对象
	let settings = snapshotSettings();
	function snapshotSettings() {
		const raw = (() => {
			try {
				return host.getSettings?.() ?? {};
			} catch {
				return {};
			}
		})();
		const days = Number(raw.backfillDays);
		return {
			sessionsDir: typeof raw.sessionsDir === "string" ? raw.sessionsDir : "",
			backfillDays: Number.isFinite(days) && days > 0 ? Math.min(3650, Math.max(1, Math.trunc(days))) : 30,
			backfillOnStart: raw.backfillOnStart !== false,
			autoImport: raw.autoImport !== false,
			priceOverrides: typeof raw.priceOverrides === "string" ? raw.priceOverrides : "",
		};
	}

	// ── 状态目录（`<dataDir>/plugin-data/usage-ledger/`，用 node:fs 直写，绕开 host.fs 授权弹窗）
	const stateDir = resolveStateDir(dataDir);
	try {
		mkdirSync(stateDir, { recursive: true });
	} catch (err) {
		log("warn", "状态目录创建失败（降级为只读实时统计）：", String(err?.message ?? err));
	}
	const legacyPath = resolveLegacyLedgerPath(dataDir);

	// ── 存储与内存 rollup
	const { stateDir: dbDir, store, degraded, storeError } = openStoreSafely(stateDir, log);
	const now = Date.now();
	const rollup = createRollupIndex({
		rows: loadRollupRows(store, now),
		version: readNumber(store?.metaGet?.("rollup_version"), 0),
		// 窗口超出小时桶保留期（45 天）时 aggregate 从库加载天桶。不传 store 则 90d / all 恒为 0。
		store,
		log,
	});

	// ── 价格表（设置来自快照，热路径零文件读）
	let priceBook = null;
	try {
		priceBook = createPriceBook({
			dir: dbDir,
			fetchImpl: typeof host.fetch === "function" ? host.fetch.bind(host) : globalThis.fetch,
			getSettingsSnapshot: () => settings,
			log,
			now: () => Date.now(),
		});
		priceBook.load?.();
	} catch (err) {
		log("warn", "价格表初始化失败（成本只显示 SDK 值）：", String(err?.message ?? err));
		priceBook = null;
	}

	// ── 导入器（worker 隔离；没有 store 就没有导入）
	let importer = null;
	if (store) {
		try {
			importer = createImporter({
				host,
				store,
				rollup,
				paths: {
					stateDir: dbDir,
					sessionsRoot: resolveSessionsRoot({ settings, home: homedir() }).root,
					legacyPath,
				},
				log,
				onDelta: (version) => {
					scheduleBroadcast(version);
					scheduleBadge();
				},
			});
			disposers.push(host.effect?.("usage-ledger:worker", () => importer?.dispose?.()) ?? (() => importer?.dispose?.()));
		} catch (err) {
			log("warn", "导入器启动失败（只实时统计）：", String(err?.message ?? err));
			importer = null;
		}
	}

	// ── 实时采集：v2 采集器的语义 + v3 落库（一次调用一条，微秒级事务）
	const live = createLiveCollector({
		store: {
			add(rec) {
				if (!store) return;
				try {
					const row = liveRowOf(rec, priceBook);
					const out = store.insertBatch([row], { rollupVersion: rollup.version });
					if (out?.delta?.length) rollup.applyDelta(out.delta);
					const version = rollup.bump();
					store.metaSet?.("rollup_version", String(version));
					store.metaSet?.("last_ingest_at", String(Date.now()));
					scheduleBroadcast(version);
					scheduleBadge();
				} catch (err) {
					log("warn", "实时记录写入失败：", String(err?.message ?? err));
				}
			},
		},
		log,
	});
	try {
		disposers.push(host.onRunEvent?.((event) => live.handle(event)) ?? (() => {}));
	} catch (err) {
		log("warn", "onRunEvent 订阅失败：", String(err?.message ?? err));
	}

	// ── 广播节流（worker 每批都推，浏览器最多 2s 一次）
	let broadcastTimer = null;
	function scheduleBroadcast(version) {
		if (broadcastTimer) return;
		broadcastTimer = setTimeout(() => {
			broadcastTimer = null;
			try {
				host.broadcast?.({ type: "usage-ledger:version", version: version ?? rollup.version });
			} catch {
				/* ignore */
			}
		}, BROADCAST_THROTTLE_MS);
		broadcastTimer.unref?.();
	}

	// ── 徽标：只在数值变化时 `ui.update`（每次 update = 宿主全量 rescan + 全 socket 广播）
	let badgeTimer = null;
	let lastBadgeText = "";
	function refreshBadge() {
		if (!host.ui?.update) return;
		let text = "--";
		if (degraded) text = "不可用";
		else {
			try {
				const win = resolveRange({ range: "today" });
				const agg = rollup.aggregate({ fromMs: win.fromMs, toMs: win.toMs, gran: "5m", filters: {} });
				const calls = agg?.kpi?.calls ?? 0;
				const p50 = agg?.kpi?.ttft?.p50 ?? null;
				text = calls > 0 ? `${fmtInt(calls)} · p50 ${fmtMs(p50)}` : "今日 0";
			} catch (err) {
				text = "--";
			}
		}
		if (text === lastBadgeText) return;
		lastBadgeText = text;
		try {
			host.ui.update(BADGE_ID, { badge: text });
		} catch (err) {
			log("warn", "徽标更新失败：", String(err?.message ?? err));
		}
	}
	function scheduleBadge() {
		if (badgeTimer) return;
		badgeTimer = setTimeout(() => {
			badgeTimer = null;
			refreshBadge();
			scheduleBadge();
		}, BADGE_INTERVAL_MS);
		badgeTimer.unref?.();
	}
	refreshBadge();
	scheduleBadge();

	// ── 路由
	const guard = (fn) => async (req, res) => {
		const t0 = Date.now();
		let payload;
		try {
			payload = await fn(req, res);
		} catch (err) {
			payload = {
				ok: false,
				code: "internal",
				reason: String(err?.message ?? err).slice(0, 300),
				reasonEn: String(err?.message ?? err).slice(0, 300),
			};
		}
		if (!payload || typeof payload !== "object") payload = { ok: true };
		if (res?.headersSent) {
			try {
				res.end?.();
			} catch {
				/* 流式响应已写头，必须 end，否则浏览器挂到超时 */
			}
			return;
		}
		try {
			res?.setHeader?.("Cache-Control", "no-store");
		} catch {
			/* ignore */
		}
		res?.json?.(payload);
		if (Date.now() - t0 > 200) log("warn", "慢请求：", req?.pluginPath ?? "?", `${Date.now() - t0}ms`);
	};

	const needStore = () => ({
		ok: false,
		code: degraded || "no-sqlite",
		reason: degradedReason(degraded, storeError),
	});

	/** store.buildWhere 的 model 维度只认 models，不回退单数；漏映射则表格和 KPI 口径不一致。 */
	function storeFilters(f) {
		return { ...f, models: f.model, providers: f.provider, projects: f.project, statuses: f.status };
	}
	function rejectRange(query) {
		const from = Number(query?.from);
		const to = Number(query?.to);
		if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > 0 && to <= from) {
			return { ok: false, code: "bad-range", reason: "to 必须大于 from" };
		}
		return null;
	}
	function rejectCursor(cursor) {
		if (cursor === undefined || cursor === null || cursor === "") return null;
		if (!/^\d+_\d+$/.test(String(cursor))) return { ok: false, code: "bad-cursor", reason: "cursor 需为 <ts>_<id>" };
		return null;
	}

	host.route?.(
		"GET",
		"/api/v3/overview",
		guard(async (req) => {
			if (!store) return needStore();
			const q = req?.query ?? {};
			const win = resolveRange(q);
			const granRaw = GRAN_KEYS.includes(String(q.gran)) ? String(q.gran) : "auto";
			const gran = granRaw === "auto" ? autoGran(win.fromMs, win.toMs) : granRaw;
			const bad = rejectRange(q);
			if (bad) return bad;
			// 迁移在 worker 里跑完后靠消息重建索引。消息丢了的话小时桶是空的，30 天窗口会显示 0。
			if ((rollup.stats?.().hourBuckets ?? 1) === 0 && (store.stats?.().calls ?? 0) > 0) importer?.reload?.();
			const filters = resolveFilters(q);
			const agg = rollup.aggregate({
				fromMs: win.fromMs,
				toMs: win.toMs,
				gran,
				filters: storeFilters(filters),
				maxBuckets: 720,
				topLimit: 50,
			});
			return {
				ok: true,
				version: rollup.version,
				range: {
					...win,
					// agg 可能因为桶数上限升粒度：以它回显的实际粒度为准（客户端要按这个画 x 轴）
					gran: agg.range?.gran ?? agg.gran ?? gran,
					granRequested: gran,
					granAuto: granRaw === "auto",
					granDowngraded: Boolean(agg.range?.granDowngraded ?? agg.granDowngraded),
					truncated: Boolean(agg.range?.truncated ?? agg.truncated),
					...timezoneInfo(),
				},
				freshness: freshnessOf(),
				kpi: agg.kpi,
				series: agg.series,
				topModels: agg.topModels,
				topProjects: agg.topProjects,
				filters: agg.filters ?? refFilters(),
				prices: priceStatus(),
			};
		}),
	);

	host.route?.(
		"GET",
		"/api/v3/records",
		guard(async (req) => {
			if (!store) return needStore();
			const q = req?.query ?? {};
			const bad = rejectRange(q) || rejectCursor(q.cursor);
			if (bad) return bad;
			const win = resolveRange(q);
			const filters = storeFilters(resolveFilters(q));
			const limit = Math.min(200, Math.max(1, Math.trunc(Number(q.limit) || 50)));
			const out = store.queryRecords({ fromMs: win.fromMs, toMs: win.toMs, filters, cursor: q.cursor, limit, q: q.q });
			if (out?.ok === false) return { ok: false, code: out.code, reason: out.hint ?? "查询被拒绝", total: out.total ?? 0 };
			return { ok: true, total: out.total, records: (out.items ?? []).map(recordOut), nextCursor: out.nextCursor };
		}),
	);

	host.route?.(
		"GET",
		"/api/v3/record/*",
		guard(async (req) => {
			if (!store) return needStore();
			const sub = String(req?.pluginPath ?? "").replace(/^\/api\/v3\/record\/?/, "");
			const id = Number(sub);
			const rec = Number.isFinite(id) ? store.getRecordById(id) : null;
			if (!rec) return { ok: false, code: "not-found", reason: "记录不存在" };
			return { ok: true, record: recordOut(rec) };
		}),
	);

	host.route?.(
		"GET",
		"/api/v3/meta",
		guard(async () => ({
			ok: true,
			meta: {
				schemaVersion: 3,
				rollupVersion: rollup.version,
				stateDir: dbDir,
				legacyLedger: existsSync(legacyPath),
				ledgerBytes: safeSize(join(dbDir, "ledger.sqlite")),
				sessionsRoot: resolveSessionsRoot({ settings, home: homedir() }).root,
				degraded: degraded ? { code: degraded, reason: degradedReason(degraded, storeError) } : null,
				settings,
				importer: importer?.status?.() ?? null,
				prices: priceStatus(),
				store: store?.stats?.() ?? null,
			},
		})),
	);

	host.route?.("GET", "/api/v3/import/status", guard(async () => ({ ok: true, status: importer?.status?.() ?? idleStatus() })));
	host.route?.("GET", "/api/v3/import/errors", guard(async () => ({ ok: true, errors: importer?.errors?.() ?? [] })));
	for (const [verb, method] of [
		["start", "start"],
		["pause", "pause"],
		["resume", "resume"],
		["cancel", "cancel"],
	]) {
		host.route?.(
			"POST",
			`/api/v3/import/${verb}`,
			guard(async () => {
				if (!importer) return { ok: false, code: "no-importer", reason: "导入器不可用（缺少存储或会话授权）" };
				importer[method]?.();
				return { ok: true, status: importer.status?.() ?? idleStatus() };
			}),
		);
	}
	host.route?.(
		"POST",
		"/api/v3/import/recalc",
		guard(async (req) => {
			if (!importer) return { ok: false, code: "no-importer", reason: "导入器不可用" };
			const day = String(req?.query?.day ?? "").slice(0, 10);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, code: "bad-day", reason: "day 需为 YYYY-MM-DD" };
			importer.recalcDay?.(day);
			return { ok: true, day };
		}),
	);

	host.route?.(
		"POST",
		"/api/v3/prices/refresh",
		guard(async () => {
			if (!priceBook) return { ok: false, code: "no-prices", reason: "价格表不可用" };
			const status = await priceBook.refresh();
			importer?.reprice?.();
			return { ok: true, prices: status, repricing: true };
		}),
	);

	host.route?.(
		"GET",
		"/api/v3/export",
		guard(async (req, res) => {
			if (!store) return needStore();
			const q = req?.query ?? {};
			const bad = rejectRange(q);
			if (bad) return bad;
			const win = resolveRange(q);
			const filters = storeFilters(resolveFilters(q));
			const format = String(q.format ?? "csv").toLowerCase() === "json" ? "json" : "csv";
			const header =
				format === "csv"
					? "\uFEFFtime,model,provider,project,status,origin,input,output,cacheRead,cacheWrite,total,promptTok,cacheHitRate,cost,costSource,ttft_ms,gen_ms,e2e_ms,stopReason,sessionId\n"
					: "";
			res?.setHeader?.("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
			res?.setHeader?.("Content-Disposition", `attachment; filename="usage-ledger-${win.key}.${format}"`);
			res?.write?.(format === "csv" ? header : '{"records":[');
			let cursor = "";
			let first = true;
			let written = 0;
			for (;;) {
				const page = store.queryRecords({ fromMs: win.fromMs, toMs: win.toMs, filters, cursor, limit: 200 });
				if (!page.items.length) break;
				let chunk = "";
				for (const r of page.items) {
					const view = recordOut(r);
					if (format === "csv") chunk += `${csvRow(view)}\n`;
					else chunk += `${first ? "" : ","}${JSON.stringify(view)}`;
					first = false;
					written++;
				}
				res?.write?.(chunk);
				if (!page.nextCursor || page.items.length < 200) break;
				cursor = page.nextCursor;
				// 让出事件循环，别把主线程按住
				await new Promise((r) => setImmediate(r));
			}
			if (format === "csv") {
				res?.write?.(`\n# 口径：时区 ${timezoneInfo().timezone} · 范围 ${win.key} · 粒度自动 · 导出 ${written} 条 · 成本含 SDK 与估算（见 costSource）\n`);
			} else {
				res?.write?.("]}");
			}
			res?.end?.();
			return null; // 已经自己写过响应，guard 不要再 json()
		}),
	);

	host.route?.(
		"POST",
		"/api/v3/grant",
		guard(async () => {
			try {
				const out = await host.fs?.requestAccess?.();
				if (importer) importer.resume?.();
				return { ok: true, grant: out ?? null };
			} catch (err) {
				return { ok: false, code: "grant-failed", reason: String(err?.message ?? err) };
			}
		}),
	);

	// ── 设置变化：重建快照、重建导入器根目录、价目表失效
	try {
		const off = host.onSettingsChanged?.(() => {
			settings = snapshotSettings();
			priceBook?.invalidate?.();
			try {
				priceBook?.ensureFresh?.();
			} catch {
				/* ignore */
			}
			if (importer?.setSessionsRoot) {
				importer.setSessionsRoot(resolveSessionsRoot({ settings, home: homedir() }).root);
			}
			refreshBadge();
		});
		if (typeof off === "function") disposers.push(off);
	} catch (err) {
		log("warn", "onSettingsChanged 订阅失败：", String(err?.message ?? err));
	}

	// ── 价格表后台刷新（缓存缺失/过期才联网；失败只记日志）
	try {
		priceBook?.ensureFresh?.();
	} catch (err) {
		log("warn", "价格表刷新调度失败：", String(err?.message ?? err));
	}

	// ── 启动导入：先迁移 v2 账本，再增量导入（都在 worker 里，不阻塞主线程）
	if (importer) {
		(async () => {
			try {
				// 迁移与「自动导入」开关无关：它是历史数据的一次性搬运，不做就等于丢账
				if (existsSync(legacyPath) && !store.metaGet?.("migrated_at")) {
					log("info", "检测到 v2 账本，开始迁移（后台）");
					await importer.migrateLegacy?.();
				}
			} catch (err) {
				log("warn", "v2 迁移失败（不阻塞增量导入）：", String(err?.message ?? err));
			}
			if (settings.autoImport && settings.backfillOnStart) importer.start?.();
		})();
	}

	// ── 后台任务心跳（面板可见，不当调度器）
	let bgTask = null;
	try {
		bgTask = host.registerBackgroundTask?.({
			id: "usage-ledger",
			label: "用量账本（v3）",
			status: degraded ? `降级：${degraded}` : "待命",
			intervalMs: 60_000,
			check: () => {
				const st = importer?.status?.() ?? idleStatus();
				const stats = store?.stats?.() ?? { calls: 0 };
				const phase = st.phase ?? "idle";
				const status = degraded
					? `降级：${degraded} · ${fmtInt(stats.calls)} 条`
					: `${phase} · ${fmtInt(stats.calls)} 条 · 已导入 ${st.filesDone ?? 0}/${st.filesTotal ?? 0}`;
				return { alive: true, status };
			},
		});
	} catch (err) {
		log("warn", "registerBackgroundTask 失败：", String(err?.message ?? err));
	}

	// ── 收尾
	return () => {
		if (broadcastTimer) clearTimeout(broadcastTimer);
		if (badgeTimer) clearTimeout(badgeTimer);
		broadcastTimer = null;
		badgeTimer = null;
		for (const off of disposers.splice(0)) {
			try {
				off();
			} catch {
				/* 幂等清理 */
			}
		}
		try {
			bgTask?.unregister?.();
		} catch {
			/* ignore */
		}
		try {
			live.reset();
		} catch {
			/* ignore */
		}
		try {
			store?.close?.();
		} catch {
			/* ignore */
		}
	};

	// ────────────────────────────────────────────── 内部工具

	function openStoreSafely(dir, logFn) {
		try {
			const s = openStore({ dir, readOnly: false, log: logFn });
			return { stateDir: dir, store: s, degraded: null, storeError: null };
		} catch (err) {
			const message = String(err?.message ?? err);
			const code = /not found|Cannot find|ERR_UNKNOWN_BUILTIN|sqlite/i.test(message) ? "no-sqlite" : "no-store";
			logFn("warn", "存储初始化失败（降级为无统计）：", message);
			return { stateDir: dir, store: null, degraded: code, storeError: message };
		}
	}

	function loadRollupRows(s, nowMs) {
		if (!s) return [];
		const rows = [];
		try {
			const hourRows = s.rollupRows({ fromMs: nowMs - RETAIN_DAYS * 86_400_000, toMs: nowMs, gran: "hour" });
			for (const r of hourRows) rows.push(r);
		} catch (err) {
			log("warn", "小时桶载入失败：", String(err?.message ?? err));
		}
		return rows;
	}

	function readNumber(v, fallback) {
		const n = Number(v);
		return Number.isFinite(n) ? n : fallback;
	}

	function refFilters() {
		try {
			return {
				models: store?.refList?.("model") ?? [],
				providers: store?.refList?.("provider") ?? [],
				projects: store?.refList?.("project") ?? [],
				statuses: STATUS_KEYS,
			};
		} catch {
			return { models: [], providers: [], projects: [], statuses: STATUS_KEYS };
		}
	}

	function freshnessOf() {
		const st = importer?.status?.() ?? idleStatus();
		const stats = (() => {
			try {
				return store?.stats?.() ?? { calls: 0 };
			} catch {
				return { calls: 0 };
			}
		})();
		return {
			lastIngestAt: readNumber(store?.metaGet?.("last_ingest_at"), null),
			lastImportAt: st.finishedAt ?? null,
			ledgerRecords: stats.calls ?? 0,
			importing: st.phase === "importing" || st.phase === "scanning",
			coverage: { imported: st.filesDone ?? 0, eligible: st.filesTotal ?? 0 },
			degraded: degraded ? { code: degraded, reason: degradedReason(degraded, storeError) } : null,
		};
	}

	function priceStatus() {
		try {
			const s = priceBook?.status?.() ?? null;
			return s
				? {
						version: priceBook?.version ?? null,
						fetchedAt: s.fetchedAt ?? null,
						stale: s.stale === true,
					entries: s.entries ?? 0,
					overridesError: s.overridesError ?? null,
					failed: s.failed ?? [],
					sources: Array.isArray(s.sources) ? s.sources : [],
					}
				: null;
		} catch {
			return null;
		}
	}

	function idleStatus() {
		return { phase: "idle", filesTotal: 0, filesDone: 0, rowsTotal: 0, bytesRead: 0, etaMs: null, lastError: null, startedAt: null, finishedAt: null, workerAlive: false };
	}
}

function degradedReason(code, detail) {
	if (code === "no-sqlite") return "当前 Node 不支持内置 node:sqlite（需 Node ≥22.5），统计不可用";
	return `存储不可用：${String(detail ?? "").slice(0, 200)}`;
}

function safeSize(path) {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function csvCell(v) {
	if (v === null || v === undefined) return "";
	const s = String(v);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(r) {
	return [
		new Date(Number(r.ts) || 0).toISOString(),
		csvCell(r.model),
		csvCell(r.provider),
		csvCell(r.project),
		r.status,
		r.origin,
		r.input ?? "",
		r.output ?? "",
		r.cacheRead ?? "",
		r.cacheWrite ?? "",
		r.total ?? "",
		r.promptTok ?? "",
		r.cacheHitRate ?? "",
		r.cost ?? "",
		r.costSource ?? "",
		r.ttft ?? "",
		r.gen ?? "",
		r.e2e ?? "",
		csvCell(r.stopReason),
		csvCell(r.sessionId),
	].join(",");
}

export default { activate };
