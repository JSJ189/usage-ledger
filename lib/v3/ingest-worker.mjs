/**
 * 导入 worker（合同 §4.8）：**唯一**允许在后台做重活的地方。
 *
 * 职责：
 *  - 消费 `ingest.mjs` 的 `iterSessionRows`（异步生成器，一次一个文件，流式）；
 *  - 写库前先 `priceBook.apply(row)` 补成本，再 `store.insertBatch(rows, {rollupVersion})`；
 *  - 把本次 rollup delta（§4.9 形状）推回主线程，≤200 行/条消息；
 *  - 迁移 v2 账本（`migrate`）、重算某天（`recalc`）也在这里跑。
 *
 * 线程约束：worker 里**只**碰自己的可写 SQLite 连接 + 文件读取 + 价格表；
 * 绝不 import 宿主（`host.*`）任何东西。
 */
import { parentPort } from "node:worker_threads";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { iterSessionRows, scanSessionFiles } from "./ingest.mjs";
import { createPriceBook } from "./prices.mjs";
import { migrateLegacyV2 } from "./migrate.mjs";
import { openStore } from "./store.mjs";
import { IMPORT_STATE_FILE, statePath } from "./paths.mjs";
import { dayKeyOf } from "./metrics.mjs";

/** 单条 `rollup` 消息最多带多少行（合同 §4.8）。 */
export const ROLLUP_MSG_ROWS = 200;
/** 状态文件写盘节流。 */
export const STATE_WRITE_THROTTLE_MS = 5_000;

const DAY_MS = 86_400_000;

/** @type {{dir:string, stateDir:string, sessionsRoot:string, days:number, batchRows:number,
 *          legacyLedgerPath:string|null, needMigrate:boolean, chunkBytes:number, maxFiles:number,
 *          priceOverrides:object}|null} */
let cfg = null;
let store = null;
let priceBook = null;
let rollupVersion = 0;
let running = false;
let phase = "idle";
let stopFlag = null; // 'pause' | 'cancel' | null
let paused = false;
let errors = [];
let state = { files: {}, updatedAt: 0 };
let stateDirtyAt = 0;
let migrated = false;

function post(type, payload) {
	try {
		parentPort?.postMessage({ type, payload });
	} catch {
		/* 主线程已退出：忽略 */
	}
}

function log(level, ...args) {
	if (level === "error") post("error", { code: "log", message: args.map(String).join(" ") });
}

function loadState(stateDir) {
	const path = statePath(stateDir, IMPORT_STATE_FILE);
	try {
		if (!existsSync(path)) return { files: {}, updatedAt: 0 };
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return { files: {}, updatedAt: 0 };
		return {
			...parsed,
			files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
		};
	} catch {
		return { files: {}, updatedAt: 0 };
	}
}

/** 状态写盘：节流 5s，且**绝不抛错**（状态文件只是加速开关，坏了不影响账本）。 */
function saveState(force = false) {
	if (!cfg?.stateDir) return;
	const at = Date.now();
	if (!force && at - stateDirtyAt < STATE_WRITE_THROTTLE_MS) return;
	stateDirtyAt = at;
	state.updatedAt = at;
	state.sessionsRoot = cfg.sessionsRoot ?? state.sessionsRoot ?? null;
	state.rollupVersion = rollupVersion;
	try {
		writeFileSync(statePath(cfg.stateDir, IMPORT_STATE_FILE), JSON.stringify(state));
	} catch {
		/* 磁盘满/权限问题：ignored，下次再试 */
	}
}

