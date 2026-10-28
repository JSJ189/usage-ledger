/**
 * usage-ledger 2.0 账本存储：自己维护「每次模型调用一条记录」的 append-only JSONL。
 *
 * 设计取舍（与 brief 对齐）：
 *  1. 只用 Node 内置 fs 追加写 `host.dataDir/ledger.jsonl`，不依赖任何外部软件，
 *     也绝不写 `~/.pi/agent/sessions`（那里只读）。
 *  2. **log-structured**：合并（live 记录后来被回填补全 token）时不原地改文件，
 *     而是**再追加一行同 id 的完整记录**；`load()` 按行折叠，后写覆盖先写。
 *     好处：追加是原子小写，进程崩溃最多丢最后一行（torn line 直接跳过）；
 *     代价：文件有冗余行——`load()` 发现冗余就压一次（tmp + rename）。
 *  3. 去重两个维度，任一命中即合并：
 *     - `entryKey`：会话 entry 的 `sessionId + entryId`（回填天然唯一）；
 *     - `callKey`：`ts + model + provider`（live 与回填的交集；会话里 assistant
 *       行的 `message.timestamp` 与 `UiMessage.timestamp` 是同一个 SDK 值）。
 *     live 拿不到 message 时退化为 `conversationId + turnStartAt + model`。
 *
 * 记录字段（brief 规定的最小集 + 两个辅助位）：
 *   ts | conversationId | projectDir | provider | model | thinkingLevel
 *   inputTokens | outputTokens | cacheReadTokens | cacheWriteTokens | reasoningTokens | totalTokens
 *   costUsd | durationMs | ttftMs | stopReason | source("live"|"backfill")
 *   status("ok"|"error"|"incomplete") | sessionId | entryId | id | sources[]
 *
 * token 等数值字段用 `null` 表示「不知道」（如 live 事件没有 usage），聚合侧按 0 计入。
 */
import * as nodeFs from "node:fs";
import { join } from "node:path";

/** 账本文件名（放 `host.dataDir` 下）。 */
export const LEDGER_FILE = "ledger.jsonl";
/** 记录来源：实时采集 / 会话回填。 */
export const RECORD_SOURCES = { live: "live", backfill: "backfill" };
/** 记录状态：成功 / 出错 / 未收全（缺 message 或 usage）。 */
export const RECORD_STATUS = { ok: "ok", error: "error", incomplete: "incomplete" };

const STATUS_RANK = { ok: 1, incomplete: 2, error: 3 };
/** 文本字段：合并时「谁先有值用谁」。 */
const TEXT_FIELDS = [
	"conversationId",
	"projectDir",
	"provider",
	"model",
	"thinkingLevel",
	"stopReason",
	"sessionId",
	"entryId",
];
/** 数值字段：合并时取「已知值里的大者」（同一调用两边应相等，回填补 live 的空）。 */
const NUMBER_FIELDS = [
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens",
	"totalTokens",
	"costUsd",
	"durationMs",
	"ttftMs",
];

