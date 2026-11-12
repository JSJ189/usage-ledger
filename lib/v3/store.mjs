/**
 * v3 存储层：`node:sqlite` 的 `DatabaseSync`（**没有** ORM、没有异步驱动）。
 *
 * 连接模型（合同 §一.4 / §4.3）：
 *  - 主线程开 `openStore({dir})`（可写，用于 live 记录）或 `openStore({dir, readOnly:true})`
 *    （纯读：overview / records / export）；
 *  - worker 独占一个可写连接，**所有**导入写都在它里面、单事务 ≤2000 行；
 *  - 建库即 `PRAGMA journal_mode=WAL` + `busy_timeout=5000`，读写不互相阻塞。
 *
 * 写路径的语义（合同 §4.9 + 方案 §2.3.2）：
 * 1. 明细行按 §4.9 形状传入，`model/provider/project/src` 自动转 `refs.id`；
 * 2. `entryKey` 唯一索引 + `ON CONFLICT(entry_key) WHERE entry_key IS NOT NULL DO UPDATE`
 *    = 幂等（同一会话重复导入不重复计账）；
 * 3. 回填行若带 `convId`，会按 `(convId, ts±2s, modelId)` 反查**未认领的 live 行**并就地
 *    补字段（`origin='both'`），认领失败就各留一条（宁多不少）；
 * 4. 同一事务内同时维护 `rollup_hour` 与 `rollup_day`，并把本次的 delta 以 §4.9 形状
 *    返回（`{ rows, delta }`），worker 再 postMessage 给主线程。
 */
import { mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BINS, binOf, emptyHist, encodeHist, mergeHistInto } from "./hist.mjs";
import { dayKeyOf, dayKeyToMs, hourStart, normalizeFilter, normalizeRollupRow, statusClass } from "./metrics.mjs";
import { deriveEntryKey } from "./parser.mjs";
import {
	DB_FILENAME,
	SCHEMA_VERSION,
	applyReadPragmas,
	applySchema,
	getMetaRaw,
	rollupTable,
	setMetaRaw,
} from "./schema.mjs";

export { SCHEMA_VERSION };

/** 单事务最大行数（合同 §一.4）。 */
export const MAX_BATCH_ROWS = 2000;
/** live ↔ 回填认领的时间窗（毫秒）。 */
export const LINK_WINDOW_MS = 2000;
/** live/回填去重的 ts 双侧放宽（毫秒）。 */
export const DEDUP_PAD_MS = 5000;
/** `total` 缓存 TTL。 */
export const TOTAL_CACHE_TTL_MS = 30_000;

/** refs.kind 白名单。 */
export const REF_KINDS = ["model", "provider", "project", "source"];

/** rollup 数值列：JS 字段名 → DB 列名（唯一一份，写库/合并都用它）。 */
export const ROLLUP_COLUMNS = [
	["calls", "calls"],
	["inTok", "in_tok"],
	["outTok", "out_tok"],
	["cacheRead", "cache_read"],
	["cacheWrite", "cache_write"],
	["reasoningTok", "reasoning_tok"],
	["totalTok", "total_tok"],
	["costSdk", "cost_sdk"],
	["costEst", "cost_est"],
	["unpriced", "unpriced"],
	["e2eSum", "e2e_sum"],
	["e2eN", "e2e_n"],
	["genSum", "gen_sum"],
	["genN", "gen_n"],
	["outTokTput", "out_tok_tput"],
	["rateSum", "rate_sum"],
	["rateN", "rate_n"],
	["cacheN", "cache_n"],
];

const HOUR_COLS = ROLLUP_COLUMNS.map(([, col]) => col).join(", ");
const HOUR_SLOTS = ROLLUP_COLUMNS.map(() => "?").join(", ");

