/**
 * v3 状态目录与路径解析（合同 §4.1）。**唯一**允许拼账本路径的地方。
 *
 * 硬约束（合同 §一.9）：账本落在 `<host.dataDir>/plugin-data/usage-ledger/`，
 * 其中 `host.dataDir` 是 `~/.pi-web`，**不是插件目录**。一律用 `node:fs` 直写
 * （`host.fs.writePath` 会触发目录授权弹窗）。
 *
 * 目录布局（方案 §2.2.1）：
 * ```
 * <dataDir>/plugin-data/usage-ledger/
 * ├── ledger.sqlite (+ -wal / -shm)
 * ├── rollup-cache.json      天桶缓存（可重建）
 * ├── prices.json            价格表快照
 * ├── import-state.json      导入状态机（游标/进度/失败清单）
 * ├── legacy/ledger-v2.jsonl 旧账本（迁移后原样保留，只读）
 * └── backups/ledger-YYYYMMDD.sqlite
 * ```
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 插件自己的状态目录名（`plugin-data/` 下）。 */
export const LEDGER_DIRNAME = "usage-ledger";
/** 主库文件名。 */
export const DB_FILENAME = "ledger.sqlite";
/** 天桶内存快照（纯缓存，删了能重建）。 */
export const ROLLUP_CACHE_FILE = "rollup-cache.json";
/** 导入状态机（游标、进度、失败清单）。 */
export const IMPORT_STATE_FILE = "import-state.json";
/** 旧账本归档子目录。 */
export const LEGACY_DIRNAME = "legacy";
/** 旧账本归档文件名。 */
export const LEGACY_LEDGER_FILE = "ledger-v2.jsonl";
/** 备份子目录。 */
export const BACKUP_DIRNAME = "backups";
/** v2 账本文件名（在 `host.dataDir` 根下）。 */
export const V2_LEDGER_FILE = "ledger.jsonl";
/** 会话子目录名（相对 pi agent 根）。 */
export const SESSIONS_DIRNAME = "sessions";

function toStr(v) {
	if (typeof v !== "string") return null;
	const s = v.trim();
	return s ? s : null;
}

/**
 * 状态目录：`<hostDataDir>/plugin-data/usage-ledger`。
 * `opts.dataDir`（或 `opts.root`）可覆盖 dataDir 根；`opts.dirname` 可覆盖末级目录名。
 */
export function resolveStateDir(hostDataDir, opts = {}) {
	const base =
		toStr(opts.dataDir) ??
		toStr(hostDataDir) ??
		toStr(process.env.PI_WEB_DATA_DIR) ??
		join(homedir(), ".pi-web");
	const dirname = toStr(opts.dirname) ?? LEDGER_DIRNAME;
	return join(base, "plugin-data", dirname);
}

/** 状态目录下的文件名。 */
export function statePath(dir, name) {
	const d = toStr(dir) ?? "";
	const n = toStr(name) ?? "";
	if (!n) return d;
	return d ? join(d, n) : n;
}

/** 旧账本归档路径：`<dir>/legacy/ledger-v2.jsonl`。 */
export function legacyArchivePath(dir) {
	return join(statePath(dir, LEGACY_DIRNAME), LEGACY_LEDGER_FILE);
}

/** v2 遗留账本：`<hostDataDir>/ledger.jsonl`（只读迁移源）。 */
export function resolveLegacyLedgerPath(hostDataDir) {
	const base =
		toStr(hostDataDir) ?? toStr(process.env.PI_WEB_DATA_DIR) ?? join(homedir(), ".pi-web");
	return join(base, V2_LEDGER_FILE);
}

/** `~/x`、`~` 展开成家目录；其它原样返回（与 lib/sessions.mjs 语义一致）。 */
export function expandHomePath(input, home = homedir()) {
	const s = toStr(input);
	if (!s) return "";
	if (s === "~") return home;
	if (s.startsWith("~/") || s.startsWith("~\\")) return join(home, s.slice(2));
	return s;
}

/**
 * 会话根目录。解析顺序：设置项 `sessionsDir` → `$PI_CODING_AGENT_DIR/sessions` →
 * `~/.pi/agent/sessions`。非法/相对路径一律回落下一级（回填不能因为设置写错就炸）。
 * @param {{settings?:Record<string,unknown>, env?:Record<string,string|undefined>, home?:string}} [opts]
 */
export function resolveSessionsRoot(opts = {}) {
	const settings = opts.settings ?? {};
	const env = opts.env ?? {};
	const home = toStr(opts.home) ?? homedir();
	const fromSettings = expandHomePath(settings.sessionsDir, home);
	if (fromSettings && isAbsolute(fromSettings)) return { root: fromSettings, source: "setting" };
	const agentDir = expandHomePath(env.PI_CODING_AGENT_DIR, home);
	if (agentDir && isAbsolute(agentDir)) return { root: join(agentDir, SESSIONS_DIRNAME), source: "env" };
	return { root: join(home, ".pi", "agent", SESSIONS_DIRNAME), source: "default" };
}

/** 备份文件名：`ledger-YYYYMMDD.sqlite`。 */
export function backupPath(dir, nowMs = Date.now()) {
	const d = new Date(nowMs);
	const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
	return join(statePath(dir, BACKUP_DIRNAME), `ledger-${stamp}.sqlite`);
}

export default {
	LEDGER_DIRNAME,
	DB_FILENAME,
	ROLLUP_CACHE_FILE,
	IMPORT_STATE_FILE,
	LEGACY_DIRNAME,
	LEGACY_LEDGER_FILE,
	BACKUP_DIRNAME,
	V2_LEDGER_FILE,
	resolveStateDir,
	statePath,
	legacyArchivePath,
	resolveLegacyLedgerPath,
	expandHomePath,
	resolveSessionsRoot,
	backupPath,
};