function toNum(v) {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

function toStr(v) {
	if (typeof v !== "string") return null;
	const s = v.trim();
	return s ? s : null;
}

/** 会话 entry 的唯一键（`sessionId` 可缺，缺了用 `-` 占位）。 */
export function entryKey(sessionId, entryId) {
	const id = toStr(entryId);
	if (!id) return "";
	return `e:${toStr(sessionId) ?? "-"}:${id}`;
}

/** 一次调用的「内容键」：回填与 live 都能算出来的交集。 */
export function callKey(record) {
	if (!record || typeof record !== "object") return "";
	const model = toStr(record.model);
	const ts = toNum(record.ts);
	if (ts !== null && model) return `c:${ts}:${model}:${toStr(record.provider) ?? "-"}`;
	const conv = toStr(record.conversationId);
	const startAt = toNum(record.turnStartAt);
	if (conv && startAt !== null) return `l:${conv}:${startAt}:${model ?? "-"}`;
	return "";
}

/** 记录 id：entry 键优先（回填稳定），其次内容键，最后退化键。 */
export function recordId(record) {
	const ek = entryKey(record.sessionId, record.entryId);
	if (ek) return ek;
	const ck = callKey(record);
	if (ck) return ck;
	return `x:${record.source ?? RECORD_SOURCES.backfill}:${toNum(record.ts) ?? 0}:${toStr(record.model) ?? "-"}:${toStr(record.conversationId) ?? "-"}`;
}

/**
 * 归一到账本记录形状。非法/空记录返回 null（调用方跳过）。
 * @param {Record<string, unknown>} raw
 */
export function normalizeRecord(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const source = raw.source === RECORD_SOURCES.live ? RECORD_SOURCES.live : RECORD_SOURCES.backfill;
	const statusText = toStr(raw.status);
	const record = {
		ts: toNum(raw.ts),
		conversationId: toStr(raw.conversationId),
		projectDir: toStr(raw.projectDir),
		provider: toStr(raw.provider),
		model: toStr(raw.model),
		thinkingLevel: toStr(raw.thinkingLevel),
		inputTokens: toNum(raw.inputTokens),
		outputTokens: toNum(raw.outputTokens),
		cacheReadTokens: toNum(raw.cacheReadTokens),
		cacheWriteTokens: toNum(raw.cacheWriteTokens),
		reasoningTokens: toNum(raw.reasoningTokens),
		totalTokens: toNum(raw.totalTokens),
		costUsd: toNum(raw.costUsd),
		durationMs: toNum(raw.durationMs),
		ttftMs: toNum(raw.ttftMs),
		turnStartAt: toNum(raw.turnStartAt),
		stopReason: toStr(raw.stopReason),
		status: statusText && RECORD_STATUS[statusText] ? statusText : RECORD_STATUS.ok,
		source,
		sessionId: toStr(raw.sessionId),
		entryId: toStr(raw.entryId),
		hasUsage: raw.hasUsage === true,
		sources: [],
	};
	const incoming = Array.isArray(raw.sources) ? raw.sources.filter((s) => typeof s === "string" && s) : [];
	record.sources = [...new Set([source, ...incoming])].sort();
	// 空记录（既无模型也无时间也无 token）没有统计价值，直接丢
	const hasAny =
		record.ts !== null ||
		record.model !== null ||
		record.inputTokens !== null ||
		record.outputTokens !== null ||
		record.costUsd !== null;
	if (!hasAny) return null;
	record.id = toStr(raw.id) || recordId(record);
	return record;
}

/**
 * 合并两条同一调用的记录（base 先到、next 后到）。语义：
 *  - 文本字段：base 有值就不覆盖（entryId 之类以先到者为准）；
 *  - 数值字段：取已知值里的大者（同一调用应相等，回填用来补 live 的空）；
 *  - status：`incomplete` 是「还没收全」，遇到非 incomplete 就升级；
 *  - source：任一方是 live 就记 live（live 意味着见过实时事件）；
 *  - sources：并集，前端可据此说明「回填 + 实时」。
 */
export function mergeRecord(base, next) {
	const out = { ...base };
	for (const field of TEXT_FIELDS) {
		const cur = out[field] ?? null;
		const incoming = next[field] ?? null;
		out[field] = cur ?? incoming;
	}
	for (const field of NUMBER_FIELDS) {
		const a = toNum(out[field]);
		const b = toNum(next[field]);
		out[field] = a === null ? b : b === null ? a : Math.max(a, b);
	}
	out.turnStartAt = toNum(base.turnStartAt) ?? toNum(next.turnStartAt);
	out.ts = toNum(out.ts) ?? toNum(next.ts);
	out.hasUsage = base.hasUsage === true || next.hasUsage === true;
	const nextStatus = next.status ?? RECORD_STATUS.ok;
	// incomplete 只是「还没收全」，它不能把已知结局改小；其余以「后到的真实结局」为准
	out.status = nextStatus === RECORD_STATUS.incomplete ? (STATUS_RANK[out.status] ? out.status : nextStatus) : nextStatus;
	out.source = base.source === RECORD_SOURCES.live || next.source === RECORD_SOURCES.live ? RECORD_SOURCES.live : RECORD_SOURCES.backfill;
	out.sources = [...new Set([...(base.sources ?? []), ...(next.sources ?? []), out.source])].sort();
	out.id = base.id || recordId(out);
	return out;
}

/**
 * 账本存储。`dir` 为空时退化为纯内存（不落盘，`persistence:false`），
 * 用于宿主没给 dataDir 的极端情况——统计仍可用，重启即丢。
 */
export function createLedgerStore(options = {}) {
	const dir = toStr(options.dir) ?? "";
	const fileName = toStr(options.file) ?? LEDGER_FILE;
	const path = dir ? join(dir, fileName) : "";
	const fsx = options.fs ?? nodeFs;
	const log = typeof options.log === "function" ? options.log : () => {};
	const items = [];
	const byId = new Map();
	const byEntry = new Map();
	const byCall = new Map();
	const stats = {
		lines: 0,
		bad: 0,
		duplicates: 0,
		writes: 0,
		writeErrors: 0,
		compactions: 0,
		persistence: Boolean(path),
		lastError: null,
	};
	let warnOnce = false;

	function reindex(record, index) {
		byId.set(record.id, index);
		const ek = entryKey(record.sessionId, record.entryId);
		if (ek) byEntry.set(ek, index);
		const ck = callKey(record);
		if (ck) byCall.set(ck, index);
	}

	/** 找同一调用已有记录的下标：entry 键 → 内容键 → 记录 id。 */
	function findIndex(record) {
		const ek = entryKey(record.sessionId, record.entryId);
		if (ek && byEntry.has(ek)) return byEntry.get(ek);
		const ck = callKey(record);
		if (ck && byCall.has(ck)) return byCall.get(ck);
		if (byId.has(record.id)) return byId.get(record.id);
		return -1;
	}

	function ensureDir() {
		if (!dir) return false;
		try {
			fsx.mkdirSync(dir, { recursive: true });
			return true;
		} catch (err) {
			stats.writeErrors++;
			stats.lastError = String(err?.message ?? err);
			if (!warnOnce) {
				warnOnce = true;
				log("warn", "账本目录创建失败（退化为内存账本）：", stats.lastError);
			}
			return false;
		}
	}

	/** 追加一行（log-structured：同 id 的后写行在 load 时覆盖先写行）。 */
	function flush(record) {
		if (!path) return;
		if (!ensureDir()) return;
		try {
			fsx.appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
			stats.writes++;
		} catch (err) {
			stats.writeErrors++;
			stats.lastError = String(err?.message ?? err);
			if (!warnOnce) {
				warnOnce = true;
				log("warn", "账本追加失败（本次运行仍可统计）：", stats.lastError);
			}
		}
	}

	/** 读盘并折叠。崩溃遗留的残行/坏行计入 `bad`，不抛错。 */
	function load() {
		items.length = 0;
		byId.clear();
		byEntry.clear();
		byCall.clear();
		stats.lines = 0;
		stats.bad = 0;
		stats.duplicates = 0;
		stats.lastError = null;
		if (!path) return { records: 0, ...stats };
		let text = "";
		try {
			if (fsx.existsSync(path)) text = String(fsx.readFileSync(path, "utf8"));
		} catch (err) {
			stats.lastError = String(err?.message ?? err);
			log("warn", "账本读取失败（按空账本启动）：", stats.lastError);
			return { records: 0, ...stats };
		}
		for (const rawLine of text.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			stats.lines++;
			let raw;
			try {
				raw = JSON.parse(line);
			} catch {
				stats.bad++;
				continue;
			}
			const record = normalizeRecord(raw);
			if (!record) {
				stats.bad++;
				continue;
			}
			const idx = findIndex(record);
			if (idx >= 0) {
				const merged = mergeRecord(items[idx], record);
				items[idx] = merged;
				stats.duplicates++;
				reindex(merged, idx);
				continue;
			}
			items.push(record);
			reindex(record, items.length - 1);
		}
		// 冗余行过多（>2 倍记录数）就压实一次，控制文件增长
		if (stats.duplicates > items.length && items.length > 0) compact();
		return { records: items.length, ...stats };
	}

	/** 压实：把内存里的最终记录重写成新文件（tmp + rename，原子）。 */
	function compact() {
		if (!path) return false;
		if (!ensureDir()) return false;
		const tmp = `${path}.tmp`;
		try {
			const body = items.map((r) => JSON.stringify(r)).join("\n");
			fsx.writeFileSync(tmp, body ? `${body}\n` : "", "utf8");
			fsx.renameSync(tmp, path);
			stats.duplicates = 0;
			stats.compactions++;
			return true;
		} catch (err) {
			stats.lastError = String(err?.message ?? err);
			log("warn", "账本压实失败（保留原文件）：", stats.lastError);
			return false;
		}
	}

	/**
	 * 写入一条记录（存在同一调用则合并）。
	 * @returns {{added:boolean, merged:boolean, record:object|null, reason?:string}}
	 */
	function add(rawRecord) {
		const record = normalizeRecord(rawRecord);
		if (!record) return { added: false, merged: false, record: null, reason: "invalid" };
		const idx = findIndex(record);
		if (idx >= 0) {
			const merged = mergeRecord(items[idx], record);
			items[idx] = merged;
			reindex(merged, idx);
			flush(merged);
			return { added: false, merged: true, record: merged };
		}
		items.push(record);
		reindex(record, items.length - 1);
		flush(record);
		return { added: true, merged: false, record };
	}

	/** 批量写入（回填一次几十上百条；单条失败不影响其余）。 */
	function addMany(list) {
		const result = { added: 0, merged: 0, invalid: 0 };
		if (!Array.isArray(list)) return result;
		for (const raw of list) {
			const res = add(raw);
			if (res.added) result.added++;
			else if (res.merged) result.merged++;
			else result.invalid++;
		}
		return result;
	}

	/** 按 ts 升序的副本（无 ts 的排最后）。 */
	function list() {
		return [...items].sort((a, b) => (a.ts ?? Number.MAX_SAFE_INTEGER) - (b.ts ?? Number.MAX_SAFE_INTEGER));
	}

	/** 时间窗过滤（`toMs` 缺省 = 不限上界）。 */
	function query({ fromMs = null, toMs = null } = {}) {
		return list().filter((r) => {
			if (fromMs !== null && (r.ts ?? 0) < fromMs) return false;
			if (toMs !== null && (r.ts ?? 0) > toMs) return false;
			return true;
		});
	}

	function snapshot() {
		return {
			...stats,
			records: items.length,
			path,
			compactions: stats.compactions,
		};
	}

	return {
		path,
		load,
		compact,
		add,
		addMany,
		list,
		query,
		stats: snapshot,
		/** 只读视图（测试/聚合用，别改它）。 */
		get size() {
			return items.length;
		},
	};
}

export default createLedgerStore;
