/**
 * 导入调度器（合同 §4.10）：主线程只做**消息搬运**，一行重活都不干。
 *
 * 自调度规则（合同 §4.10）：worker 报 `done` 后自己挂 `setTimeout` 链——
 *  - 本轮有净进展（rows > 0）→ 100ms 后再跑一轮（快速补齐刚追加的会话）；
 *  - 无进展 → 指数退避 2s → 10s → 60s → 300s（封顶），避免空转。
 * **不用 `host.schedule`**（宿主最小 10s 且会重叠，方案 §2.5 已否决）。
 *
 * 收到 `rollup` delta：`rollup.applyDelta(rows)` → `rollup.bump()` → 节流 2s 调
 * `onDelta(version)`（`host.ui.update` 是全量广播，必须节流，见合同 §四.10 备注）。
 */
import { Worker } from "node:worker_threads";

/** 有净进展时的下一轮延迟。 */
export const RETRY_FAST_MS = 100;
/** 无进展时的退避阶梯（封顶 300s）。 */
export const RETRY_BACKOFF_MS = [2_000, 10_000, 60_000, 300_000];
/** `onDelta` 节流窗口。 */
export const DELTA_THROTTLE_MS = 2_000;
/** 单进程内最多的错误条数（`errors()` 用）。 */
export const MAX_ERRORS = 32;

function toStr(v) {
	if (typeof v !== "string") return null;
	const s = v.trim();
	return s ? s : null;
}