function toNum(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function toInt(v) {
	const n = toNum(v);
	return n === null ? null : Math.round(n);
}

function toStr(v) {
	if (typeof v !== "string") return null;
	const s = v.trim();
	return s ? s : null;
}

/**
 * 拆 `entryKey`。形状是 `<tag>:<srcName>:<entryId>`，`tag` 由**解析层**决定
 * （当前 `s:`，见 `parser.deriveEntryKey`），所以这里不敢硬编码前缀：
 * 前缀一改，迁移与会话重导入就会得到两个不同 key → **同一次调用被计两次**。
 * Windows 绝对路径本身含冒号 → 中间段用贪婪匹配 + 最后一个冒号切分。
 */
export function splitEntryKey(entryKey) {
	const key = toStr(entryKey);
	if (!key) return null;
	const m = /^([A-Za-z]+):(.*):([^:]+)$/.exec(key);
	if (!m) return null;
	return { tag: m[1], src: m[2] || null, id: m[3] || null };
}

/** `entryKey` 里的会话文件（相对会话根）路径。 */
export function srcNameFromEntryKey(entryKey) {
	const parts = splitEntryKey(entryKey);
	return parts ? parts.src : null;
}

/** `entryKey` 里的会话行 id。 */
export function entryIdFromEntryKey(entryKey) {
	const parts = splitEntryKey(entryKey);
	return parts ? parts.id : null;
}

/**
 * 造 `entryKey`：**必须**和解析层同源（`parser.deriveEntryKey`）。
 * 解析层没导出时退化成 `e:` 前缀的老形状（只在极端情况下走到）。
 */
export function makeEntryKey(srcName, entryId) {
	const id = toStr(entryId);
	if (!id) return null;
	const src = toStr(srcName) ?? "-";
	if (typeof deriveEntryKey === "function") return deriveEntryKey(src, id, 0);
	return `e:${src}:${id}`;
}

// ──────────────────────────────────────────────────────── 行 → 可合并量

/** 单条明细行的「可合并量」（rollup delta 的原子单位）。 */
function aggregateOfRow(row) {
	const genMs = toNum(row.genMs);
	const outTok = toNum(row.outTok) ?? 0;
	const e2eMs = toNum(row.e2eMs);
	const costSource = row.costSource;
	const agg = {
		bucket: null,
		modelId: row.modelId ?? 0,
		providerId: row.providerId ?? 0,
		projectId: row.projectId ?? 0,
		model: row.model ?? null,
		provider: row.provider ?? null,
		project: row.project ?? null,
		status: statusClass(row.status),
		calls: 1,
		inTok: toNum(row.inTok) ?? 0,
		outTok,
		cacheRead: toNum(row.cacheRead) ?? 0,
		cacheWrite: toNum(row.cacheWrite) ?? 0,
		reasoningTok: toNum(row.reasoningTok) ?? 0,
		totalTok: toNum(row.totalTok) ?? 0,
		costSdk: costSource === "sdk" ? toNum(row.costSdk) ?? 0 : 0,
		costEst: costSource === "estimate" ? toNum(row.costEst) ?? 0 : 0,
		unpriced: costSource === "unpriced" || costSource === null ? 1 : 0,
		e2eSum: e2eMs !== null && e2eMs > 0 ? e2eMs : 0,
		e2eN: e2eMs !== null && e2eMs > 0 ? 1 : 0,
		genSum: genMs !== null && genMs > 0 ? genMs : 0,
		genN: genMs !== null && genMs > 0 ? 1 : 0,
		outTokTput: genMs !== null && genMs > 0 && outTok > 0 ? outTok : 0,
		rateSum: genMs !== null && genMs > 0 && outTok > 0 ? outTok / (genMs / 1000) : 0,
		rateN: genMs !== null && genMs > 0 && outTok > 0 ? 1 : 0,
		cacheN: row.cacheRead !== null || row.cacheWrite !== null ? 1 : 0,
		ttftBin: -1,
		e2eBin: -1,
	};
	// 直接算桶号：早先的实现给**每一行**分配两张 Uint32Array(136)（544B×2）再找非零桶，
	// 15 万行就是 30 万次分配 / 163MB 垃圾，GC 吃掉的时间比 SQLite 本身还多。
	const ttft = toNum(row.ttftMs);
	if (ttft !== null && ttft > 0) agg.ttftBin = binOf(ttft);
	if (e2eMs !== null && e2eMs > 0) agg.e2eBin = binOf(e2eMs);
	return agg;
}

/** delta 累加器里的一行（直方图用 Int32，允许负数 = 撤销）。 */
function emptyDeltaRow(bucket, agg) {
	return {
		bucket,
		modelId: agg.modelId,
		providerId: agg.providerId,
		projectId: agg.projectId,
		model: agg.model,
		provider: agg.provider,
		project: agg.project,
		status: agg.status,
		calls: 0,
		inTok: 0,
		outTok: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoningTok: 0,
		totalTok: 0,
		costSdk: 0,
		costEst: 0,
		unpriced: 0,
		e2eSum: 0,
		e2eN: 0,
		genSum: 0,
		genN: 0,
		outTokTput: 0,
		rateSum: 0,
		rateN: 0,
		cacheN: 0,
		ttftHist: new Int32Array(BINS),
		e2eHist: new Int32Array(BINS),
	};
}

function applyAggToDelta(target, agg, sign) {
	for (let i = 0; i < ROLLUP_COLUMNS.length; i++) {
		const field = ROLLUP_COLUMNS[i][0];
		const v = agg[field];
		if (v) target[field] += sign * v;
	}
	if (agg.ttftBin >= 0) target.ttftHist[agg.ttftBin] += sign;
	if (agg.e2eBin >= 0) target.e2eHist[agg.e2eBin] += sign;
	return target;
}

function deltaKeyOf(bucket, agg) {
	return `${bucket}|${agg.modelId}|${agg.providerId}|${agg.projectId}|${agg.status}`;
}

// ──────────────────────────────────────────────────────── Store

/**
 * 打开（或创建）账本库。失败直接抛错，由调用方降级（合同 §4.3）。
 * @param {{dir?:string, readOnly?:boolean, log?:Function, path?:string}} opts
 */
export function openStore(opts = {}) {
	const dir = toStr(opts.dir) ?? "";
	const readOnly = opts.readOnly === true;
	const log = typeof opts.log === "function" ? opts.log : () => {};
	const path = toStr(opts.path) ?? (dir ? join(dir, DB_FILENAME) : ":memory:");
	if (dir && !readOnly) {
		// 目录由 node:fs 直建（不走 host.fs.writePath，避免授权弹窗）
		mkdirSync(dir, { recursive: true });
	}
	let db = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
	if (readOnly) applyReadPragmas(db);
	else {
		const applied = applySchema(db, { log, path });
		if (applied?.needsRebuild) {
			// 老库版本不符：改名留档 → 重建空库（数据可从 v2 账本 / 会话文件重迁）
			const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
			const backupPath = `${path}.bak-v${applied.fromVersion}-${stamp}`;
			try {
				db.close();
			} catch {
				/* ignore */
			}
			renameSync(path, backupPath);
			for (const suffix of ["-wal", "-shm"]) {
				try {
					renameSync(`${path}${suffix}`, `${backupPath}${suffix}`);
				} catch {
					/* 没有就算了 */
				}
			}
			db = new DatabaseSync(path, {});
			applySchema(db, { log, path });
			setMetaRaw(db, "rebuilt_from", `${backupPath} (schema v${applied.fromVersion} → v${SCHEMA_VERSION})`);
			log("warn", `账本库 schema 版本不符（v${applied.fromVersion} → v${SCHEMA_VERSION}），已备份为 ${backupPath} 并重建空库`);
		}
	}
	return createStoreApi({ db, path, dir, readOnly, log });
}

function createStoreApi({ db, path, dir, readOnly, log }) {
	const warn = typeof log === "function" ? log : () => {};
	const refCache = new Map();
	const refById = new Map();
	for (const kind of REF_KINDS) {
		refCache.set(kind, new Map());
		refById.set(kind, new Map());
	}
	let closed = false;

	const C = {
		selMeta: db.prepare("SELECT v FROM meta WHERE k = ?"),
		selRef: db.prepare("SELECT id FROM refs WHERE kind = ? AND name = ?"),
		insRef: db.prepare("INSERT INTO refs(kind, name) VALUES(?, ?)"),
		selRefName: db.prepare("SELECT name FROM refs WHERE id = ?"),
		selRefList: db.prepare("SELECT name FROM refs WHERE kind = ? ORDER BY name"),
		selRefAll: db.prepare("SELECT id, name FROM refs WHERE kind = ?"),
	};

	let W = null; // 写语句只在可写连接上准备
	if (!readOnly) {
		W = {
			selByEntry: db.prepare("SELECT * FROM calls WHERE entry_key = ?"),
			selById: db.prepare("SELECT * FROM calls WHERE id = ?"),
			// 部分索引 ix_calls_live 只含 live 行（entry_key IS NULL）→ 命中范围极小
			selLiveCandidate: db.prepare(
				`SELECT * FROM calls
				 WHERE conv_id = ? AND entry_key IS NULL AND ts BETWEEN ? AND ?
				 ORDER BY ts LIMIT 8`,
			),
			insCall: db.prepare(
				`INSERT INTO calls(ts, entry_key, conv_id, src_id, model_id, provider_id, project_id,
				   status, origin, in_tok, out_tok, cache_read, cache_write, reasoning_tok, total_tok,
				   cost_sdk, cost_est, cost_source, price_id, price_version, ttft_ms, gen_ms, e2e_ms, stop_reason)
				 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT(entry_key) WHERE entry_key IS NOT NULL DO NOTHING`,
			),
			updCall: db.prepare(
				`UPDATE calls SET ts = ?, entry_key = ?, conv_id = ?, src_id = ?, model_id = ?, provider_id = ?,
				   project_id = ?, status = ?, origin = ?, in_tok = ?, out_tok = ?, cache_read = ?, cache_write = ?,
				   reasoning_tok = ?, total_tok = ?, cost_sdk = ?, cost_est = ?, cost_source = ?, price_id = ?,
				   price_version = ?, ttft_ms = ?, gen_ms = ?, e2e_ms = ?, stop_reason = ?
				 WHERE id = ?`,
			),
			delHourRange: db.prepare("DELETE FROM rollup_hour WHERE bucket >= ? AND bucket <= ?"),
			// live/backfill 去重：按 (conv, model, ts 区间) 找**未认领的 live 行**
			selLiveForDedup: db.prepare(
				`SELECT * FROM calls
				  WHERE origin = 'live' AND entry_key IS NULL
				    AND conv_id = ? AND model_id = ? AND ts BETWEEN ? AND ?`,
			),
			delById: db.prepare("DELETE FROM calls WHERE id = ?"),
			delRollupDay: db.prepare("DELETE FROM rollup_day WHERE day = ?"),
		};
	}

	function assertWritable(what) {
		if (readOnly) throw new Error(`只读连接不能执行 ${what}`);
		if (closed) throw new Error("连接已关闭");
	}

	// ── meta ──
	function metaGet(k) {
		const row = C.selMeta.get(String(k));
		return row ? row.v : null;
	}

	function metaSet(k, v) {
		assertWritable("metaSet");
		setMetaRaw(db, String(k), v);
		return v;
	}

	// ── refs ──
	function refId(kind, name) {
		const k = String(kind ?? "").trim();
		if (!REF_KINDS.includes(k)) throw new Error(`未知 refs.kind：${k}`);
		const clean = toStr(name);
		if (!clean) return 0; // 0 = 未知（rollup 的 DEFAULT 0 与它对齐）
		const cache = refCache.get(k);
		const hit = cache.get(clean);
		if (hit !== undefined) return hit;
		const row = C.selRef.get(k, clean);
		if (row) {
			cache.set(clean, row.id);
			refById.get(k).set(row.id, clean);
			return row.id;
		}
		assertWritable(`refs 新增（${k}:${clean}）`);
		const res = C.insRef.run(k, clean);
		const id = Number(res.lastInsertRowid);
		cache.set(clean, id);
		refById.get(k).set(id, clean);
		return id;
	}

	function refName(kind, id) {
		const n = toNum(id);
		if (n === null || n === 0) return null;
		const k = String(kind ?? "").trim();
		const rev = refById.get(k);
		const hit = rev ? rev.get(n) : undefined;
		if (hit !== undefined) return hit;
		const row = C.selRefName.get(n);
		if (row) {
			if (rev) rev.set(n, row.name);
			const fwd = refCache.get(k);
			if (fwd && !fwd.has(row.name)) fwd.set(row.name, n);
			return row.name;
		}
		return null;
	}

	function refList(kind) {
		const out = [];
		for (const row of C.selRefList.all(String(kind ?? "").trim())) out.push(row.name);
		return out;
	}

	/** 预载 refs 字典（启动时一次，避免逐行查库）。 */
	function refWarm() {
		for (const kind of REF_KINDS) {
			const cache = refCache.get(kind);
			const rev = refById.get(kind);
			for (const row of C.selRefAll.all(kind)) {
				cache.set(row.name, row.id);
				rev.set(row.id, row.name);
			}
		}
	}

	// ── rollup 读写 ──
	function rollupInsertSql(gran) {
		if (gran === "day" || gran === "1d") {
			return `INSERT INTO rollup_day(day, model_id, provider_id, project_id, status, ${HOUR_COLS}, ttft_hist, e2e_hist) VALUES(?,?,?,?,?,${HOUR_SLOTS},?,?)`;
		}
		return `INSERT INTO rollup_hour(bucket, model_id, provider_id, project_id, status, ${HOUR_COLS}, ttft_hist, e2e_hist) VALUES(?,?,?,?,?,${HOUR_SLOTS},?,?)`;
	}

	/**
	 * 已有行走 `UPDATE`（就地改写），**不能**用 `INSERT OR REPLACE`：replace 是
	 * delete+insert，会留下墓碑让 B-tree 碎片化——实测 12k 行 rollup 涨到 54MB（4.5KB/行）。
	 */
	function rollupUpdateSql(gran) {
		const sets = ROLLUP_COLUMNS.map(([, col]) => `${col} = ?`).join(", ");
		if (gran === "day" || gran === "1d") {
			return `UPDATE rollup_day SET ${sets}, ttft_hist = ?, e2e_hist = ?
			 WHERE day = ? AND model_id = ? AND provider_id = ? AND project_id = ? AND status = ?`;
		}
		return `UPDATE rollup_hour SET ${sets}, ttft_hist = ?, e2e_hist = ?
		 WHERE bucket = ? AND model_id = ? AND provider_id = ? AND project_id = ? AND status = ?`;
	}

	const rollupStmt = new Map();
	function stmtsFor(gran) {
		const key = gran === "day" || gran === "1d" ? "day" : "hour";
		let entry = rollupStmt.get(key);
		if (entry) return entry;
		const table = rollupTable(key);
		const pkCol = key === "day" ? "day" : "bucket";
		entry = {
			ins: db.prepare(rollupInsertSql(key)),
			upd: db.prepare(rollupUpdateSql(key)),
			// 读已有行（含两张直方图），用于读-改-写合并
			sel: db.prepare(
				`SELECT ${pkCol} AS bucket, model_id, provider_id, project_id, status, ${HOUR_COLS},
				   ttft_hist, e2e_hist
				 FROM ${table} WHERE ${pkCol} = ? AND model_id = ? AND provider_id = ? AND project_id = ? AND status = ?`,
			),
			selRange: db.prepare(
				`SELECT ${pkCol} AS bucket, model_id, provider_id, project_id, status, ${HOUR_COLS},
				   ttft_hist, e2e_hist
				 FROM ${table} WHERE ${pkCol} >= ? AND ${pkCol} <= ?`,
			),
			table,
			pkCol,
		};
		rollupStmt.set(key, entry);
		return entry;
	}

	// ── rollup 读缓存（只在一次事务内有效）────────────────────────────────
	// 15 万行导入时逐行 SELECT 是主要开销之一：把整批要动的桶一次性读进来，
	// 之后同键的 delta 直接在内存里累加，只留 INSERT/UPDATE。
	let prefetch = new Map();

	function pfKeyOf(gran, row) {
		return `${gran}|${gran === "day" ? row.bucket : row.bucket}|${row.modelId}|${row.providerId}|${row.projectId}|${row.status}`;
	}

	function clearPrefetch() {
		prefetch = new Map();
	}

	/** 预读这批 delta 会碰到的桶（跨度太大就放弃，退回逐行 SELECT）。 */
	function prefetchRollup(map, gran) {
		if (!map || !map.size) return 0;
		const stmts = stmtsFor(gran);
		let min = null;
		let max = null;
		const isDay = gran === "day" || gran === "1d";
		for (const row of map.values()) {
			const b = row.bucket;
			if (b === null || b === undefined || b === "") continue;
			if (min === null || b < min) min = b;
			if (max === null || b > max) max = b;
		}
		if (min === null) return 0;
		if (isDay) {
			// 天桶键是 'YYYY-MM-DD'，跨度大就逐行读
			if (map.size > 400) return 0;
		} else if ((max - min) / 3_600_000 > 72) {
			return 0;
		}
		let loaded = 0;
		for (const raw of stmts.selRange.all(min, max)) {
			const norm = normalizeRollupRow(raw);
			if (!norm) continue;
			prefetch.set(pfKeyOf(gran, norm), norm);
			loaded++;
		}
		// 范围内的缺失键也要记住「确实不存在」，避免逐行再查一遍
		for (const row of map.values()) {
			const key = pfKeyOf(gran, row);
			if (!prefetch.has(key)) prefetch.set(key, null);
		}
		return loaded;
	}

	/** 把一行 delta 合并进库（读-改-写，绝对老值 + delta）。 */
	function applyRollupDelta(gran, delta) {
		const norm = normalizeRollupRow(delta);
		if (!norm || norm.bucket === null || norm.bucket === undefined || norm.bucket === "") return false;
		const granKey = gran === "day" || gran === "1d" ? "day" : "hour";
		const { ins, upd, sel } = stmtsFor(granKey);
		const cacheKey = pfKeyOf(granKey, norm);
		let existing;
		if (prefetch.has(cacheKey)) {
			existing = prefetch.get(cacheKey);
		} else {
			const raw = sel.get(norm.bucket, norm.modelId, norm.providerId, norm.projectId, norm.status);
			existing = raw ? normalizeRollupRow(raw) : null;
			prefetch.set(cacheKey, existing);
		}
		const base = existing ?? { ...emptyRollupValues(), ttftHist: emptyHist(), e2eHist: emptyHist() };
		for (let i = 0; i < ROLLUP_COLUMNS.length; i++) {
			const field = ROLLUP_COLUMNS[i][0];
			base[field] = (base[field] ?? 0) + (norm[field] ?? 0);
		}
		mergeHistInto(base.ttftHist, norm.ttftHist);
		mergeHistInto(base.e2eHist, norm.e2eHist);
		const values = [];
		for (let i = 0; i < ROLLUP_COLUMNS.length; i++) values.push(base[ROLLUP_COLUMNS[i][0]] ?? 0);
		values.push(encodeHist(base.ttftHist), encodeHist(base.e2eHist));
		if (existing) {
			upd.run(...values, norm.bucket, norm.modelId, norm.providerId, norm.projectId, norm.status);
		} else {
			ins.run(norm.bucket, norm.modelId, norm.providerId, norm.projectId, norm.status, ...values);
		}
		// 缓存里换成「写完后的绝对值」，同批后续 delta 继续在它上面累加
		base.bucket = norm.bucket;
		base.modelId = norm.modelId;
		base.providerId = norm.providerId;
		base.projectId = norm.projectId;
		base.status = norm.status;
		prefetch.set(cacheKey, base);
		return true;
	}

	/**
	 * live / 回填去重（合同新增口径）：**回填为准**。
	 * 同一 conv 同模型、±5s 窗口内还活着的 live 行（`entry_key IS NULL`）直接删掉，
	 * 并把它们的 rollup 影响从本批 delta 里减掉（保证 Σrollup === Σ明细）。
	 */
	function dedupLiveRows(hourMap, dayMap, groups) {
		if (!groups || !groups.size) return 0;
		let removed = 0;
		for (const g of groups.values()) {
			const from = g.minTs - DEDUP_PAD_MS;
			const to = g.maxTs + DEDUP_PAD_MS;
			const lives = W.selLiveForDedup.all(g.convId, g.modelId, from, to);
			for (let i = 0; i < lives.length; i++) {
				const row = lives[i];
				addToDeltaMaps(hourMap, dayMap, { ...existingRowView(row), id: row.id }, -1);
				W.delById.run(row.id);
				removed++;
			}
		}
		if (removed) {
			bumpCounters(-removed, null, null);
			const prev = Number(metaGet("dedup_live_rows") ?? "0") || 0;
			setMetaRaw(db, "dedup_live_rows", String(prev + removed));
		}
		return removed;
	}


	function emptyRollupValues() {
		const out = {};
		for (let i = 0; i < ROLLUP_COLUMNS.length; i++) out[ROLLUP_COLUMNS[i][0]] = 0;
		return out;
	}

	/**
	 * 明细行归一 + refs 解析（返回可直接写库的形状）。
	 */
	function prepareRow(raw) {
		if (!raw || typeof raw !== "object") return null;
		const ts = toInt(raw.ts);
		if (ts === null) return null;
		let entryKey = toStr(raw.entryKey);
		const srcName = toStr(raw.src) ?? toStr(raw.sessionFile) ?? srcNameFromEntryKey(entryKey);
		if (!entryKey) entryKey = makeEntryKey(srcName, raw.entryId);
		const origin = raw.origin === "live" || raw.origin === "both" ? raw.origin : entryKey ? "backfill" : "live";
		const e2eMs = toInt(raw.e2eMs);
		const ttftMs = toInt(raw.ttftMs);
		let genMs = toInt(raw.genMs);
		if (genMs === null && e2eMs !== null) {
			genMs = ttftMs !== null && e2eMs > ttftMs ? e2eMs - ttftMs : e2eMs;
		}
		const costSdk = toNum(raw.costSdk);
		const costEst = toNum(raw.costEst);
		let costSource = toStr(raw.costSource);
		if (costSource === "sdk" && costSdk === null) costSource = null;
		if (costSource === "estimate" && costEst === null) costSource = null;
		if (!costSource) {
			if (costSdk !== null && costSdk > 0) costSource = "sdk";
			else if (costEst !== null) costSource = "estimate";
			else costSource = "unpriced";
		}
		return {
			ts,
			entryKey,
			convId: toStr(raw.convId) ?? toStr(raw.conversationId),
			srcName,
			model: toStr(raw.model),
			provider: toStr(raw.provider),
			project: toStr(raw.project) ?? toStr(raw.projectDir),
			status: statusClass(raw.status),
			origin,
			inTok: toInt(raw.inTok) ?? toInt(raw.inputTokens),
			outTok: toInt(raw.outTok) ?? toInt(raw.outputTokens),
			cacheRead: toInt(raw.cacheRead) ?? toInt(raw.cacheReadTokens),
			cacheWrite: toInt(raw.cacheWrite) ?? toInt(raw.cacheWriteTokens),
			reasoningTok: toInt(raw.reasoningTok) ?? toInt(raw.reasoningTokens),
			totalTok: toInt(raw.totalTok) ?? toInt(raw.totalTokens),
			costSdk,
			costEst,
			costSource,
			priceId: toStr(raw.priceId),
			priceVersion: toInt(raw.priceVersion),
			ttftMs,
			genMs,
			e2eMs,
			stopReason: toStr(raw.stopReason),
		};
	}

	function dbRowOf(row) {
		// 写库前把名字转成 refs.id（未知 → null，rollup 侧按 0 归并）
		return {
			ts: row.ts,
			entryKey: row.entryKey,
			convId: row.convId,
			srcId: row.srcName ? refId("source", row.srcName) : null,
			modelId: row.model ? refId("model", row.model) : null,
			providerId: row.provider ? refId("provider", row.provider) : null,
			projectId: row.project ? refId("project", row.project) : null,
			status: row.status,
			origin: row.origin,
			inTok: row.inTok,
			outTok: row.outTok,
			cacheRead: row.cacheRead,
			cacheWrite: row.cacheWrite,
			reasoningTok: row.reasoningTok,
			totalTok: row.totalTok,
			costSdk: row.costSdk,
			costEst: row.costEst,
			costSource: row.costSource,
			priceId: row.priceId,
			priceVersion: row.priceVersion,
			ttftMs: row.ttftMs,
			genMs: row.genMs,
			e2eMs: row.e2eMs,
			stopReason: row.stopReason,
			model: row.model,
			provider: row.provider,
			project: row.project,
			srcName: row.srcName,
		};
	}

	function callArgsOf(r) {
		return [
			r.ts,
			r.entryKey ?? null,
			r.convId ?? null,
			r.srcId ?? null,
			r.modelId ?? null,
			r.providerId ?? null,
			r.projectId ?? null,
			r.status,
			r.origin,
			r.inTok ?? null,
			r.outTok ?? null,
			r.cacheRead ?? null,
			r.cacheWrite ?? null,
			r.reasoningTok ?? null,
			r.totalTok ?? null,
			r.costSdk ?? null,
			r.costEst ?? null,
			r.costSource ?? null,
			r.priceId ?? null,
			r.priceVersion ?? null,
			r.ttftMs ?? null,
			r.genMs ?? null,
			r.e2eMs ?? null,
			r.stopReason ?? null,
		];
	}

	function existingRowView(row) {
		// 库里读出的行 → prepareRow 认得的形状（含 refs 名字，供 rollup delta 用）
		if (!row) return null;
		return {
			ts: row.ts,
			entryKey: row.entry_key,
			convId: row.conv_id,
			srcName: refName("source", row.src_id),
			model: refName("model", row.model_id),
			provider: refName("provider", row.provider_id),
			project: refName("project", row.project_id),
			status: row.status,
			origin: row.origin,
			inTok: row.in_tok,
			outTok: row.out_tok,
			cacheRead: row.cache_read,
			cacheWrite: row.cache_write,
			reasoningTok: row.reasoning_tok,
			totalTok: row.total_tok,
			costSdk: row.cost_sdk,
			costEst: row.cost_est,
			costSource: row.cost_source,
			priceId: row.price_id,
			priceVersion: row.price_version,
			ttftMs: row.ttft_ms,
			genMs: row.gen_ms,
			e2eMs: row.e2e_ms,
			stopReason: row.stop_reason,
			modelId: row.model_id ?? 0,
			providerId: row.provider_id ?? 0,
			projectId: row.project_id ?? 0,
		};
	}

	function addToDeltaMaps(hourMap, dayMap, dbRow, sign) {
		const agg = aggregateOfRow(dbRow);
		const dayKey = dayKeyOf(dbRow.ts);
		const hourBucket = hourStart(dbRow.ts);
		for (const [map, bucket] of [
			[hourMap, hourBucket],
			[dayMap, dayKey],
		]) {
			const key = deltaKeyOf(bucket, agg);
			let target = map.get(key);
			if (!target) {
				target = emptyDeltaRow(bucket, agg);
				map.set(key, target);
			}
			applyAggToDelta(target, agg, sign);
		}
	}

	/**
	 * 批量写明细 + rollup（单事务，≤2000 行/事务）。
	 * @returns {{rows:number, inserted:number, updated:number, skipped:number, delta:object[]}}
	 */
	function insertBatch(rows, opts = {}) {
		assertWritable("insertBatch");
		const list = Array.isArray(rows) ? rows : [];
		const out = { rows: 0, inserted: 0, updated: 0, skipped: 0, delta: [] };
		if (!list.length) return out;
		const chunkSize = Math.max(1, Math.trunc(toNum(opts.chunkRows) ?? MAX_BATCH_ROWS));
		const rollupVersion = toNum(opts.rollupVersion);
		for (let start = 0; start < list.length; start += chunkSize) {
			const chunk = list.slice(start, start + chunkSize);
			const hourMap = new Map();
			const dayMap = new Map();
			let chunkMinTs = null;
			let chunkMaxTs = null;
			/** conv+model → ts 区间（回填行），用于清理同一次调用的 live 行 */
			const dedupGroups = new Map();
			const prof = opts.profile ? { row: 0, delta: 0, prefetch: 0, flush: 0, dedup: 0 } : null;
			const mark = () => performance.now();
			let tMark = prof ? mark() : 0;
			clearPrefetch();
			db.exec("BEGIN IMMEDIATE");
			try {
				for (let i = 0; i < chunk.length; i++) {
					const row = prepareRow(chunk[i]);
					if (prof) { prof.row += mark() - tMark; tMark = mark(); }
					if (!row) {
						out.skipped++;
						continue;
					}
					const dbRow = dbRowOf(row);
					// ① 回填行先试「认领 live 对半」（部分索引 ix_calls_live 只含 live 行，通常为空 → ~1µs）
					const claimed = dbRow.entryKey ? claimLiveRow(dbRow) : null;
					if (claimed) {
						const oldDb = dbRowOf(claimed.oldView);
						if (!sameCall(oldDb, claimed.merged)) {
							addToDeltaMaps(hourMap, dayMap, oldDb, -1);
							addToDeltaMaps(hourMap, dayMap, claimed.merged, 1);
							W.updCall.run(...callArgsOf(claimed.merged), claimed.oldView.id);
							out.updated++;
							out.rows++;
						} else {
							out.skipped++;
						}
						continue;
					}
					// ② 幂等写入：新行直接插入（不先 SELECT）；entry_key 冲突才读老行做差分
					const res = W.insCall.run(...callArgsOf(dbRow));
					if (Number(res.changes ?? 1) > 0) {
						if (chunkMinTs === null || dbRow.ts < chunkMinTs) chunkMinTs = dbRow.ts;
						if (chunkMaxTs === null || dbRow.ts > chunkMaxTs) chunkMaxTs = dbRow.ts;
						if (dbRow.origin === "backfill" && dbRow.convId) {
							const gkey = `${dbRow.convId}|${dbRow.modelId ?? 0}`;
							const g = dedupGroups.get(gkey);
							if (!g) dedupGroups.set(gkey, { convId: dbRow.convId, modelId: dbRow.modelId ?? 0, minTs: dbRow.ts, maxTs: dbRow.ts });
							else {
								if (dbRow.ts < g.minTs) g.minTs = dbRow.ts;
								if (dbRow.ts > g.maxTs) g.maxTs = dbRow.ts;
							}
						}
						addToDeltaMaps(hourMap, dayMap, dbRow, 1);
						out.inserted++;
						out.rows++;
						continue;
					}
					const hit = dbRow.entryKey ? W.selByEntry.get(dbRow.entryKey) : null;
					if (!hit) {
						out.skipped++;
						continue;
					}
					const oldView = existingRowView(hit);
					const oldDb = dbRowOf(oldView);
					if (sameCall(oldDb, dbRow)) {
						out.skipped++;
						continue;
					}
					addToDeltaMaps(hourMap, dayMap, oldDb, -1);
					addToDeltaMaps(hourMap, dayMap, dbRow, 1);
					W.updCall.run(...callArgsOf(dbRow), hit.id);
					out.updated++;
					out.rows++;
				}
				if (prof) { tMark = mark(); }
				// ① 先去重（减法要落在同一批 delta 里，否则 rollup 会和明细对不上）
				const deduped = dedupLiveRows(hourMap, dayMap, dedupGroups);
				if (prof) { prof.dedup += mark() - tMark; tMark = mark(); }
				// ② 整批桶一次性预读，之后同键 delta 在内存累加
				prefetchRollup(hourMap, "hour");
				prefetchRollup(dayMap, "day");
				const deltas = [];
				for (const d of hourMap.values()) deltas.push(finalizeDelta(d));
				for (const d of dayMap.values()) deltas.push(finalizeDelta(d));
				if (prof) { prof.prefetch += mark() - tMark; tMark = mark(); }
				for (let i = 0; i < deltas.length; i++) {
					const d = deltas[i];
					applyRollupDelta(typeof d.bucket === "string" ? "day" : "hour", d);
				}
				if (prof) { prof.flush += mark() - tMark; tMark = mark(); }
				if (deduped) out.deduped = (out.deduped ?? 0) + deduped;
				if (prof) {
					out.profile ??= { row: 0, delta: 0, prefetch: 0, flush: 0, dedup: 0 };
					for (const k of Object.keys(prof)) out.profile[k] += prof[k];
				}
				if (rollupVersion !== null) setMetaRaw(db, "rollup_version", String(rollupVersion));
				if (out.inserted) bumpCounters(out.inserted, chunkMinTs, chunkMaxTs);
				setMetaRaw(db, "last_insert_at", String(Date.now()));
				db.exec("COMMIT");
				for (let i = 0; i < deltas.length; i++) out.delta.push(deltas[i]);
			} catch (err) {
				try {
					db.exec("ROLLBACK");
				} catch {
					/* 回滚失败：保持原错误 */
				}
				throw err;
			}
		}
		return out;
	}

	/**
	 * 回填行认领未认领的 live 行（±2s，同 model）：只补字段、不换身份。
	 * 认领失败 → null（各留一条，宁多不少）。
	 */
	function claimLiveRow(dbRow) {
		if (!dbRow.convId) return null;
		const from = dbRow.ts - LINK_WINDOW_MS;
		const to = dbRow.ts + LINK_WINDOW_MS;
		const rows = W.selLiveCandidate.all(dbRow.convId, from, to);
		if (!rows || !rows.length) return null;
		let best = null;
		let bestDelta = Infinity;
		for (let i = 0; i < rows.length; i++) {
			const cand = rows[i];
			if (dbRow.modelId && cand.model_id && cand.model_id !== dbRow.modelId) continue;
			const delta = Math.abs((cand.ts ?? 0) - dbRow.ts);
			if (delta < bestDelta) {
				bestDelta = delta;
				best = cand;
			}
		}
		if (!best) return null;
		const oldView = { ...existingRowView(best), id: best.id };
		// 补字段：token / 成本 / 身份取回填，ttft 保留 live 的
		const merged = {
			...dbRow,
			id: best.id,
			ts: dbRow.ts,
			ttftMs: oldView.ttftMs ?? dbRow.ttftMs,
			e2eMs: dbRow.e2eMs ?? oldView.e2eMs,
			genMs: dbRow.genMs ?? oldView.genMs,
			origin: "both",
		};
		return { oldView, merged };
	}

	function sameCall(a, b) {
		return (
			a.ts === b.ts &&
			a.entryKey === b.entryKey &&
			(a.convId ?? null) === (b.convId ?? null) &&
			(a.srcId ?? null) === (b.srcId ?? null) &&
			(a.modelId ?? null) === (b.modelId ?? null) &&
			(a.providerId ?? null) === (b.providerId ?? null) &&
			(a.projectId ?? null) === (b.projectId ?? null) &&
			a.status === b.status &&
			a.origin === b.origin &&
			(a.inTok ?? null) === (b.inTok ?? null) &&
			(a.outTok ?? null) === (b.outTok ?? null) &&
			(a.cacheRead ?? null) === (b.cacheRead ?? null) &&
			(a.cacheWrite ?? null) === (b.cacheWrite ?? null) &&
			(a.reasoningTok ?? null) === (b.reasoningTok ?? null) &&
			(a.totalTok ?? null) === (b.totalTok ?? null) &&
			(a.costSdk ?? null) === (b.costSdk ?? null) &&
			(a.costEst ?? null) === (b.costEst ?? null) &&
			(a.costSource ?? null) === (b.costSource ?? null) &&
			(a.priceId ?? null) === (b.priceId ?? null) &&
			(a.priceVersion ?? null) === (b.priceVersion ?? null) &&
			(a.ttftMs ?? null) === (b.ttftMs ?? null) &&
			(a.genMs ?? null) === (b.genMs ?? null) &&
			(a.e2eMs ?? null) === (b.e2eMs ?? null) &&
			(a.stopReason ?? null) === (b.stopReason ?? null)
		);
	}

	/** delta 行定稿：全非负 → Uint32Array（跨线程友好），含负数 → 保留 Int32Array。 */
	function finalizeDelta(d) {
		let negative = false;
		for (let i = 0; i < BINS; i++) {
			if (d.ttftHist[i] < 0 || d.e2eHist[i] < 0) {
				negative = true;
				break;
			}
		}
		if (!negative) {
			d.ttftHist = Uint32Array.from(d.ttftHist);
			d.e2eHist = Uint32Array.from(d.e2eHist);
		}
		return d;
	}

	/**
	 * rollup delta 批量合并（单事务）。worker / 迁移器 / 重算都用它。
	 * @param {'hour'|'day'} gran
	 * @param {object[]} rows §4.9 rollup 行（增量，不是绝对值）
	 */
	function upsertRollupRows(gran, rows) {
		assertWritable("upsertRollupRows");
		const list = Array.isArray(rows) ? rows : [];
		if (!list.length) return 0;
		let n = 0;
		db.exec("BEGIN IMMEDIATE");
		try {
			for (let i = 0; i < list.length; i++) {
				if (applyRollupDelta(gran, list[i])) n++;
			}
			db.exec("COMMIT");
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* ignore */
			}
			throw err;
		}
		return n;
	}

	/** 把一行 rollup 的直方图编成 Buffer（合同 §4.3 提到的 `hist: Buffer` 视图）。 */
	function rollupHists(row) {
		return { ttft: encodeHist(row?.ttftHist), e2e: encodeHist(row?.e2eHist) };
	}

	/** 删掉某天的 day 桶（重算该天前必须调用）。 */
	function deleteRollupDay(day) {
		assertWritable("deleteRollupDay");
		const key = toStr(day);
		if (!key) return 0;
		const res = W.delRollupDay.run(key);
		return Number(res.changes ?? 0);
	}

	/**
	 * 重算某一天的两级 rollup（价格版本变了 / 修复了漏计之后用）。
	 * 做法：把当天明细分页重扫一遍 -> 重建当天全部小时桶与天桶（绝对值覆盖）。
	 * 调用后主线程应 `rollup.replaceAll(store.rollupRows(...))` 重新加载内存索引。
	 * @returns {{day:string, calls:number, hourRows:number, dayRows:number}}
	 */
	function rebuildDayRollup(day) {
		assertWritable("rebuildDayRollup");
		const key = toStr(day);
		if (!key) return { day: "", calls: 0, hourRows: 0, dayRows: 0 };
		const fromMs = dayKeyToMs(key);
		const toMs = fromMs + 86_400_000 - 1;
		const hourMap = new Map();
		const dayMap = new Map();
		let calls = 0;
		let cursor = null;
		for (;;) {
			const page = queryRecords({ fromMs, toMs, cursor, limit: 1000 });
			for (let i = 0; i < page.items.length; i++) {
				const item = page.items[i];
				addToDeltaMaps(hourMap, dayMap, item, 1);
				calls++;
			}
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		const hourDeltas = [];
		for (const d of hourMap.values()) hourDeltas.push(finalizeDelta(d));
		const dayDeltas = [];
		for (const d of dayMap.values()) dayDeltas.push(finalizeDelta(d));
		db.exec("BEGIN IMMEDIATE");
		try {
			W.delRollupDay.run(key);
			W.delHourRange.run(fromMs, toMs);
			for (let i = 0; i < hourDeltas.length; i++) applyRollupDelta("hour", hourDeltas[i]);
			for (let i = 0; i < dayDeltas.length; i++) applyRollupDelta("day", dayDeltas[i]);
			setMetaRaw(db, "last_recalc_at", String(Date.now()));
			db.exec("COMMIT");
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* ignore */
			}
			throw err;
		}
		return { day: key, calls, hourRows: hourDeltas.length, dayRows: dayDeltas.length };
	}

	/**
	 * 读 rollup 行（含两张直方图，已解码成 Uint32Array）。
	 * @param {{fromMs?:number, toMs?:number, gran?:'hour'|'day'}} opts
	 */
	function rollupRows(opts = {}) {
		const gran = opts.gran === "day" || opts.gran === "1d" ? "day" : "hour";
		const { selRange } = stmtsFor(gran);
		const from = gran === "day" ? dayKeyOf(toNum(opts.fromMs) ?? 0) : hourStart(toNum(opts.fromMs) ?? 0);
		const to = gran === "day" ? dayKeyOf(toNum(opts.toMs) ?? Date.now()) : hourStart(toNum(opts.toMs) ?? Date.now());
		const out = [];
		for (const raw of selRange.all(from, to)) {
			const row = normalizeRollupRow(raw);
			row.model = refName("model", row.modelId);
			row.provider = refName("provider", row.providerId);
			row.project = refName("project", row.projectId);
			out.push(row);
		}
		return out;
	}

	// ── 明细分页 ──
	const qStmts = new Map();
	function queryStmt(where, withCursor) {
		const key = `${where}|${withCursor ? 1 : 0}`;
		let stmt = qStmts.get(key);
		if (stmt) return stmt;
		const order = "ORDER BY c.ts DESC, c.id DESC";
		const sql = `SELECT c.* FROM calls c WHERE ${where} ${order} LIMIT ?`;
		stmt = db.prepare(sql);
		qStmts.set(key, stmt);
		return stmt;
	}

	function buildWhere({ fromMs, toMs, filters, cursor, q }) {
		const clauses = ["c.ts >= ?", "c.ts <= ?"];
		const args = [toNum(fromMs) ?? 0, toNum(toMs) ?? Date.now()];
		const f = filters ?? {};
		const pushIn = (col, values) => {
			// 空数组 = 该维度不过滤（与 rowMatches / normalizeFilter 一致）
			if (!values || !values.length) return;
			const slots = values.map(() => "?").join(",");
			clauses.push(`${col} IN (${slots})`);
			for (let i = 0; i < values.length; i++) args.push(values[i]);
		};
		const filterArgStart = 2;
		const normList = (v) => normalizeFilter(v) ?? [];
		if (normList(f.modelId).length) pushIn("c.model_id", normList(f.modelId).map(Number));
		else {
			const models = normList(f.models ?? f.model);
			if (models.length) {
				clauses.push(`c.model_id IN (SELECT id FROM refs WHERE kind='model' AND name IN (${models.map(() => "?").join(",")}))`);
				for (let i = 0; i < models.length; i++) args.push(models[i]);
			}
		}
		const providers = normList(f.providers ?? f.provider);
		if (providers.length) {
			clauses.push(
				`c.provider_id IN (SELECT id FROM refs WHERE kind='provider' AND name IN (${providers.map(() => "?").join(",")}))`,
			);
			for (let i = 0; i < providers.length; i++) args.push(providers[i]);
		}
		const projects = normList(f.projects ?? f.project);
		if (projects.length) {
			clauses.push(
				`c.project_id IN (SELECT id FROM refs WHERE kind='project' AND name IN (${projects.map(() => "?").join(",")}))`,
			);
			for (let i = 0; i < projects.length; i++) args.push(projects[i]);
		}
		const statuses = normList(f.statuses ?? f.status);
		if (statuses.length) pushIn("c.status", statuses);
		const keyword = toStr(q);
		if (keyword) {
			const like = `%${keyword}%`;
			clauses.push(
				`(c.stop_reason LIKE ? OR c.conv_id LIKE ? OR c.model_id IN (SELECT id FROM refs WHERE kind='model' AND name LIKE ?)
				  OR c.provider_id IN (SELECT id FROM refs WHERE kind='provider' AND name LIKE ?))`,
			);
			args.push(like, like, like, like);
		}
		const filterClausesCount = clauses.length - filterArgStart;
		const filterArgs = args.slice(0);
		if (cursor) {
			const cur = parseCursor(cursor);
			if (cur) {
				clauses.push("(c.ts < ? OR (c.ts = ? AND c.id < ?))");
				args.push(cur.ts, cur.ts, cur.id);
			}
		}
		return {
			where: clauses.join(" AND "),
			args,
			/** 不含游标的 WHERE（计 total 用；游标只影响翻页不影响总数） */
			countWhere: clauses.slice(0, filterArgStart + filterClausesCount).join(" AND "),
			countArgs: filterArgs,
		};
	}

	function parseCursor(cursor) {
		if (!cursor) return null;
		if (typeof cursor === "object" && toNum(cursor.ts) !== null && toNum(cursor.id) !== null) {
			return { ts: toNum(cursor.ts), id: toNum(cursor.id) };
		}
		const m = /^(-?\d+)_(\d+)$/.exec(String(cursor).trim());
		if (!m) return null;
		return { ts: Number(m[1]), id: Number(m[2]) };
	}

	const callNames = new Map();
	function namesOf(row) {
		const key = `${row.model_id}|${row.provider_id}|${row.project_id}|${row.src_id}`;
		let hit = callNames.get(key);
		if (hit) return hit;
		hit = {
			model: refName("model", row.model_id),
			provider: refName("provider", row.provider_id),
			project: refName("project", row.project_id),
			src: refName("source", row.src_id),
		};
		callNames.set(key, hit);
		return hit;
	}

	function recordView(row) {
		const names = namesOf(row);
		return {
			id: row.id,
			ts: row.ts,
			entryKey: row.entry_key,
			convId: row.conv_id,
			src: names.src,
			modelId: row.model_id ?? 0,
			model: names.model,
			providerId: row.provider_id ?? 0,
			provider: names.provider,
			projectId: row.project_id ?? 0,
			project: names.project,
			status: row.status,
			origin: row.origin,
			inTok: row.in_tok,
			outTok: row.out_tok,
			cacheRead: row.cache_read,
			cacheWrite: row.cache_write,
			reasoningTok: row.reasoning_tok,
			totalTok: row.total_tok,
			costSdk: row.cost_sdk,
			costEst: row.cost_est,
			costSource: row.cost_source,
			priceId: row.price_id,
			priceVersion: row.price_version,
			ttftMs: row.ttft_ms,
			genMs: row.gen_ms,
			e2eMs: row.e2e_ms,
			stopReason: row.stop_reason,
		};
	}

	/**
	 * 明细分页（keyset：`ts DESC, id DESC`，游标 `<ts>_<id>`）。
	 * @returns {{items:object[], nextCursor:string|null, total:number, limit:number}}
	 */
	function queryRecords(opts = {}) {
		const limit = Math.min(500, Math.max(1, Math.trunc(toNum(opts.limit) ?? 50)));
		const fromMs = toNum(opts.fromMs) ?? 0;
		const toMs = toNum(opts.toMs) ?? Date.now();
		// P1-5：`q` 是 4 个 LIKE + 2 个子查询，窗口太大就是全表扫（实测 150k 时 1.9s）。
		// 先看窗口体量，超阈值直接拒绝，让前端收窄时间窗。
		const keyword = toStr(opts.q);
		if (keyword) {
			const windowCalls = sumRollupCalls(fromMs, toMs) ?? 0;
			const maxScan = Math.max(1, Math.trunc(toNum(opts.maxScanRows) ?? 20_000));
			if (windowCalls > maxScan) {
				return {
					items: [],
					nextCursor: null,
					total: windowCalls,
					limit,
					ok: false,
					code: "too-broad",
					hint: `当前时间窗有 ${windowCalls} 条记录，关键字搜索只在 ≤${maxScan} 条窗口内开放；请把时间窗缩小到 7 天以内`,
				};
			}
		}
		const { where, args, countWhere, countArgs } = buildWhere(opts);
		const rows = queryStmt(where).all(...args, limit + 1);
		const items = [];
		for (let i = 0; i < rows.length && i < limit; i++) items.push(recordView(rows[i]));
		const last = items.length ? items[items.length - 1] : null;
		const nextCursor = rows.length > limit && last ? `${last.ts}_${last.id}` : null;
		const { total, approx } = totalOf(opts, { fromMs, toMs, countWhere, countArgs, fallback: items.length });
		return { items, nextCursor, total, totalApprox: approx, limit, ok: true };
	}

	/** 窗口内明细条数（rollup 的 calls 之和；桶对齐 → fromMs/toMs 非整点时会略多）。 */
	function sumRollupCalls(fromMs, toMs) {
		try {
			const row = sumStmt().get(hourStart(fromMs), hourStart(toMs));
			return row ? Number(row.c ?? 0) : 0;
		} catch {
			return null;
		}
	}

	let sumStmtCache = null;
	function sumStmt() {
		if (!sumStmtCache) sumStmtCache = db.prepare("SELECT SUM(calls) AS c FROM rollup_hour WHERE bucket >= ? AND bucket <= ?");
		return sumStmtCache;
	}

	/**
	 * 总条数：
	 *  - 无筛选 → `Σ rollup_hour.calls`（桶对齐的近似值，标记 `totalApprox`）；30s 缓存；
	 *  - 有筛选 / 带 q → `COUNT(*)` + 30s 内存缓存（键 = 归一化窗口 + 筛选）。
	 * 原来每页都跑全窗口 COUNT(*)：150k 时 17–22ms/次。
	 */
	const totalCache = new Map();
	function totalOf(opts, ctx) {
		const filters = opts.filters ?? {};
		const hasFilters = Boolean(
			(normalizeFilter(filters.models ?? filters.model) || []).length ||
				(normalizeFilter(filters.providers ?? filters.provider) || []).length ||
				(normalizeFilter(filters.projects ?? filters.project) || []).length ||
				(normalizeFilter(filters.statuses ?? filters.status) || []).length ||
				toStr(opts.q),
		);
		const fromMs = hourStart(ctx.fromMs);
		const toMs = hourStart(ctx.toMs);
		const key = hasFilters
			? `f|${fromMs}|${toMs}|${JSON.stringify(filters)}|${toStr(opts.q) ?? ""}`
			: `a|${fromMs}|${toMs}`;
		const at = Date.now();
		const hit = totalCache.get(key);
		if (hit && at - hit.at < TOTAL_CACHE_TTL_MS) return hit.value;
		let value;
		if (!hasFilters) {
			const sum = sumRollupCalls(fromMs, toMs);
			value = {
				total: sum ?? countStmt(ctx.countWhere).get(...ctx.countArgs)?.c ?? ctx.fallback,
				// 窗口端点没对齐到小时 → 边界桶会被整桶计入
				approx: toNum(opts.fromMs) !== fromMs || toNum(opts.toMs) !== toMs,
			};
		} else {
			value = { total: countStmt(ctx.countWhere).get(...ctx.countArgs)?.c ?? ctx.fallback, approx: false };
		}
		totalCache.set(key, { at, value });
		if (totalCache.size > 256) totalCache.delete(totalCache.keys().next().value);
		return value;
	}

	const countStmts = new Map();
	function countStmt(where) {
		let stmt = countStmts.get(where);
		if (!stmt) {
			stmt = db.prepare(`SELECT COUNT(*) AS c FROM calls c WHERE ${where}`);
			countStmts.set(where, stmt);
		}
		return stmt;
	}

	/** 单条详情。 */
	function getRecordById(id) {
		if (readOnly) {
			const row = db.prepare("SELECT * FROM calls WHERE id = ?").get(toInt(id));
			return row ? recordView(row) : null;
		}
		const row = W.selById.get(toInt(id));
		return row ? recordView(row) : null;
	}

	/** 增量维护的明细计数（写入时加减，`stats()` 只读 meta，150k 从 22ms 降到 <1ms）。 */
	function bumpCounters(deltaCalls, minTs, maxTs) {
		const prev = Number(metaGet("calls_count") ?? "0") || 0;
		if (deltaCalls) setMetaRaw(db, "calls_count", String(Math.max(0, prev + deltaCalls)));
		const firstTs = toNum(minTs);
		const lastTs = toNum(maxTs);
		const first = toNum(metaGet("first_ts"));
		const last = toNum(metaGet("last_ts"));
		if (firstTs !== null && (first === null || firstTs < first)) setMetaRaw(db, "first_ts", String(firstTs));
		if (lastTs !== null && (last === null || lastTs > last)) setMetaRaw(db, "last_ts", String(lastTs));
	}

	/** 库统计（`bytes` = 主库 + WAL）。 */
	function stats() {
		const cached = metaGet("calls_count");
		if (cached !== null) {
			let bytes = 0;
			for (const p of [path, `${path}-wal`]) {
				try {
					bytes += statSync(p).size;
				} catch {
					/* 不存在就跳过 */
				}
			}
			return {
				calls: Number(cached) || 0,
				firstTs: toNum(metaGet("first_ts")),
				lastTs: toNum(metaGet("last_ts")),
				bytes,
			};
		}
		const row = db.prepare("SELECT COUNT(*) AS c, MIN(ts) AS a, MAX(ts) AS b FROM calls").get();
		let bytes = 0;
		for (const p of [path, `${path}-wal`]) {
			try {
				bytes += statSync(p).size;
			} catch {
				/* 不存在就跳过 */
			}
		}
		return {
			calls: row ? row.c : 0,
			firstTs: row ? row.a ?? null : null,
			lastTs: row ? row.b ?? null : null,
			bytes,
		};
	}

	/** 只读查询连接（写连接上有活跃 WAL 时读会慢 3–5 倍，实测 149ms → 45ms）。 */
	let readDb = null;
	function readConn() {
		if (readOnly) return db;
		if (readDb) return readDb;
		try {
			readDb = new DatabaseSync(path, { readOnly: true });
			readDb.exec("PRAGMA busy_timeout = 5000");
		} catch (err) {
			warn("warn", "只读连接创建失败，退回写连接：", String(err?.message ?? err));
			readDb = null;
			return db;
		}
		return readDb;
	}

	function close() {
		if (closed) return;
		closed = true;
		try {
			readDb?.close();
		} catch {
			/* ignore */
		}
		readDb = null;
		try {
			db.close();
		} catch (err) {
			warn("warn", "关闭 SQLite 连接失败：", String(err?.message ?? err));
		}
	}

	refWarm();

	return {
		path,
		dir,
		readOnly,
		schemaVersion: SCHEMA_VERSION,
		close,
		metaGet,
		metaSet,
		refId,
		refName,
		refList,
		refWarm,
		insertBatch,
		queryRecords,
		getRecordById,
		rollupRows,
		upsertRollupRows,
		deleteRollupDay,
		rebuildDayRollup,
		rollupHists,
		stats,
		/** 底层句柄（迁移/重算脚本可直接用；业务代码别碰）。 */
		db,
	};
}

export default openStore;
