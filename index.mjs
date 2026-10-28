/**
 * usage-ledger 2.0 服务端入口
 *
 * 记录的是 **pi-web-ui 自己的模型调用**，不读任何代理账本、不抓价目表、不估算成本。
 *
 * 数据两路合流：
 *  1. **实时**（`host.onRunEvent`，见 lib/live.mjs）：TTFT 只能这样拿到；
 *  2. **回填**（`~/.pi/agent/sessions/**\/*.jsonl`，见 lib/sessions.mjs）：
 *     逐轮 token、真实成本（SDK `usage.cost.total`）、单次调用耗时。
 *  两路按 `ts + model + provider` / `sessionId + entryId` 合并进自己的账本
 *  （`host.dataDir/ledger.jsonl`，append-only，见 lib/ledger.mjs）。
 *
 * 对外路由（浏览器侧只走这些，全部 200 + `ok:false` 降级，不刷红）：
 *  - `GET  /api/summary?window=&model=`          指标卡 + 按模型汇总
 *  - `GET  /api/series?window=&model=&bucket=`    趋势（hour | day）
 *  - `GET  /api/records?window=&model=&status=&page=&pageSize=`
 *  - `GET  /api/meta`                             账本/回填/授权状态
 *  - `POST /api/backfill`                         立刻跑一次增量回填
 *  - `POST /api/grant`                            申请 sessions 目录读取（宿主弹窗）
 *
 * 降级：拿不到 `fs:read` 或用户拒绝授权 → 只采 live（无 token，展示 `--`），
 * 徽标写 `仅实时`，看板给「授权并导入历史」按钮；一切都不抛错。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLedgerStore, LEDGER_FILE, RECORD_STATUS } from "./lib/ledger.mjs";
import {
	BACKFILL_STATE_FILE,
	createSessionImporter,
	resolveBackfillDays,
	resolveSessionsRoot,
} from "./lib/sessions.mjs";
import * as metrics from "./lib/metrics.mjs";
import { createLiveCollector } from "./lib/live.mjs";

const BADGE_ID = "usage-ledger-badge";
const DAY_MS = 86_400_000;
/** 聚合缓存时长（账本一变就 bust；TTL 只兜「没变化时的重复请求」）。 */
const CACHE_TTL_MS = 10_000;
/** 徽标刷新间隔。 */
const BADGE_INTERVAL_MS = 60_000;
/** 增量回填间隔（5 分钟；启动时另外立刻跑一次）。 */
const BACKFILL_INTERVAL_MS = 300_000;
/** 回填失败后的冷却，防重试风暴。 */
const FAIL_COOLDOWN_MS = 30_000;

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
	return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}s`;
}

/** 宿主没给 dataDir 时的兜底（仍然只写插件自己的目录，绝不写 sessions）。 */
export function fallbackDataDir(home = homedir()) {
	return join(home, ".pi-web-ui", "plugin-data", "usage-ledger");
}

/** 小状态文件的原子读写（回填 offset 用；写坏最多丢增量，重读即可恢复）。 */
export function createStateStore({ dir, file, log } = {}) {
	const path = dir ? join(dir, String(file ?? BACKFILL_STATE_FILE)) : "";
	return {
		path,
		load() {
			if (!path) return { version: 1, files: {} };
			try {
				if (!existsSync(path)) return { version: 1, files: {} };
				const parsed = JSON.parse(readFileSync(path, "utf8"));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: 1, files: {} };
				if (!parsed.files || typeof parsed.files !== "object") parsed.files = {};
				return parsed;
			} catch (err) {
				log?.("warn", "回填状态读取失败（按空状态处理）：", String(err?.message ?? err));
				return { version: 1, files: {} };
			}
		},
		save(state) {
			if (!path) return false;
			try {
				mkdirSync(dir, { recursive: true });
				const tmp = `${path}.tmp`;
				writeFileSync(tmp, `${JSON.stringify(state)}\n`, "utf8");
				renameSync(tmp, path);
				return true;
			} catch (err) {
				log?.("warn", "回填状态写入失败（本次运行仍可用）：", String(err?.message ?? err));
				return false;
			}
		},
	};
}

/**
 * 统计服务：账本 → 聚合 → 路由信封。所有方法都不抛错（失败给 `ok:false`）。
 *
 * @param {object} options
 * @param {ReturnType<typeof createLedgerStore>} options.store
 * @param {ReturnType<typeof createSessionImporter>|null} [options.importer]
 * @param {() => Record<string, unknown>} [options.getSettings]
 * @param {(level:string, ...args:unknown[])=>void} [options.log]
 * @param {() => number} [options.now]
 */
export function createStatsService(options = {}) {
	const store = options.store;
	const log = typeof options.log === "function" ? options.log : () => {};
	const now = typeof options.now === "function" ? options.now : () => Date.now();
	let importer = options.importer ?? null;
	const liveStats = typeof options.liveStats === "function" ? options.liveStats : () => null;
	const cache = new Map();
	let backfillInflight = null;
	let lastBackfill = null;
	let backfillError = null;
	let cooldownUntil = 0;
	let grantState = { required: false, reason: "", reasonEn: "", hint: "", hintEn: "" };

	function bust() {
		cache.clear();
	}

	function remember(res, key, value) {
		cache.set(key, { at: now(), value });
		return value;
	}

	function cached(key) {
		const hit = cache.get(key);
		if (!hit) return null;
		if (now() - hit.at >= CACHE_TTL_MS) {
			cache.delete(key);
			return null;
		}
		return hit.value;
	}

	function setImporter(next) {
		importer = next ?? null;
		bust();
	}

	/** 授权/权限类降级信息（前端据此显示「授权并导入历史」按钮）。 */
	function setGrant(info) {
		grantState = { required: false, reason: "", reasonEn: "", hint: "", hintEn: "", ...(info ?? {}) };
	}

	function windowRecords(params = {}) {
		const win = metrics.resolveWindow(params.window, now());
		const model = typeof params.model === "string" ? params.model.trim() : "";
		const all = store.query({ fromMs: win.fromMs, toMs: win.toMs });
		const records = model ? all.filter((r) => metrics.modelKey(r) === model) : all;
		return { win, model, records };
	}

	/** 能否真正读到会话：能力在 + 目录已授权（未授权时上一次回填会把 required 置 true）。 */
	function fsUsable() {
		return Boolean(importer?.fsReady?.()) && !grantState.required;
	}

	function baseMeta(win, extra = {}) {
		return {
			window: win.key,
			fromMs: win.fromMs,
			toMs: win.toMs,
			generatedAt: now(),
			ledgerPath: store.path,
			ledger: store.stats(),
			sessionsRoot: importer?.root ?? resolveSessionsRoot({ settings: options.getSettings?.() ?? {} }).root,
			fsReady: fsUsable(),
			mode: fsUsable() ? "full" : "live-only",
			backfill: importer?.summary(lastBackfill) ?? null,
			backfillError,
			grant: grantState,
			live: liveStats(),
			...extra,
		};
	}

	/** 指标卡 + 按模型汇总。 */
	function summary(params = {}) {
		const { win, model, records } = windowRecords(params);
		const key = `summary|${win.key}|${model}`;
		const hit = cached(key);
		if (hit) return { ...hit, meta: { ...hit.meta, cached: true, generatedAt: now() } };
		const payload = {
			ok: true,
			meta: baseMeta(win, { model, cached: false }),
			summary: metrics.summarize(records),
			models: metrics.byModel(records),
		};
		return remember("summary", key, payload);
	}

	/** 趋势序列（hour | day）。 */
	function series(params = {}) {
		const { win, model, records } = windowRecords(params);
		const bucket = metrics.normalizeBucket(params.bucket);
		const key = `series|${win.key}|${model}|${bucket}`;
		const hit = cached(key);
		if (hit) return { ...hit, meta: { ...hit.meta, cached: true, generatedAt: now() } };
		const payload = {
			ok: true,
			meta: baseMeta(win, { model, bucket, cached: false }),
			series: metrics.series(records, { bucket }),
		};
		return remember("series", key, payload);
	}

	/** 记录明细（分页 + 模型/状态/关键字筛选）。 */
	function recordsPage(params = {}) {
		const { win, model, records } = windowRecords(params);
		const filtered = metrics.filterRecords(records, { model, status: params.status, q: params.q });
		const page = metrics.pageRecords(filtered, { page: params.page, pageSize: params.pageSize });
		return {
			ok: true,
			meta: baseMeta(win, { model, status: metrics.normalizeStatus(params.status) }),
			records: page.items.map(metrics.projectRecord),
			page: page.page,
			pages: page.pages,
			pageSize: page.pageSize,
			total: page.total,
		};
	}

	/** 状态页数据（授权 / 回填 / 账本规模）。 */
	function meta() {
		return { ok: true, meta: baseMeta(metrics.resolveWindow("all", now())) };
	}

	/** 写入一批记录（回填用）；返回写入统计。 */
	function ingest(list) {
		const result = store.addMany(list);
		if (result.added || result.merged) bust();
		return result;
	}

	/**
	 * 跑一次增量回填。并发调用直接复用同一个 Promise（启动 + 定时 + 手动点按钮不叠加）。
	 */
	async function runBackfill({ force = false } = {}) {
		if (!importer) {
			return { ok: false, code: "no-importer", reason: "回填不可用", reasonEn: "Backfill unavailable" };
		}
		if (backfillInflight) return backfillInflight;
		if (!force && cooldownUntil > now()) {
			return { ok: false, code: "cooldown", reason: "回填冷却中", reasonEn: "Backfill cooling down" };
		}
		backfillInflight = (async () => {
			try {
				if (!importer.fsReady()) {
					const err = {
						code: "no-permission",
						reason: "插件未声明 fs:read 权限",
						reasonEn: "Plugin lacks the fs:read permission",
						hint: "manifest.permissions 需要包含 fs:read",
						hintEn: "manifest.permissions must include fs:read",
					};
					lastBackfill = { ok: false, errors: [err], records: [], files: 0 };
					setGrant({ required: true, ...err });
					backfillError = err;
					return lastBackfill;
				}
				const result = await importer.run();
				const written = ingest(result.records);
				// 记录数组已经进账本，lastBackfill 只留条数（别把几万条挂在内存里）
				lastBackfill = { ...result, records: result.records.length };
				const firstError = (result.errors ?? [])[0] ?? null;
				backfillError = firstError;
				setGrant(firstError ? { required: true, ...firstError } : null);
				if (firstError) cooldownUntil = now() + FAIL_COOLDOWN_MS;
				if (written.added || written.merged) log("debug", `回填：+${written.added} 新记录，${written.merged} 条合并`);
				return { ...lastBackfill, written };
			} catch (err) {
				const code = "backfill-failed";
				backfillError = { code, reason: String(err?.message ?? err), reasonEn: String(err?.message ?? err) };
				cooldownUntil = now() + FAIL_COOLDOWN_MS;
				log("warn", "回填失败：", String(err?.message ?? err));
				return { ok: false, code, reason: backfillError.reason, reasonEn: backfillError.reasonEn, records: [] };
			} finally {
				backfillInflight = null;
			}
		})();
		return backfillInflight;
	}

	/** 申请 sessions 目录读取权限（宿主弹窗）。成功后立刻回填一次。 */
	async function requestAccess({ requestFn, reason } = {}) {
		if (typeof requestFn !== "function") return { ok: false, code: "unsupported" };
		const root = importer?.root ?? resolveSessionsRoot({ settings: options.getSettings?.() ?? {} }).root;
		try {
			const granted = await requestFn(root, reason ?? "导入 pi 自己的历史模型用量（只读）");
			if (!granted) return { ok: false, code: "denied", reason: "用户拒绝授权", reasonEn: "User declined" };
			setGrant(null);
			const res = await runBackfill({ force: true });
			return { ok: true, granted: true, backfill: { ...res, records: undefined } };
		} catch (err) {
			return { ok: false, code: "error", reason: String(err?.message ?? err) };
		}
	}

	/** 底栏徽标：今日调用数 / TTFT p50；没有 fs:read 时写 `仅实时`。 */
	function badge() {
		const win = metrics.resolveWindow("today", now());
		const records = store.query({ fromMs: win.fromMs, toMs: win.toMs });
		const summary = metrics.summarize(records);
		const liveOnly = !fsUsable();
		const body = liveOnly
			? "仅实时"
			: `${fmtInt(summary.calls)}/${summary.ttft.p50 === null ? "--" : fmtMs(summary.ttft.p50)}`;
		const tail = liveOnly
			? "（没有 fs:read：只采实时事件，token 与成本为 --；点开看板可授权导入历史）"
			: `，失败 ${summary.failed}，TTFT p50 ${summary.ttft.p50 === null ? "--" : fmtMs(summary.ttft.p50)}，平均延迟 ${summary.latencyAvg === null ? "--" : fmtMs(summary.latencyAvg)}，输出 ${fmtInt(summary.tokens.output)} tokens，成本 ${summary.cost.amount === null ? "--" : `$${summary.cost.amount.toFixed(4)}`}`;
		return {
			label: "用量账本",
			badge: body,
			hint: `📊 今日模型用量：${summary.calls} 次调用${tail}`,
			hintEn: liveOnly
				? "📊 Today's model usage: live-only (no fs:read; tokens and cost show --). Open the dashboard to authorize history import."
				: `📊 Today's model usage: ${summary.calls} calls, ${summary.failed} failed, TTFT p50 ${summary.ttft.p50 === null ? "--" : fmtMs(summary.ttft.p50)}, avg latency ${summary.latencyAvg === null ? "--" : fmtMs(summary.latencyAvg)}, output ${fmtInt(summary.tokens.output)} tokens, cost ${summary.cost.amount === null ? "--" : `$${summary.cost.amount.toFixed(4)}`}`,
		};
	}

	return {
		summary,
		series,
		recordsPage,
		meta,
		badge,
		ingest,
		runBackfill,
		requestAccess,
		setImporter,
		setGrant,
		/** 账本规模/写入统计（后台任务心跳用）。 */
		stats: () => ({ ...store.stats(), sessionsRoot: importer?.root ?? null, fsReady: fsUsable() }),
		lastBackfill: () => importer?.summary(lastBackfill) ?? null,
		grantState: () => grantState,
		/** 测试/诊断用。 */
		store,
		get importer() {
			return importer;
		},
	};
}