function toNum(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** 空状态（`status()` 的形状，字段与合同 §4.10 逐字一致）。 */
function emptyStatus() {
	return {
		phase: "idle",
		filesTotal: 0,
		filesDone: 0,
		rowsTotal: 0,
		bytesRead: 0,
		etaMs: null,
		lastError: null,
		startedAt: null,
		finishedAt: null,
		batchStartedAt: null,
		batchFinishedAt: null,
		workerAlive: false,
		// 以下为附加字段（index.mjs 直接透传给 /api/v3/import/status）
		rowsDone: 0,
		paused: false,
		pending: 0,
		migrated: null,
		rollupVersion: 0,
		nextRunMs: null,
		errorCount: 0,
		unpricedRows: null,
		priceEntries: null,
		priceVersion: null,
		priceDir: null,
	};
}

/**
 * @param {{host?:object, store?:object, rollup?:object,
 *          paths?:{stateDir?:string, sessionsRoot?:string, legacyPath?:string},
 *          log?:Function, onDelta?:Function, days?:number, batchRows?:number,
 *          priceOverrides?:object, maxFiles?:number, workerFactory?:Function}} opts
 */
export function createImporter(opts = {}) {
	const log = typeof opts.log === "function" ? opts.log : () => {};
	const onDelta = typeof opts.onDelta === "function" ? opts.onDelta : () => {};
	const rollup = opts.rollup ?? null;
	const store = opts.store ?? null;

	let paths = {
		stateDir: toStr(opts.paths?.stateDir) ?? "",
		sessionsRoot: toStr(opts.paths?.sessionsRoot) ?? "",
		legacyPath: toStr(opts.paths?.legacyPath) ?? "",
	};
	let days = Math.max(1, Math.trunc(toNum(opts.days) ?? 30));
	let batchRows = Math.min(2000, Math.max(1, Math.trunc(toNum(opts.batchRows) ?? 500)));
	let maxFiles = Math.max(1, Math.trunc(toNum(opts.maxFiles) ?? 5000));
	let priceOverrides = opts.priceOverrides ?? {};
	let priceCachePath = toStr(opts.priceCachePath) ?? null;
	// autoImport:false → 任何代码路径都不许自动开跑（只允许显式 start({force:true})）
	let autoImport = opts.autoImport !== false;
	const debug = opts.debug === true;

	const status = emptyStatus();
	const errors = [];
	let worker = null;
	let ready = false;
	let disposed = false;
	let timer = null;
	let nextDelay = null;
	let backoffIndex = 0;
	let deltaTimer = null;
	let pendingDeltaVersion = 0;
	let deltaFiredAt = 0;
	let rollupVersion = 0;
	let migrated = null;
	let runStartedAt = null;

	function pushError(code, message) {
		errors.unshift({ code: String(code ?? "UNKNOWN"), reason: String(message ?? ""), at: Date.now(), files: [] });
		if (errors.length > MAX_ERRORS) errors.length = MAX_ERRORS;
		status.lastError = `${code}: ${message}`;
		status.errorCount = errors.length;
	}

	function send(type, payload) {
		if (!worker) return false;
		try {
			worker.postMessage(payload === undefined ? { type } : { type, payload });
			return true;
		} catch (err) {
			log("warn", `worker 消息发送失败（${type}）：`, String(err?.message ?? err));
			return false;
		}
	}

	function flushDelta(force = false) {
		if (!pendingDeltaVersion) return;
		const at = Date.now();
		if (!force && at - deltaFiredAt < DELTA_THROTTLE_MS) {
			if (!deltaTimer) {
				deltaTimer = setTimeout(() => {
					deltaTimer = null;
					flushDelta(true);
				}, DELTA_THROTTLE_MS);
				deltaTimer.unref?.();
			}
			return;
		}
		deltaFiredAt = at;
		const version = pendingDeltaVersion;
		pendingDeltaVersion = 0;
		try {
			onDelta(version);
		} catch (err) {
			log("warn", "onDelta 回调抛错（忽略）：", String(err?.message ?? err));
		}
	}

	function scheduleNext(delayMs) {
		if (disposed) return;
		if (timer) clearTimeout(timer);
		nextDelay = delayMs;
		status.nextRunMs = delayMs;
		timer = setTimeout(() => {
			timer = null;
			kick();
		}, delayMs);
		timer.unref?.();
	}

	function kick() {
		if (disposed || !ready) return;
		status.nextRunMs = null;
		if (status.phase === "importing" || status.phase === "scanning" || status.phase === "migrating") return;
		status.phase = "scanning";
		status.startedAt = status.startedAt ?? Date.now();
		runStartedAt = Date.now();
		send("start");
	}

	function handleMessage(msg) {
		const type = String(msg?.type ?? "");
		const payload = msg?.payload ?? {};
		if (debug) log("debug", `worker→${type}`, JSON.stringify(payload).slice(0, 300));
		switch (type) {
			case "ready": {
				ready = true;
				status.workerAlive = true;
				migrated = payload.migrated === true;
				status.migrated = migrated;
				status.priceEntries = toNum(payload.priceEntries) ?? status.priceEntries;
				status.priceVersion = toNum(payload.priceVersion) ?? status.priceVersion;
				status.priceDir = toStr(payload.priceDir) ?? status.priceDir;
				if (status.priceEntries === 0) {
					log("warn", `导入 worker 读到的价格表为空（${payload.priceDir ?? "?"}）：成本会全部 unpriced。请把 index.mjs 里 priceBook 的目录通过 priceCachePath 传给 createImporter。`);
				}
				rollupVersion = toNum(payload.rollupVersion) ?? rollupVersion;
				status.rollupVersion = rollupVersion;
				log("info", `导入 worker 就绪（migrated=${migrated}，rollup v${rollupVersion}）`);
				break;
			}
			case "progress": {
				const filesTotal = toNum(payload.filesTotal) ?? 0;
				// 迁移进度没有 filesTotal。把它当成「空跑」会把 phase 改成 idle，
				// 主线程就会以为迁移结束并把 worker 停掉（15 万行实测只写入一半，小时桶索引也没重建）。
				if (filesTotal === 0) {
					if (status.phase !== "migrating" && payload.phase !== "migrating" && payload.phase !== "migrated") {
						status.phase = status.paused ? "paused" : "idle";
						status.etaMs = 0;
					}
					break;
				}
				status.phase = toStr(payload.phase) ?? status.phase;
				status.filesTotal = filesTotal;
				status.filesDone = toNum(payload.filesDone) ?? status.filesDone;
				status.rowsTotal = Math.max(status.rowsTotal, toNum(payload.rowsTotal) ?? 0);
				status.rowsDone = toNum(payload.rowsDone) ?? status.rowsDone;
				status.bytesRead = Math.max(status.bytesRead, toNum(payload.bytesRead) ?? 0);
				status.etaMs = toNum(payload.etaMs);
				status.paused = payload.paused === true;
				if (Array.isArray(payload.errors) && payload.errors.length) status.errorCount = payload.errors.length;
				break;
			}
			case "rollup": {
				const rows = Array.isArray(payload.rows) ? payload.rows : [];
				rollupVersion = toNum(payload.version) ?? rollupVersion + 1;
				status.rollupVersion = rollupVersion;
				if (rollup) {
					try {
						rollup.applyDelta(rows);
						rollup.bump();
					} catch (err) {
						log("warn", "applyDelta 失败（忽略这批 delta）：", String(err?.message ?? err));
					}
				}
				pendingDeltaVersion = rollupVersion;
				flushDelta(false);
				break;
			}
			case "batchDone": {
				// 每批都会来一条，不刷日志（进度靠 progress 消息）
				break;
			}
			case "migrated": {
				// P0-A：迁移把 15 万行写进库后，内存索引必须整体重建，否则历史窗口全是 0
				status.unpricedRows = toNum(payload.unpricedRows) ?? status.unpricedRows;
				status.migrated = true;
				migrated = true;
				reloadRollup(true);
				pendingDeltaVersion = Math.max(pendingDeltaVersion, rollupVersion + 1);
				flushDelta(true);
				log("info", `v2 账本迁移完成：${payload.rows ?? 0} 行，未定价 ${payload.unpricedRows ?? 0} 行（内存索引已重建）`);
				break;
			}
			case "recalcDone": {
				status.phase = "done";
				rollupVersion = toNum(payload.version) ?? rollupVersion + 1;
				status.rollupVersion = rollupVersion;
				reloadRollup(true);
				pendingDeltaVersion = rollupVersion;
				flushDelta(true);
				break;
			}
			case "error": {
				pushError(payload.code ?? "WORKER_ERROR", payload.message ?? "");
				status.phase = "error";
				log("warn", `导入 worker 报错：${payload.code} ${payload.message}`);
				break;
			}
			case "done": {
				const rows = toNum(payload.rows) ?? 0;
				const wasMigrating = status.phase === "migrating" || payload.migrated === true;
				// 空跑 → idle（空闲）；真的有活 → done
				status.phase = payload.error ? "error" : status.paused ? "paused" : rows > 0 || wasMigrating ? "done" : "idle";
				const now = Date.now();
				status.batchFinishedAt = now;
				// finishedAt 必须 ≥ startedAt（旧实现会倒挂 110ms，看起来像时间旅行）
				status.finishedAt = Math.max(status.startedAt ?? 0, now);
				if (payload.migrated) {
					status.migrated = true;
					migrated = true;
					status.unpricedRows = toNum(payload.unpricedRows) ?? status.unpricedRows;
					reloadRollup(true);
					pendingDeltaVersion = Math.max(pendingDeltaVersion, rollupVersion + 1);
					flushDelta(true);
				}
				status.rowsTotal = Math.max(status.rowsTotal, rows);
				if (payload.error) pushError("IMPORT_DONE_ERROR", payload.error);
				if (payload.recalculated) reloadRollup(true);
				// 自调度：有净进展就快速再跑一轮，否则指数退避
				if (rows > 0) {
					backoffIndex = 0;
					scheduleNext(RETRY_FAST_MS);
				} else {
					const delay = RETRY_BACKOFF_MS[Math.min(backoffIndex, RETRY_BACKOFF_MS.length - 1)];
					backoffIndex = Math.min(backoffIndex + 1, RETRY_BACKOFF_MS.length);
					scheduleNext(delay);
				}
				break;
			}
			default:
				break;
		}
	}

	function ensureWorker() {
		if (disposed) return null;
		if (worker) return worker;
		const factory = typeof opts.workerFactory === "function" ? opts.workerFactory : null;
		try {
			worker = factory
				? factory()
				: new Worker(new URL("./ingest-worker.mjs", import.meta.url));
			worker.on("message", handleMessage);
			worker.on("error", (err) => {
				pushError("WORKER_ERROR", String(err?.message ?? err));
				status.phase = "error";
				status.workerAlive = false;
				worker = null;
				ready = false;
				scheduleNext(RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
			});
			worker.on("exit", (code) => {
				status.workerAlive = false;
				ready = false;
				worker = null;
				if (!disposed && code !== 0) {
					pushError("WORKER_EXIT", `worker 退出 code=${code}`);
					scheduleNext(RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
				}
			});
			status.workerAlive = true;
			send("init", {
				dir: paths.stateDir,
				stateDir: paths.stateDir,
				sessionsRoot: paths.sessionsRoot,
				days,
				batchRows,
				legacyLedgerPath: paths.legacyPath,
				needMigrate: migrated !== true,
				priceOverrides,
				priceCachePath,
				maxFiles,
			});
			return worker;
		} catch (err) {
			pushError("WORKER_SPAWN_FAILED", String(err?.message ?? err));
			status.phase = "error";
			worker = null;
			return null;
		}
	}

	/** 从库里重新加载内存索引（重算/迁移后调用）。 */
	function reloadRollup(silent = false) {
		if (!rollup || !store) return false;
		try {
			const now = Date.now();
			const hourRows = store.rollupRows({ fromMs: now - 45 * 86_400_000, toMs: now, gran: "hour" });
			const dayRows = store.rollupRows({ fromMs: 0, toMs: now, gran: "day" });
			rollup.replaceAll([...hourRows, ...dayRows], rollupVersion);
			if (!silent) log("info", `内存索引已重新加载：${hourRows.length} 小时桶 + ${dayRows.length} 天桶`);
			return true;
		} catch (err) {
			log("warn", "重新加载内存索引失败：", String(err?.message ?? err));
			return false;
		}
	}

	return {
		/** 启动后台导入（立即返回；真正干活在 worker 里）。 */
		start(force = false) {
			if (disposed) return { ok: false, reason: "disposed" };
			const explicitlyForced = force === true || force?.force === true;
			if (!autoImport && !explicitlyForced) {
				return { ok: false, reason: "auto-import-disabled", autoImport: false };
			}
			ensureWorker();
			status.phase = "scanning";
			status.startedAt = status.startedAt ?? Date.now();
			status.batchStartedAt = Date.now();
			status.finishedAt = null;
			status.batchFinishedAt = null;
			status.paused = false;
			send("start");
			return { ok: true, workerAlive: Boolean(worker) };
		},
		pause() {
			status.paused = true;
			status.phase = status.phase === "importing" ? "paused" : status.phase;
			send("pause");
			return { ok: true, paused: true };
		},
		resume() {
			status.paused = false;
			if (status.phase === "paused") status.phase = "importing";
			ensureWorker();
			send("resume");
			return { ok: true, paused: false };
		},
		cancel() {
			send("cancel");
			status.paused = false;
			if (status.phase === "importing" || status.phase === "paused") status.phase = "idle";
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			return { ok: true };
		},
		/** 迁移 v2 账本（立即返回，进度走 status()）。 */
		migrateLegacy(legacyPath) {
			const path = toStr(legacyPath) ?? paths.legacyPath;
			if (!path) return { ok: false, reason: "no-legacy-path" };
			paths.legacyPath = path;
			ensureWorker();
			status.phase = "migrating";
			send("migrate", { legacyLedgerPath: path });
			return { ok: true, legacyPath: path };
		},
		/** 重算某天（价格版本变更 / 漏计修复）。 */
		recalcDay(day) {
			ensureWorker();
			status.phase = "recalc";
			send("recalc", { day });
			return { ok: true, day };
		},
		status() {
			return {
				...status,
				workerAlive: Boolean(worker) && status.workerAlive,
				autoImport,
				rollupVersion,
				unpricedRows: status.unpricedRows,
			};
		},
		/** 会话目录读取失败结构化清单（合同 §5.3 `/api/v3/import/errors`）。 */
		errors() {
			return errors.slice();
		},
		/** 设置里改了 sessionsDir 时调用：换目录并让 worker 重新 init。 */
		setSessionsRoot(root) {
			const next = toStr(root) ?? "";
			if (next === paths.sessionsRoot) return { ok: true, changed: false, sessionsRoot: next };
			paths.sessionsRoot = next;
			ready = false;
			if (worker) {
				// 只改配置：worker 的 init 会复用已开的库连接
				send("init", {
					dir: paths.stateDir,
					stateDir: paths.stateDir,
					sessionsRoot: paths.sessionsRoot,
					days,
					batchRows,
					legacyLedgerPath: paths.legacyPath,
					needMigrate: migrated !== true,
					priceOverrides,
					maxFiles,
				});
			}
			return { ok: true, changed: true, sessionsRoot: next };
		},
		/** 运行期参数（设置面板改了就调它）。 */
		configure(patch = {}) {
			if (patch.days !== undefined) days = Math.max(1, Math.trunc(toNum(patch.days) ?? days));
			if (patch.batchRows !== undefined) batchRows = Math.min(2000, Math.max(1, Math.trunc(toNum(patch.batchRows) ?? batchRows)));
			if (patch.maxFiles !== undefined) maxFiles = Math.max(1, Math.trunc(toNum(patch.maxFiles) ?? maxFiles));
			if (patch.priceOverrides !== undefined) priceOverrides = patch.priceOverrides ?? {};
			if (patch.autoImport !== undefined) autoImport = patch.autoImport !== false;
			if (patch.priceCachePath !== undefined) priceCachePath = toStr(patch.priceCachePath) ?? null;
			if (patch.sessionsRoot !== undefined) return this.setSessionsRoot(patch.sessionsRoot);
			return { ok: true, days, batchRows, maxFiles, autoImport };
		},
		/** 用库里的 rollup 重建内存索引（启动时 / 迁移后）。 */
		reload() {
			return reloadRollup(false);
		},
		/** 必须调：`host.effect("usage-ledger:worker", () => importer.dispose())`。 */
		dispose() {
			if (disposed) return;
			disposed = true;
			ready = false;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (deltaTimer) {
				clearTimeout(deltaTimer);
				deltaTimer = null;
			}
			flushDelta(true);
			if (worker) {
				try {
					send("shutdown");
				} catch {
					/* ignore */
				}
				try {
					worker.terminate();
				} catch {
					/* ignore */
				}
				worker = null;
			}
			status.workerAlive = false;
			status.phase = "idle";
			log("info", "导入 worker 已释放");
		},
	};
}

export default createImporter;