function init(payload = {}) {
	const nextDir = payload.stateDir ?? payload.dir ?? "";
	// 重复 init（例如主线程只改了会话目录）不要重建连接，只更新配置
	if (store && cfg && cfg.stateDir === nextDir) {
		cfg = {
			...cfg,
			sessionsRoot: payload.sessionsRoot ?? cfg.sessionsRoot,
			days: Number(payload.days) > 0 ? Number(payload.days) : cfg.days,
			batchRows: Math.min(2000, Math.max(1, Number(payload.batchRows) || cfg.batchRows)),
			legacyLedgerPath: payload.legacyLedgerPath ?? cfg.legacyLedgerPath,
			priceOverrides: payload.priceOverrides ?? cfg.priceOverrides,
		};
		// priceEntries 让主线程一眼看出 worker 读到的价格表规模（对不上就是 dir 配错）
	let priceEntries = null;
	let priceVersion = null;
	let pricePath = null;
	try {
		const st = priceBook?.status?.();
		priceEntries = st?.entries ?? st?.count ?? null;
		priceVersion = st?.version ?? null;
		pricePath = st?.path ?? st?.cachePath ?? null;
	} catch {
		/* ignore */
	}
	post("ready", { migrated, rollupVersion, sessionsRoot: cfg.sessionsRoot, priceEntries, priceVersion, pricePath, priceDir: cfg.priceCachePath || cfg.stateDir });
		return;
	}
	if (store) {
		try {
			store.close();
		} catch {
			/* ignore */
		}
		store = null;
	}
	cfg = {
		dir: payload.dir ?? "",
		stateDir: payload.stateDir ?? payload.dir ?? "",
		sessionsRoot: payload.sessionsRoot ?? "",
		days: Number(payload.days) > 0 ? Number(payload.days) : 30,
		batchRows: Math.min(2000, Math.max(1, Number(payload.batchRows) || 500)),
		legacyLedgerPath: payload.legacyLedgerPath ?? null,
		needMigrate: payload.needMigrate === true,
		chunkBytes: Number(payload.chunkBytes) || 1024 * 1024,
		maxFiles: Number(payload.maxFiles) || 5000,
		priceOverrides: payload.priceOverrides ?? {},
		// 价格快照文件所在目录：主线程的 priceBook 在哪读，worker 就在哪读（否则两边各读一份会一边有价一边没价）
		priceCachePath: payload.priceCachePath ?? payload.priceDir ?? null,
	};
	store = openStore({ dir: cfg.stateDir, log });
	priceBook = createPriceBook({
		dir: cfg.priceCachePath || cfg.stateDir,
		log,
		getSettingsSnapshot: () => ({ priceOverrides: cfg.priceOverrides }),
	});
	try {
		priceBook.load();
	} catch {
		/* 空价格表继续 */
	}
	rollupVersion = Number(store.metaGet("rollup_version") ?? 0) || 0;
	migrated = Boolean(store.metaGet("migrated_at"));
	state = loadState(cfg.stateDir);
	post("ready", { migrated, rollupVersion, sessionsRoot: cfg.sessionsRoot });
}

function stopRequested() {
	if (stopFlag === "cancel") return "cancel";
	if (stopFlag === "pause" || paused) return "pause";
	return false;
}

function priceRow(row) {
	if (!priceBook) return row;
	try {
		const patch = priceBook.apply(row);
		if (!patch) return row;
		return { ...row, ...patch };
	} catch {
		return row;
	}
}

/** 把一批行写库，并把 rollup delta 分片推回主线程。 */
function flushBatch(buffer) {
	if (!buffer.length) return 0;
	const rows = new Array(buffer.length);
	for (let i = 0; i < buffer.length; i++) rows[i] = priceRow(buffer[i]);
	const result = store.insertBatch(rows, { rollupVersion });
	rollupVersion += 1;
	const delta = Array.isArray(result.delta) ? result.delta : [];
	for (let i = 0; i < delta.length; i += ROLLUP_MSG_ROWS) {
		post("rollup", { version: rollupVersion, rows: delta.slice(i, i + ROLLUP_MSG_ROWS) });
	}
	post("batchDone", { rows: result.rows, skipped: result.skipped, updated: result.updated, delta: delta.length });
	return result.rows;
}