/** 插件入口：宿主按 `mod.default.activate(host)` 调用。 */
export function activate(host) {
	const settingsOf = () => {
		try {
			return host.getSettings?.() ?? {};
		} catch {
			return {};
		}
	};
	const log = (level, ...args) => host.log?.(level, ...args);
	const dataDir = typeof host.dataDir === "string" && host.dataDir ? host.dataDir : fallbackDataDir();

	const store = createLedgerStore({ dir: dataDir, file: LEDGER_FILE, log });
	store.load();

	const stateStore = createStateStore({ dir: dataDir, file: BACKFILL_STATE_FILE, log });
	const state = stateStore.load();

	const buildImporter = () => {
		const settings = settingsOf();
		return createSessionImporter({
			fsApi: host.fs ?? null,
			rootInfo: resolveSessionsRoot({ settings }),
			settings,
			state,
			persist: () => stateStore.save(state),
			log,
			days: resolveBackfillDays(settings.backfillDays),
		});
	};

	const live = createLiveCollector({ store, log });
	const service = createStatsService({
		store,
		importer: buildImporter(),
		getSettings: settingsOf,
		log,
		liveStats: () => live.stats(),
	});

	const disposers = [];

	/** 刷新底栏徽标。 */
	function refreshBadge() {
		try {
			host.ui?.update?.(BADGE_ID, service.badge());
		} catch (err) {
			log("warn", "徽标刷新失败：", String(err?.message ?? err));
		}
	}

	/** 回填 + 刷徽标（一切失败都只记日志）。 */
	async function syncNow({ force = false } = {}) {
		try {
			await service.runBackfill({ force });
		} catch (err) {
			log("warn", "回填异常：", String(err?.message ?? err));
		}
		refreshBadge();
	}

	// ── 实时采集
	if (typeof host.onRunEvent === "function") {
		try {
			const off = host.onRunEvent((event) => {
				try {
					const written = live.handle(event);
					if (written.length) refreshBadge();
				} catch (err) {
					log("warn", "live 事件处理失败：", String(err?.message ?? err));
				}
			});
			if (typeof off === "function") disposers.push(off);
		} catch (err) {
			log("warn", "onRunEvent 订阅失败（只影响实时 TTFT）：", String(err?.message ?? err));
		}
	}

	// ── 路由（全部 200 + ok:false 降级）
	const send = (res, payload) => {
		try {
			res.status?.(200);
			res.json(payload);
		} catch (err) {
			log("warn", "路由应答失败：", String(err?.message ?? err));
		}
	};
	/** 回填结果瘦身：记录数组换成条数（路由应答不该塞几千条记录）。 */
	const slim = (res) => {
		if (!res || typeof res !== "object") return null;
		const { records, ...rest } = res;
		return { ...rest, records: Array.isArray(records) ? records.length : Number(records) || 0 };
	};
	const guard = (fn) => async (req, res) => {
		try {
			send(res, await fn(req));
		} catch (err) {
			send(res, { ok: false, code: "internal", reason: String(err?.message ?? err) });
		}
	};

	if (typeof host.route === "function") {
		host.route("GET", "/api/summary", guard((req) => service.summary(req?.query ?? {})));
		host.route("GET", "/api/series", guard((req) => service.series(req?.query ?? {})));
		host.route("GET", "/api/records", guard((req) => service.recordsPage(req?.query ?? {})));
		host.route("GET", "/api/meta", guard(() => service.meta()));
		host.route(
			"POST",
			"/api/backfill",
			guard(async () => {
				const res = await service.runBackfill({ force: true });
				refreshBadge();
				return { ok: res.ok !== false, backfill: slim(res), meta: service.meta().meta };
			}),
		);
		host.route(
			"POST",
			"/api/grant",
			guard(async () => {
				const out = await service.requestAccess({ requestFn: host.fs?.requestAccess });
				refreshBadge();
				return { ...out, backfill: slim(out.backfill), meta: service.meta().meta };
			}),
		);
	}

	// ── 定时：徽标 60s、增量回填 5 分钟
	try {
		const offBadge = host.schedule?.(
			BADGE_INTERVAL_MS,
			() => {
				refreshBadge();
			},
			{ id: "usage-ledger-badge", label: "用量账本徽标刷新" },
		);
		if (typeof offBadge === "function") disposers.push(offBadge);
	} catch (err) {
		log("warn", "徽标定时任务注册失败：", String(err?.message ?? err));
	}
	try {
		const offBackfill = host.schedule?.(
			BACKFILL_INTERVAL_MS,
			() => {
				void syncNow();
			},
			{ id: "usage-ledger-backfill", label: "用量账本会话回填" },
		);
		if (typeof offBackfill === "function") disposers.push(offBackfill);
	} catch (err) {
		log("warn", "回填定时任务注册失败：", String(err?.message ?? err));
	}

	// ── 后台任务心跳（状态可见，不刷 console）
	let bgTask = null;
	try {
		bgTask = host.registerBackgroundTask?.({
			id: "usage-ledger",
			label: "用量账本（模型调用记录）",
			status: "待首次回填",
			intervalMs: 5 * 60_000,
			check: () => {
				const st = service.stats();
				const backfill = service.lastBackfill();
				if (!st.fsReady) return { alive: true, status: `仅实时（无 fs:read） · 账本 ${st.records} 条` };
				const last = backfill?.finishedAt ? new Date(backfill.finishedAt).toISOString().slice(11, 19) : "未跑";
				return { alive: true, status: `账本 ${st.records} 条 · 上次回填 ${last} · 会话 ${backfill?.files ?? 0} 文件` };
			},
		});
	} catch (err) {
		log("warn", "registerBackgroundTask 失败：", String(err?.message ?? err));
	}

	// ── 设置变化：sessionsDir / backfillDays 都可能变 → 重建回填器再跑一次
	if (typeof host.onSettingsChanged === "function") {
		try {
			const off = host.onSettingsChanged(() => {
				service.setImporter(buildImporter());
				void syncNow({ force: true });
			});
			if (typeof off === "function") disposers.push(off);
		} catch (err) {
			log("warn", "onSettingsChanged 订阅失败：", String(err?.message ?? err));
		}
	}

	// 启动：先出徽标（本地账本，无需授权），再后台跑一次增量回填
	refreshBadge();
	const settingsAtBoot = settingsOf();
	if (settingsAtBoot.backfillOnStart !== false) {
		void syncNow({ force: true });
	}

	return () => {
		for (const off of disposers.splice(0)) {
			try {
				off();
			} catch {
				/* 幂等清理：单条失败不影响其余 */
			}
		}
		try {
			bgTask?.unregister?.();
		} catch {
			/* ignore */
		}
		live.reset();
	};
}

export default { activate };
/** 便于单测/诊断的再导出。 */
export { DAY_MS, CACHE_TTL_MS, BADGE_INTERVAL_MS, BACKFILL_INTERVAL_MS, RECORD_STATUS, metrics };
