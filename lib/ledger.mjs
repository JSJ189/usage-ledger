/**
 * usage-ledger 2.0 账本存储：自己维护「每次模型调用一条记录」的 append-only JSONL。
 *
 * 设计取舍：
 *  1. 只用 Node 内置 fs 追加写 `host.dataDir/ledger.jsonl`，不依赖任何外部软件，
 *     也绝不写 `~/.pi/agent/sessions`（那里只读）。
 *  2. **log-structured**：合并（live 记录后来被回填补全 token）时不原地改文件，
 *     而是**再追加一行同 id 的完整记录**；`load()` 按行折叠，后写覆盖先写。
 *     好处：追加是原子小写，进程崩溃最多丢最后一行（torn line 直接跳过）；
 *     代价：文件有冗余行——`load()` 发现冗余就压一次（tmp + rename）。
 *  3. **身份键（去重）与配对（合并）是两件事**：
 *     - 回填记录的身份键**只有** `entryKey = sessionFile + entryId`。会话里每个
 *       assistant 行的 `id` 都是唯一的，一次调用一行。**禁止**用 `ts + model +
 *       provider` 做回填去重键：同一毫秒内多次调用（并行 / 子代理）是真实存在的，
 *       那样会把几十次真实调用合并成一条（2.0.0 的 P0 BUG）。
 *     - live 记录的身份键是 `liveKey = conversationId + turnStartAt + model`
 *       （一个对话同一时刻只有一个 turn）；缺 turnStartAt 时退化为
 *       `ts + model + provider`（live 无 entryId，只能这样）。
 *     - live 与回填是同一调用的两半（live 有 TTFT 没 token，回填有 token 没 TTFT），
 *       它们**不是靠身份键**相遇，而是靠 `pairRecords` 的 **1:1 贪心配对**：
 *       同 `model` + 同 `provider` + `|Δts| <= PAIR_WINDOW_MS`，每条最多认领一条，
 *       认领过就打 `paired` 标记。绝不 1→N 合并，配不上就各自保留。
 *
 * 记录字段（最小集 + 辅助位）：
 *   ts | conversationId | projectDir | provider | model | thinkingLevel
 *   inputTokens | outputTokens | cacheReadTokens | cacheWriteTokens | reasoningTokens | totalTokens
 *   costUsd | durationMs | ttftMs | stopReason | source("live"|"backfill")
 *   status("ok"|"error"|"incomplete") | sessionFile | sessionId | entryId | id | sources[] | paired
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
/** live ↔ 回填配对的 ts 容差（毫秒）。超过这个差就不是同一次调用。 */
export const PAIR_WINDOW_MS = 3000;
/** 账本数据版本：2.0.0 的去重键有 P0 BUG，升级到这个版本要重建一次账本。 */
export const LEDGER_SCHEMA = 2;