function progressPayload(extra = {}) {
	return {
		phase,
		filesTotal: extra.filesTotal ?? 0,
		filesDone: extra.filesDone ?? 0,
		rowsTotal: extra.rowsTotal ?? 0,
		rowsDone: extra.rowsDone ?? 0,
		bytesRead: extra.bytesRead ?? 0,
		etaMs: extra.etaMs ?? null,
		paused: paused || stopFlag === "pause",
		errors: errors.slice(0, 8),
	};
}

/** 一次导入：按 state 里的 size/mtime 跳过没变的文件，只读新增/变化的。 */
async function runImport() {
	if (running) return { ok: false, reason: "busy" };
	running = true;
	stopFlag = null;
	paused = false;
	phase = "scanning";
	errors = [];
	try {
		if (!cfg?.sessionsRoot) {
			phase = "error";
			post("error", { code: "NO_SESSIONS_ROOT", message: "没有可用的会话目录（sessionsRoot 为空）" });
			post("done", { rows: 0, stopped: true });
			return { ok: false, reason: "no-root" };
		}
		const sinceMs = Date.now() - cfg.days * DAY_MS;
		const scanned = scanSessionFiles({ root: cfg.sessionsRoot, sinceMs, maxFiles: cfg.maxFiles });
		const allFiles = scanned.files ?? [];
		const pending = [];
		for (const file of allFiles) {
			const known = state.files?.[file.rel];
			if (known && known.size === file.size && known.mtimeMs === file.mtimeMs) continue;
			pending.push(file);
		}
		phase = "importing";
		let rowsTotal = 0;
		let filesDone = 0;
		let bytesRead = 0;
		let buffer = [];
		const totalBytes = pending.reduce((sum, f) => sum + (f.size || 0), 0);
		const startedAt = Date.now();
		post("progress", progressPayload({ filesTotal: pending.length, filesDone: 0, rowsTotal: 0, bytesRead: 0, etaMs: null }));

		for await (const file of iterSessionRows({
			root: cfg.sessionsRoot,
			files: pending,
			chunkBytes: cfg.chunkBytes,
		})) {
			const stop = stopRequested();
			if (stop) {
				stopFlag = null;
				if (stop === "pause") paused = true;
				phase = stop === "pause" ? "paused" : "idle";
				break;
			}
			for (const row of file.rows) {
				buffer.push(row);
				if (buffer.length >= cfg.batchRows) {
					rowsTotal += flushBatch(buffer);
					buffer = [];
				}
			}
			filesDone += 1;
			bytesRead += file.bytesRead || 0;
			if (file.stats?.errors?.length) {
				for (const e of file.stats.errors.slice(0, 3)) {
					errors.push({ code: "PARSE", reason: String(e.reason ?? e), files: [file.rel] });
				}
			}
			state.files[file.rel] = {
				size: file.size,
				mtimeMs: file.mtimeMs,
				bytesRead: file.bytesRead ?? 0,
				rows: (state.files?.[file.rel]?.rows ?? 0) + (file.rows?.length ?? 0),
				at: Date.now(),
			};
			saveState(false);
			const elapsed = Date.now() - startedAt;
			const etaMs =
				totalBytes > 0 && bytesRead > 0
					? Math.round((elapsed / Math.max(1, bytesRead)) * Math.max(0, totalBytes - bytesRead))
					: null;
			post(
				"progress",
				progressPayload({ filesTotal: pending.length, filesDone, rowsTotal: rowsTotal + buffer.length, rowsDone: filesDone, bytesRead, etaMs }),
			);
		}
		rowsTotal += flushBatch(buffer);
		saveState(true);
		phase = errors.length ? "done" : "done";
		store.metaSet("last_ingest_at", String(Date.now()));
		post("progress", progressPayload({ filesTotal: pending.length, filesDone, rowsTotal, rowsDone: filesDone, bytesRead, etaMs: 0 }));
		post("done", { rows: rowsTotal, stopped: paused, skippedFiles: allFiles.length - pending.length });
		return { ok: true, rows: rowsTotal };
	} catch (err) {
		phase = "error";
		const message = String(err?.message ?? err);
		post("error", { code: "IMPORT_FAILED", message });
		post("done", { rows: 0, stopped: true, error: message });
		return { ok: false, reason: message };
	} finally {
		running = false;
		if (phase !== "paused") phase = phase === "error" ? "error" : "done";
	}
}

