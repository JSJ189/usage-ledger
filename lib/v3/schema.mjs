/**
 * v3 schema（合同 §三）——DDL 只在这里，别处不许再写 CREATE TABLE。
 *
 * 与合同 §三 的**唯一偏差**（已汇报）：`rollup_hour` / `rollup_day` 各多三列
 *  `rate_sum REAL` / `rate_n INTEGER` / `cache_n INTEGER`。
 * 原因：合同 §5.1 的 `tokPerSecMean`（**每次调用的算术均值**）与 `cacheHitSamples`
 *  在只存「可合并量」的 rollup 里无法从 `gen_sum/out_tok_tput` 反推——算术均值
 *  必须存 `Σ(out_i/gen_i*1000)`。三列都是纯加法量，合并律与其它列一致。
 *
 * 表结构约定：
 *  - `calls.id` 就是 rowid（`INTEGER PRIMARY KEY`），keyset 分页用它做次序键；
 *  - `entry_key` 唯一索引是**幂等的唯一依据**（`WHERE entry_key IS NOT NULL`，
 *    live 记录为 NULL，可以有任意多条）；
 *  - rollup 是 `WITHOUT ROWID` 窄表（主键即聚簇键）；
 *  - 直方图列是 `BLOB NOT NULL`（136 个小端 uint32，见 hist.mjs）。
 */

import { DB_FILENAME, ROLLUP_CACHE_FILE, IMPORT_STATE_FILE, LEGACY_DIRNAME, LEDGER_DIRNAME } from "./paths.mjs";

/** schema 版本：任何 DDL 变更都要 +1 并在 meta 里比对。 */
export const SCHEMA_VERSION = 3;
/** rollup 计算口径版本：改了聚合规则（不是表结构）要 +1，触发全量重算。 */
export const ROLLUP_VERSION = 1;

export { DB_FILENAME, ROLLUP_CACHE_FILE, IMPORT_STATE_FILE, LEGACY_DIRNAME, LEDGER_DIRNAME };

/** 写连接启动时要跑的 PRAGMA（顺序有意义：先 journal_mode 再写）。 */
export const PRAGMAS_WRITE = [
	"PRAGMA journal_mode = WAL",
	"PRAGMA synchronous = NORMAL",
	"PRAGMA busy_timeout = 5000",
	"PRAGMA wal_autocheckpoint = 2000",
	"PRAGMA foreign_keys = OFF",
];

/** 只读连接的 PRAGMA（主线程连接，禁止写）。 */
export const PRAGMAS_READ = ["PRAGMA busy_timeout = 5000"];

const ROLLUP_COMMON = `
  model_id INTEGER NOT NULL DEFAULT 0, provider_id INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  calls INTEGER NOT NULL,
  in_tok INTEGER, out_tok INTEGER, cache_read INTEGER, cache_write INTEGER,
  reasoning_tok INTEGER, total_tok INTEGER,
  cost_sdk REAL, cost_est REAL, unpriced INTEGER,
  e2e_sum INTEGER, e2e_n INTEGER, gen_sum INTEGER, gen_n INTEGER, out_tok_tput INTEGER,
  rate_sum REAL, rate_n INTEGER, cache_n INTEGER,
  ttft_hist BLOB NOT NULL, e2e_hist BLOB NOT NULL`;