const STATUS_RANK = { ok: 1, incomplete: 2, error: 3 };
/** 文本字段：合并时「谁先有值用谁」。 */
const TEXT_FIELDS = [
	"conversationId",
	"projectDir",
	"provider",
	"model",
	"thinkingLevel",
	"stopReason",
	"sessionFile",
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

/**
 * 会话 entry 的唯一键。第一段优先用**会话文件路径**（最稳，跨重启/跨机器都不撞），
 * 缺文件路径时回落到 `sessionId`；两者都缺只留 entryId。
 */
export function entryKey(sessionFileOrId, entryId) {
	const id = toStr(entryId);
	if (!id) return "";
	return `e:${toStr(sessionFileOrId) ?? "-"}:${id}`;
}

/** 记录自己的 entry 键（回填身份）。没有 entryId 就没有身份键，返回空串。 */
export function entryKeyOf(record) {
	if (!record || typeof record !== "object") return "";
	return entryKey(record.sessionFile ?? record.sessionId, record.entryId);
}

/** live 记录的身份键：一个对话同一时刻只有一个 turn。 */
export function liveKey(record) {
	if (!record || typeof record !== "object") return "";
	const conv = toStr(record.conversationId);
	const startAt = toNum(record.turnStartAt);
	if (!conv || startAt === null) return "";
	return `l:${conv}:${startAt}:${toStr(record.model) ?? "-"}`;
}

/**
 * 一次调用的「内容键」：只给 **live** 记录兜底用（live 没有 entryId）。
 * 回填记录**绝不能**用它去重（同一毫秒多次调用会被合并掉）。
 */
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

/** 记录 id：entry 键（回填唯一身份）> live 键 > 内容键 > 退化键。 */
export function recordId(record) {
	const ek = entryKeyOf(record);
	if (ek) return ek;
	const lk = liveKey(record);
	if (lk) return lk;
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
		sessionFile: toStr(raw.sessionFile),
		sessionId: toStr(raw.sessionId),
		entryId: toStr(raw.entryId),
		hasUsage: raw.hasUsage === true,
		paired: raw.paired === true,
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
 * 合并两条同一调用的记录（身份键相同；base 先到、next 后到）。语义：
 *  - 文本字段：base 有值就不覆盖（entryId 之类以先到者为准）；
 *  - 数值字段：取已知值里的大者（同一调用应相等，回填用来补 live 的空）；
 *  - status：`incomplete` 是「还没收全」，遇到非 incomplete 就升级；
 *  - source：任一方是 live 就记 live（live 意味着见过实时事件）；
 *  - sources：并集，前端可据此说明「回填 + 实时」；
 *  - paired：任一方配过对就算配过（一条记录只能被认领一次）。
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
	out.paired = base.paired === true || next.paired === true;
	const nextStatus = next.status ?? RECORD_STATUS.ok;
	// incomplete 只是「还没收全」，它不能把已知结局改小；其余以「后到的真实结局」为准
	out.status = nextStatus === RECORD_STATUS.incomplete ? (STATUS_RANK[out.status] ? out.status : nextStatus) : nextStatus;
	out.source = base.source === RECORD_SOURCES.live || next.source === RECORD_SOURCES.live ? RECORD_SOURCES.live : RECORD_SOURCES.backfill;
	out.sources = [...new Set([...(base.sources ?? []), ...(next.sources ?? []), out.source])].sort();
	// id 优先保留 entry 身份（回填稳定、跨重启不变）；只有 base 没有 entry 身份时才用 next 的
	out.id = (entryKeyOf(base) ? base.id : "") || (entryKeyOf(next) ? next.id : "") || base.id || recordId(out);
	return out;
}

/**
 * 把「同一次调用」的 live 记录与回填记录合成一条（1:1，调用方保证）。
 *
 * 口径（README 与看板一致）：
 *  - **身份 / token / 成本 / stopReason / 状态**：取回填（只有会话 JSONL 有这些）；
 *    回填是 `incomplete`（没有 usage 块）而 live 收了 message 时，状态用 live 的；
 *  - **ttftMs**：只取 live（回填永远没有首包时间）；
 *  - **durationMs**：live 优先（`turn_start`→`turn_end` 的实测耗时），live 没有才用
 *    回填的 `message.durationMs`（SDK 自己报的耗时）；
 *  - `paired` = true，`sources` = ["backfill","live"]，`id` 沿用回填的 entry 键。
 *
 * @param {object} liveRecord 实时采集那条（ttft 来源）
 * @param {object} backfillRecord 会话回填那条（token / 成本来源）
 */
export function pairRecords(liveRecord, backfillRecord) {
	const back = normalizeRecord(backfillRecord) ?? { ...backfillRecord };
	const live = normalizeRecord(liveRecord) ?? { ...liveRecord };
	const out = { ...back };
	out.ttftMs = toNum(live.ttftMs);
	out.durationMs = toNum(live.durationMs) ?? toNum(back.durationMs);
	out.turnStartAt = toNum(live.turnStartAt) ?? toNum(back.turnStartAt);
	out.conversationId = toStr(back.conversationId) ?? toStr(live.conversationId);
	out.ts = toNum(back.ts) ?? toNum(live.ts);
	out.hasUsage = back.hasUsage === true || live.hasUsage === true;
	out.status =
		back.status === RECORD_STATUS.incomplete && live.status !== RECORD_STATUS.incomplete ? live.status : back.status;
	out.source = RECORD_SOURCES.live;
	out.sources = [...new Set([...(back.sources ?? []), ...(live.sources ?? []), RECORD_SOURCES.live, RECORD_SOURCES.backfill])].sort();
	out.paired = true;
	out.id = toStr(back.id) || recordId(out);
	return out;
}

/** 配对桶键：`来源|模型|provider|时间桶`，桶宽 = 配对窗口，查 3 个桶就覆盖 ±window。 */
function pairSlot(source, model, provider, bucket) {
	return `${source}|${model ?? "-"}|${provider ?? "-"}|${bucket}`;
}

function bucketOf(ts) {
	return Math.floor(toNum(ts) / PAIR_WINDOW_MS);
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
	const byLive = new Map();
	/** 配对候选择：只有「未配对」的记录进桶。 */
	const pairBuckets = new Map();
	const stats = {
		lines: 0,
		bad: 0,
		duplicates: 0,
		pairings: 0,
		writes: 0,
		writeErrors: 0,
		compactions: 0,
		persistence: Boolean(path),
		lastError: null,
	};
	let warnOnce = false;

	function bucketAdd(record, index) {
		if (record.paired === true) return;
		const ts = toNum(record.ts);
		if (ts === null) return;
		const slot = pairSlot(record.source, record.model, record.provider, bucketOf(ts));
		let set = pairBuckets.get(slot);
		if (!set) {
			set = new Set();
			pairBuckets.set(slot, set);
		}
		set.add(index);
	}

	function bucketRemove(record, index) {
		const ts = toNum(record.ts);
		if (ts === null) return;
		const slot = pairSlot(record.source, record.model, record.provider, bucketOf(ts));
		const set = pairBuckets.get(slot);
		if (!set) return;
		set.delete(index);
		if (set.size === 0) pairBuckets.delete(slot);
	}

	function reindex(record, index) {
		byId.set(record.id, index);
		const ek = entryKeyOf(record);
		if (ek) byEntry.set(ek, index);
		const lk = liveKey(record);
		if (lk) byLive.set(lk, index);
		bucketAdd(record, index);
	}

	function deindex(record, index) {
		if (!record) return;
		if (byId.get(record.id) === index) byId.delete(record.id);
		const ek = entryKeyOf(record);
		if (ek && byEntry.get(ek) === index) byEntry.delete(ek);
		const lk = liveKey(record);
		if (lk && byLive.get(lk) === index) byLive.delete(lk);
		bucketRemove(record, index);
	}

	/**
	 * 找「同一条记录」已有项的下标（不是配对，配对见 pairingCandidate）。
	 *  - entry 键命中 → 同一会话 entry（回填重读 / log-structured 折叠）；
	 *  - live 身份键命中 → 同一 turn（也覆盖「配过对的合并记录」，它保留了 turnStartAt）；
	 *  - 有 entry 键却都没命中 → 就是**新调用**，绝不退化到 `ts + model + provider`；
	 *  - 只有 live 且没有 turnStartAt 时才退化到记录 id。
	 */
	function findIndex(record) {
		const ek = entryKeyOf(record);
		if (ek && byEntry.has(ek)) return byEntry.get(ek);
		const lk = liveKey(record);
		if (lk && byLive.has(lk)) return byLive.get(lk);
		if (ek) return -1;
		// 回填记录没有 entry 身份时也绝不退化成 `ts + model + provider`：宁可多一条，不可少一次
		if (record.source === RECORD_SOURCES.backfill) return -1;
		return byId.has(record.id) ? byId.get(record.id) : -1;
	}

	/**
	 * 找可以被本条记录「认领」的另一半记录（1:1 贪心：最接近的 ts 优先）。
	 * 条件：来源相反、都没配过对、同 model、同 provider、|Δts| <= PAIR_WINDOW_MS。
	 */
	function pairingCandidate(record) {
		const ts = toNum(record.ts);
		if (ts === null) return -1;
		const wantSource = record.source === RECORD_SOURCES.live ? RECORD_SOURCES.backfill : RECORD_SOURCES.live;
		// 配过对的记录（`paired:true`）写盘后会比它自己的「live 行」晚一行：读盘折叠时
		// 允许它吃掉同来源、同调用、未配对的那条（就是它自己的 live 半边）。
		const allowSameSource = record.paired === true;
		const model = toStr(record.model) ?? "-";
		const provider = toStr(record.provider) ?? "-";
		const bucket = bucketOf(ts);
		let best = -1;
		let bestDelta = Infinity;
		for (let b = bucket - 1; b <= bucket + 1; b++) {
			for (const source of allowSameSource ? [wantSource, record.source] : [wantSource]) {
				const set = pairBuckets.get(pairSlot(source, model, provider, b));
				if (!set) continue;
				for (const idx of set) {
					const cand = items[idx];
					if (!cand || cand.paired === true) continue;
					if (cand.source === record.source && !allowSameSource) continue;
					if ((toStr(cand.model) ?? "-") !== model) continue;
					if ((toStr(cand.provider) ?? "-") !== provider) continue;
					const delta = Math.abs((toNum(cand.ts) ?? 0) - ts);
					if (delta > PAIR_WINDOW_MS) continue;
					if (delta < bestDelta || (delta === bestDelta && best >= 0 && idx < best)) {
						bestDelta = delta;
						best = idx;
					}
				}
			}
		}
		return best;
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

	/** 就地替换某条记录（身份可能变：live 被回填认领后 id 变成 entry 键）。 */
	function replaceAt(index, next) {
		deindex(items[index], index);
		items[index] = next;
		reindex(next, index);
		flush(next);
	}

	function resetIndex() {
		items.length = 0;
		byId.clear();
		byEntry.clear();
		byLive.clear();
		pairBuckets.clear();
	}

	/** 读盘并折叠。崩溃遗留的残行/坏行计入 `bad`，不抛错。 */
	function load() {
		resetIndex();
		stats.lines = 0;
		stats.bad = 0;
		stats.duplicates = 0;
		stats.pairings = 0;
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
				replaceAt(idx, merged);
				stats.duplicates++;
				continue;
			}
			// 读盘阶段也做配对：live 行与回填行谁先写进文件都可能
			const cand = pairingCandidate(record);
			if (cand >= 0) {
				const opposite = items[cand].source !== record.source;
				const merged = opposite
					? record.source === RECORD_SOURCES.live
						? pairRecords(record, items[cand])
						: pairRecords(items[cand], record)
					: mergeRecord(items[cand], record);
				replaceAt(cand, merged);
				stats.pairings++;
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
	 * 重建账本（2.0.0 → 2.0.1 迁移，一次性）。
	 *
	 * 2.0.0 拿 `ts + model + provider` 给回填记录去重，同一毫秒的多次真实调用被折叠成
	 * 一条，账本里的 token / 成本数字从那以后就不可信了，无法就地修复。这里的做法：
	 *  - **丢弃**所有 `source:"backfill"` 的记录（连同污染的 token / 成本）；
	 *  - 保留 live 记录（真实调用数来自它们），但把从回填带进来的 token / 成本 / 身份
	 *    清空，退回纯 live 形状，等下一次回填按 entry 身份重新配对；
	 *  - 调用方必须同时清空回填 offset（否则文件不再重读，重建没有数据来源）。
	 *
	 * @returns {{ok:boolean, dropped:number, reset:number, kept:number}}
	 */
	function rebuild() {
		const kept = [];
		let dropped = 0;
		let reset = 0;
		for (const rec of items) {
			const sources = Array.isArray(rec.sources) && rec.sources.length ? rec.sources : [rec.source];
			const fromBackfill = sources.includes(RECORD_SOURCES.backfill) || rec.source === RECORD_SOURCES.backfill;
			if (!fromBackfill) {
				kept.push(rec);
				continue;
			}
			if (rec.source === RECORD_SOURCES.backfill) {
				dropped++;
				continue;
			}
			// live 与回填合并过的记录：只留 live 那半，等回填重新来配
			const back = {
				...rec,
				inputTokens: null,
				outputTokens: null,
				cacheReadTokens: null,
				cacheWriteTokens: null,
				reasoningTokens: null,
				totalTokens: null,
				costUsd: null,
				hasUsage: false,
				paired: false,
				sessionFile: null,
				sessionId: null,
				entryId: null,
				source: RECORD_SOURCES.live,
				sources: [RECORD_SOURCES.live],
			};
			back.id = recordId(back);
			reset++;
			kept.push(back);
		}
		const changed = dropped > 0 || reset > 0;
		if (changed) {
			resetIndex();
			for (const rec of kept) {
				items.push(rec);
				reindex(rec, items.length - 1);
			}
			stats.duplicates = 0;
			if (path) {
				if (!compact()) {
					return { ok: false, dropped, reset, kept: kept.length };
				}
			}
		}
		return { ok: true, dropped, reset, kept: kept.length };
	}

	/**
	 * 写入一条记录（同一条调用则合并；live 与回填则 1:1 配对）。
	 * @returns {{added:boolean, merged:boolean, paired:boolean, record:object|null, reason?:string}}
	 */
	function add(rawRecord) {
		const record = normalizeRecord(rawRecord);
		if (!record) return { added: false, merged: false, paired: false, record: null, reason: "invalid" };
		const idx = findIndex(record);
		if (idx >= 0) {
			const merged = mergeRecord(items[idx], record);
			replaceAt(idx, merged);
			return { added: false, merged: true, paired: merged.paired === true, record: merged };
		}
		const cand = pairingCandidate(record);
		if (cand >= 0) {
			const merged =
				record.source === RECORD_SOURCES.live ? pairRecords(record, items[cand]) : pairRecords(items[cand], record);
			replaceAt(cand, merged);
			stats.pairings++;
			return { added: false, merged: true, paired: true, record: merged };
		}
		items.push(record);
		reindex(record, items.length - 1);
		flush(record);
		return { added: true, merged: false, paired: false, record };
	}

	/** 批量写入（回填一次几十上百条；单条失败不影响其余）。 */
	function addMany(list) {
		const result = { added: 0, merged: 0, paired: 0, invalid: 0 };
		if (!Array.isArray(list)) return result;
		for (const raw of list) {
			const res = add(raw);
			if (res.added) result.added++;
			else if (res.merged) {
				result.merged++;
				if (res.paired) result.paired++;
			} else result.invalid++;
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
		let paired = 0;
		let liveOnly = 0;
		for (const rec of items) {
			if (rec.paired === true) paired++;
			else if (rec.source === RECORD_SOURCES.live) liveOnly++;
		}
		return {
			...stats,
			records: items.length,
			paired,
			liveOnly,
			path,
			compactions: stats.compactions,
		};
	}

	return {
		path,
		load,
		compact,
		rebuild,
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
