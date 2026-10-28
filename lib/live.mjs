/**
 * 实时采集：把宿主转发的运行轨迹事件折成「每次模型调用一条记录」。
 *
 * 事件语义（`server/plugins.ts` 的 PluginRunEvent）：
 *  - `turn_start`        → 记 turn 起点（`at`）
 *  - `turn_first_token`  → `durationMs` 就是 TTFT（`Date.now() - turnStartAt`）
 *  - `message`（assistant）→ `model` / `provider` / `usageCost` / `timestamp` / `stopReason`
 *  - `turn_end`          → 记 turn 终点（此刻才知道单次调用耗时）
 *  - `run_end`           → 兜底：本轮还挂着的 turn 也要落库（缺 message 标 incomplete）
 *
 * 为什么在 `turn_end` 才落库：`message` 先于 `turn_end` 到达，而耗时只有拿到
 * `turn_end.at` 才算得出来。中途崩了也有 `run_end` 兜底。
 *
 * 注意：live 记录**没有 token 数**（`UiMessage` 不带 token），token 与真实成本的
 * 完整值靠会话回填补齐；账本按 `ts + model + provider` 合并，不会翻倍。
 */
import { RECORD_SOURCES, RECORD_STATUS } from "./ledger.mjs";

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
 * @param {object} options
 * @param {{add:(r:object)=>unknown}} options.store 账本存储
 * @param {(level:string, ...args:unknown[])=>void} [options.log]
 */
export function createLiveCollector(options = {}) {
	const store = options.store ?? null;
	const log = typeof options.log === "function" ? options.log : () => {};
	/** conversationId → 当前 turn（一个对话同一时刻只有一个 turn）。 */
	const turns = new Map();
	const stats = {
		events: 0,
		turns: 0,
		records: 0,
		incomplete: 0,
		ignored: 0,
		lastEventAt: null,
	};

	function turnOf(conversationId, at) {
		const key = conversationId ?? "-";
		let turn = turns.get(key);
		if (!turn) {
			turn = {
				conversationId: key === "-" ? null : key,
				startAt: null,
				firstTokenAt: null,
				ttftMs: null,
				endAt: null,
				lastAt: null,
				message: null,
			};
			turns.set(key, turn);
		}
		if (turn.lastAt === null || (at !== null && at > turn.lastAt)) turn.lastAt = at;
		return turn;
	}

	function recordOf(turn, endAt) {
		const msg = turn.message;
		const finishAt = toNum(endAt) ?? turn.endAt ?? turn.lastAt;
		const startAt = toNum(turn.startAt);
		const durationMs = startAt !== null && finishAt !== null ? Math.max(1, finishAt - startAt) : null;
		return {
			ts: msg?.ts ?? finishAt,
			conversationId: turn.conversationId,
			projectDir: null,
			provider: msg?.provider ?? null,
			model: msg?.model ?? null,
			thinkingLevel: null,
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			reasoningTokens: null,
			totalTokens: null,
			costUsd: msg?.costUsd ?? null,
			durationMs,
			ttftMs: toNum(turn.ttftMs),
			turnStartAt: startAt,
			stopReason: msg?.stopReason ?? null,
			status: msg ? msg.status : RECORD_STATUS.incomplete,
			hasUsage: false,
			source: RECORD_SOURCES.live,
		};
	}

	function finalize(turn, endAt) {
		const record = recordOf(turn, endAt);
		stats.turns++;
		if (record.status === RECORD_STATUS.incomplete) stats.incomplete++;
		stats.records++;
		try {
			store?.add?.(record);
		} catch (err) {
			log("warn", "live 记录写入失败：", String(err?.message ?? err));
		}
		return record;
	}

	/** 处理一条运行轨迹事件，返回本次落库的记录（通常是 0 或 1 条）。 */
	function handle(event) {
		if (!event || typeof event !== "object") return [];
		stats.events++;
		const at = toNum(event.at);
		if (at !== null) stats.lastEventAt = at;
		const conversationId = toStr(event.conversationId);
		const key = conversationId ?? "-";
		const type = toStr(event.type) ?? "";
		switch (type) {
			case "run_start": {
				// 新一轮：清掉上一轮残留（正常路径上一轮已在 run_end/turn_end 收尾）
				turns.delete(key);
				return [];
			}
			case "turn_start": {
				turns.delete(key);
				const turn = turnOf(conversationId, at);
				turn.startAt = at;
				return [];
			}
			case "turn_first_token": {
				const turn = turnOf(conversationId, at);
				const ttft = toNum(event.durationMs);
				// 一轮只认第一个首包；后续（多气泡）不覆盖
				if (ttft !== null && ttft > 0 && turn.ttftMs === null) {
					turn.ttftMs = ttft;
					turn.firstTokenAt = at;
				}
				return [];
			}
			case "message": {
				const message = event.message;
				if (!message || typeof message !== "object") return [];
				if (toStr(message.role) !== "assistant") {
					stats.ignored++;
					return [];
				}
				const turn = turnOf(conversationId, at);
				const stopReason = toStr(message.stopReason) ?? null;
				const errored = stopReason === "error" || Boolean(toStr(message.errorMessage));
				turn.message = {
					ts: toNum(message.timestamp) ?? at,
					model: toStr(message.model),
					provider: toStr(message.provider),
					costUsd: toNum(message.usageCost),
					stopReason,
					status: errored ? RECORD_STATUS.error : RECORD_STATUS.ok,
				};
				return [];
			}
			case "turn_end": {
				const turn = turns.get(key);
				if (!turn) {
					stats.ignored++;
					return [];
				}
				turn.endAt = at;
				turns.delete(key);
				return [finalize(turn, at)];
			}
			case "run_end": {
				const turn = turns.get(key);
				if (!turn) return [];
				turns.delete(key);
				return [finalize(turn, at)];
			}
			default:
				stats.ignored++;
				return [];
		}
	}

	return {
		handle,
		stats: () => ({ ...stats, pending: turns.size }),
		pending: () => turns.size,
		reset() {
			turns.clear();
		},
	};
}

export default createLiveCollector;