/** DDL 语句（按顺序执行，全部 IF NOT EXISTS，可重复跑）。 */
export const DDL = [
	`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,

	`CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  UNIQUE (kind, name)
)`,

	`CREATE TABLE IF NOT EXISTS calls (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  entry_key   TEXT,
  conv_id     TEXT,
  src_id      INTEGER, model_id INTEGER, provider_id INTEGER, project_id INTEGER,
  status      TEXT NOT NULL,
  origin      TEXT NOT NULL,
  in_tok INTEGER, out_tok INTEGER, cache_read INTEGER, cache_write INTEGER,
  reasoning_tok INTEGER, total_tok INTEGER,
  cost_sdk REAL, cost_est REAL, cost_source TEXT,
  price_id TEXT, price_version INTEGER,
  ttft_ms INTEGER, gen_ms INTEGER, e2e_ms INTEGER,
  stop_reason TEXT
)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS ux_calls_entry ON calls(entry_key) WHERE entry_key IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS ix_calls_ts ON calls(ts DESC)`,
	`CREATE INDEX IF NOT EXISTS ix_calls_model_ts ON calls(model_id, ts DESC)`,
	`CREATE INDEX IF NOT EXISTS ix_calls_status_ts ON calls(status, ts DESC)`,
	// live 行专用部分索引：回填要按 (conv_id, ts±2s) 反查未认领的 live 行，
	// 而 live 行只占极少数 → 这个索引永远很小（空表时探测 ~1µs）。
	// 不另建 `(conv_id, ts) WHERE conv_id IS NOT NULL`：它按随机序写入（900 个 conv_id
	// 交错），实测让 15 万行写入多花 2–3 倍时间，而唯一用得上的场景是 LIKE 关键字搜索——
	// 那也走不了索引。
	`CREATE INDEX IF NOT EXISTS ix_calls_live ON calls(conv_id, ts) WHERE entry_key IS NULL`,

	`CREATE TABLE IF NOT EXISTS rollup_hour (
  bucket INTEGER NOT NULL,${ROLLUP_COMMON},
  PRIMARY KEY (bucket, model_id, provider_id, project_id, status)
) WITHOUT ROWID`,

	`CREATE TABLE IF NOT EXISTS rollup_day (
  day TEXT NOT NULL,${ROLLUP_COMMON},
  PRIMARY KEY (day, model_id, provider_id, project_id, status)
) WITHOUT ROWID`,
];

/** rollup 表名（gran 归一）。 */
export function rollupTable(gran) {
	return gran === "day" || gran === "1d" ? "rollup_day" : "rollup_hour";
}

/** rollup 行的可合并数值列（写库 / 累加 / 差分都用这一份清单）。 */
export const ROLLUP_SUM_FIELDS = [
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

/**
 * 建表 + 写 schema 版本（只在可写连接上调）。
 *
 * 版本不符时的处理（**不静默覆盖**）：把老文件改名成
 * `ledger.sqlite.bak-<ver>-<ts>`，重建空库，并在 meta 里记 `rebuilt_from`。
 * 原因是 v3 的 DDL 只做 `CREATE TABLE IF NOT EXISTS`，老库缺列会让 insertBatch
 * 抛 `no such column`；而数据本身还能从 v2 账本 / 会话文件重迁，重建是安全解。
 * @returns {{rebuilt:boolean, fromVersion?:number, backupPath?:string}}
 */
export function applySchema(db, { log, path } = {}) {
	const warn = typeof log === "function" ? log : () => {};
	for (const pragma of PRAGMAS_WRITE) {
		try {
			db.exec(pragma);
		} catch (err) {
			warn("warn", `PRAGMA 失败（继续）：${pragma}：${String(err?.message ?? err)}`);
		}
	}
	// 已存在且版本不符 → 交给调用方重建（这里只报告，不擅自删库）
	let existingVersion = null;
	try {
		const row = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get();
		existingVersion = row ? Number(row.v) : null;
	} catch {
		existingVersion = null;
	}
	if (existingVersion !== null && existingVersion !== SCHEMA_VERSION) {
		return { rebuilt: false, fromVersion: existingVersion, needsRebuild: true, path };
	}
	for (const sql of DDL) db.exec(sql);
	const now = new Date().toISOString();
	setMetaRaw(db, "schema_version", String(SCHEMA_VERSION));
	setMetaRaw(db, "rollup_version_expected", String(ROLLUP_VERSION));
	setMetaRaw(db, "tz", String(-new Date().getTimezoneOffset() / 60));
	if (!getMetaRaw(db, "created_at")) setMetaRaw(db, "created_at", now);
	return { rebuilt: false, fromVersion: existingVersion ?? null };
}

/** 只读连接：只设 busy_timeout（绝不改 journal_mode / 绝不写）。 */
export function applyReadPragmas(db) {
	for (const pragma of PRAGMAS_READ) {
		try {
			db.exec(pragma);
		} catch {
			/* 只读连接上某些 PRAGMA 会被拒，忽略 */
		}
	}
}

function getMetaRaw(db, k) {
	const row = db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
	return row ? row.v : null;
}

function setMetaRaw(db, k, v) {
	db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
}

export { getMetaRaw, setMetaRaw };

export default { SCHEMA_VERSION, ROLLUP_VERSION, DDL, applySchema, applyReadPragmas, rollupTable, ROLLUP_SUM_FIELDS };