async function runMigrate(payload = {}) {
	if (running) return { ok: false, reason: "busy" };
	running = true;
	phase = "migrating";
	try {
		const legacyPath = payload.legacyLedgerPath ?? cfg?.legacyLedgerPath;
		if (!legacyPath) {
			post("error", { code: "NO_LEGACY_PATH", message: "没有 v2 账本路径" });
			return { ok: false, reason: "no-path" };
		}
		const result = await migrateLegacyV2({
			store,
			rollup: null,
			legacyPath,
			sessionsRoot: cfg?.sessionsRoot,
			home: undefined,
			batchRows: 500,
			countUnpriced: true,
			onProgress: (info) => post("progress", progressPayload({ rowsTotal: info.rows ?? 0, ...info })),
			applyPrices: priceRow,
			onComplete: (summary) => post("migrated", summary),
			log,
		});
		migrated = true;
		rollupVersion += 1;
		// 迁移后把整库天桶重算一遍，ala 主线程只需 reload
		post("done", {
			rows: result.rows ?? 0,
			skipped: result.skipped ?? 0,
			unpricedRows: result.unpricedRows ?? 0,
			migrated: true,
			stopped: false,
		});
		phase = "done";
		return result;
	} catch (err) {
		phase = "error";
		post("error", { code: "MIGRATE_FAILED", message: String(err?.message ?? err) });
		post("done", { rows: 0, stopped: true, error: String(err?.message ?? err) });
		return { ok: false, reason: String(err?.message ?? err) };
	} finally {
		running = false;
	}
}

function runRecalc(payload = {}) {
	const day = String(payload.day ?? "").trim() || dayKeyOf(Date.now());
	phase = "recalc";
	try {
		const result = store.rebuildDayRollup(day);
		rollupVersion += 1;
		post("recalcDone", { day, ...result, version: rollupVersion });
		post("done", { rows: result.calls ?? 0, stopped: false, day, recalculated: true });
		phase = "done";
		return result;
	} catch (err) {
		phase = "error";
		post("error", { code: "RECALC_FAILED", message: String(err?.message ?? err) });
		return { ok: false, reason: String(err?.message ?? err) };
	}
}

parentPort?.on("message", (msg) => {
	const type = String(msg?.type ?? "");
	const payload = msg?.payload ?? {};
	switch (type) {
		case "init":
			try {
				init(payload);
			} catch (err) {
				post("error", { code: "INIT_FAILED", message: String(err?.message ?? err) });
			}
			break;
		case "start":
			void runImport();
			break;
		case "pause":
			stopFlag = "pause";
			paused = true;
			post("progress", progressPayload({}));
			break;
		case "resume":
			stopFlag = null;
			paused = false;
			if (!running) void runImport();
			break;
		case "cancel":
			stopFlag = "cancel";
			paused = false;
			post("progress", progressPayload({}));
			break;
		case "migrate":
			void runMigrate(payload);
			break;
		case "recalc":
			runRecalc(payload);
			break;
		case "shutdown":
			try {
				saveState(true);
				store?.close();
			} catch {
				/* ignore */
			}
			store = null;
			parentPort?.close();
			break;
		case "ping":
			post("progress", progressPayload({}));
			break;
		default:
			post("error", { code: "UNKNOWN_MESSAGE", message: `未知消息类型：${type}` });
	}
});

// 监护人：worker 里未捕获异常必须回传，否则主线程只能靠超时察觉
process.on("uncaughtException", (err) => {
	post("error", { code: "UNCAUGHT", message: String(err?.stack ?? err) });
});
process.on("unhandledRejection", (err) => {
	post("error", { code: "UNHANDLED", message: String(err?.stack ?? err) });
});
