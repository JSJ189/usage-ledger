/**
 * v3 会话解析层：**纯函数、零 IO、零依赖**（只用 `node:os` 取家目录做 project 归一）。
 *
 * 输入：pi 会话目录里的一行 JSONL；输出：合同 §4.9 形状的明细行（写进 `calls` 表）。
 *
 * 口径来源与边界（与 v2 `lib/sessions.mjs` 对齐的地方逐条注明）：
 *  - **只有 `type="message"` 且 `message.role="assistant"` 的行才算一次调用**；
 *    `session` / `model_change` / `thinking_level_change` 只更新上下文（不上账），
 *    其余类型（`custom` / `compaction` / `branch` / `tool_result` / …）直接跳过。
 *  - **身份 = 文件 + 行 id**：`entryKey = "e:<relPath>:<msgId>"`（与 `store.makeEntryKey` 同形状）；
 *    没有 `msgId` 的老行退化成 `"e:<relPath>:<该行在文件里的 0 基行号>"`。绝不退化成 `ts+model`
 *    （同一毫秒多次调用会被合并，见 v2 的 2.0.1 P0）。
 *  - **`project` 用 cwd 归一，不存绝对路径**：见 `projectFromCwd`。
 *  - **历史导入没有 TTFT**：`ttftMs=null`、`genMs=e2eMs=durationMs`（缺失则 null）。
 *  - **状态六态**：见 `normalizeStatus`（`aborted` 单独一态，`maxTokens/length` 仍算 ok）。
 *  - 单行异常绝不影响整文件：`JSON.parse` 失败计入 `stats.skipped["bad-json"]`。
 */
import { homedir } from "node:os";

/** 明细行字段顺序（合同 §4.9 + 解析层追加的 `src` / `msgId`）。 */
export const ROW_FIELDS = [
	"entryKey",
	"ts",
	"convId",
	"model",
	"provider",
	"project",
	"status",
	"origin",
	"inTok",
	"outTok",
	"cacheRead",
	"cacheWrite",
	"reasoningTok",
	"totalTok",
	"costSdk",
	"costEst",
	"costSource",
	"priceId",
	"priceVersion",
	"ttftMs",
	"genMs",
	"e2eMs",
	"stopReason",
	"src",
	"msgId",
];

/** 每个文件解析时的跳过计数桶（顺序固定，`stats.skipped` 里必然是这几个键）。 */
export const SKIP_REASONS = [
	"empty", // 空行 / 只有空白
	"bad-json", // JSON.parse 失败
	"context", // session / model_change / … 等非 message 行（只更新上下文）
	"not-assistant", // message 但 role 不是 assistant（user / toolResult / system）
	"bad-message", // role=assistant 但 message 不是对象
	"no-timestamp", // 拿不到 ts，无法入账
	"duplicate", // 同文件重复 msgId（只有第一条生效）
];

function toStr(v) {
	if (typeof v !== "string") return null;
	const s = v.trim();
	return s ? s : null;
}

/** v2 口径：有限且 ≥ 0 才算数（负数 / NaN / Infinity → null）。 */
function toNum(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

function emptySkipped() {
	const out = {};
	for (let i = 0; i < SKIP_REASONS.length; i++) out[SKIP_REASONS[i]] = 0;
	return out;
}

/** 统一成 `a/b/c`，Windows 反斜杠在 key 里必须消失（跨机可迁移）。 */
function slashPath(p) {
	return String(p ?? "").replace(/\\/g, "/");
}

function stripTrailingSlash(p) {
	let s = p;
	while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
	return s;
}

/**
 * cwd → 项目标签（**不存绝对路径**，保证 UI 和库里都是短名字）。
 *
 * 规则（确定性、可测）：
 * 1. `\` → `/`，去掉尾部斜杠；
 * 2. 若路径在 `home` 之下 → 取家目录之后的部分（家目录本身 → 用绝对路径的段）；
 * 3. 去掉盘符段（`C:`）；
 * 4. 取**最后 1–2 段**，用 `/` 连接（`C:/Users/11373/Desktop/JK项目/知识库` → `JK项目/知识库`）。
 *
 * @param {unknown} cwd 会话首行的 `cwd`
 * @param {string} [home] 家目录（默认 `os.homedir()`；测试可注入）
 */
export function projectFromCwd(cwd, home = homedir()) {
	const raw = toStr(cwd);
	if (!raw) return null;
	const normalized = stripTrailingSlash(slashPath(raw));
	const homeNormalized = stripTrailingSlash(slashPath(toStr(home) ?? ""));
	let rest = normalized;
	if (homeNormalized && homeNormalized !== "/") {
		const head = `${homeNormalized.toLowerCase()}/`;
		if (normalized.toLowerCase().startsWith(head)) rest = normalized.slice(head.length);
	}
	const segments = [];
	const collect = (p) => {
		for (const seg of p.split("/")) {
			if (!seg) continue;
			if (/^[A-Za-z]:$/.test(seg)) continue;
			segments.push(seg);
		}
	};
	collect(rest);
	// 家目录本身（`rest` 为空）→ 用绝对路径的段，避免整段会话的项目标签变成 null
	if (segments.length === 0) collect(normalized);
	if (segments.length === 0) return null;
	return segments.slice(-2).join("/");
}

/**
 * 状态归一六态（合同 §三）。
 *
 * | 条件 | 状态 |
 * |---|---|
 * | `stopReason === "aborted"` | `aborted` |
 * | 没有 `usage` 块 | `incomplete`（没拿到 token，不能当 0 也不能算成功/失败） |
 * | `stopReason` 含 `error` / `refusal` | `provider_error` |
 * | `stopReason` 是 `maxTokens` / `length` | `ok`（截断但调用成功） |
 * | 其余 | `ok` |
 *
 * @param {{usage?:unknown, stopReason?:unknown, errorMessage?:unknown}} input
 */
export function normalizeStatus(input = {}) {
	const stopReason = toStr(input?.stopReason) ?? "";
	const usage = input?.usage;
	const hasUsage = Boolean(usage) && typeof usage === "object";
	const errorMessage = toStr(input?.errorMessage);
	if (stopReason === "aborted") return "aborted";
	if (!hasUsage) return "incomplete";
	if (/error|refusal/i.test(stopReason)) return "provider_error";
	// 兼容没有 stopReason 但带了 errorMessage 的老行
	if (!stopReason && errorMessage) return "provider_error";
	return "ok";
}

/**
 * 造去重身份（确定性：同一文件同一行永远同一个 key）。
 *
 * 形状与 `store.mjs` 的 `makeEntryKey(srcName, entryId)` **完全一致**：`e:<rel>:<entryId>`，
 * 这样「会话重新导入」与「v2 账本迁移」对同一次调用得到同一个 key（否则会重复计账）。
 *
 * @param {string} relPath 相对会话根目录的路径（已 `\`→`/`）
 * @param {unknown} msgId 行 id（`entry.id`）
 * @param {number} index 该行在文件里的 0 基行号（无 msgId 时退化用）
 */
export function deriveEntryKey(relPath, msgId, index) {
	const rel = stripTrailingSlash(slashPath(relPath));
	const id = toStr(msgId);
	const suffix = id ?? String(Math.max(0, Math.trunc(Number(index) || 0)));
	return `e:${rel}:${suffix}`;
}

/**
 * 会话文件绝对路径 → 相对会话根的可迁移路径（`\`→`/`；前缀不匹配时退化成文件名）。
 *
 * 导出给 `migrate.mjs` 用：v2 账本里存的是绝对 `sessionFile`，要与重新导入的行同身份，
 * 必须先转成同一个 `rel` 再交给 `deriveEntryKey`。
 *
 * @param {string} root 会话根目录（如 `C:/Users/11373/.pi/agent/sessions`）
 * @param {string} absPath 会话文件绝对路径
 */
export function relPathOf(root, absPath) {
	const fileNormalized = slashPath(absPath);
	const rootNormalized = stripTrailingSlash(slashPath(root));
	if (rootNormalized && fileNormalized.toLowerCase().startsWith(`${rootNormalized.toLowerCase()}/`)) {
		return fileNormalized.slice(rootNormalized.length + 1);
	}
	const at = fileNormalized.lastIndexOf("/");
	return at >= 0 ? fileNormalized.slice(at + 1) : fileNormalized;
}

/**
 * 首行判型（用来预先识别文件格式：v3 会话 / 空文件 / 坏文件）。
 *
 * @param {unknown} firstLine 第一行原文
 * @returns {string} `"empty"` | `"invalid-json"` | `"unknown"` | entry 的 `type`
 */
export function detectSessionKind(firstLine) {
	if (typeof firstLine !== "string") return "empty";
	const text = firstLine.trim();
	if (!text) return "empty";
	let entry;
	try {
		entry = JSON.parse(text);
	} catch {
		return "invalid-json";
	}
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "invalid-json";
	return toStr(entry.type) ?? "unknown";
}

/** `usage.totalTokens` 缺失时的兜底口径（与 v2 一致：input+output+cacheRead+cacheWrite）。 */
function totalTokensOf(usage) {
	const total = toNum(usage?.totalTokens) ?? toNum(usage?.total);
	if (total !== null) return total;
	const parts = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].map((v) => toNum(v) ?? 0);
	let sum = 0;
	for (let i = 0; i < parts.length; i++) sum += parts[i];
	return sum > 0 ? sum : null;
}

/**
 * 解析一行（**就地更新 `ctx`**，与 v2 语义一致）。
 *
 * `ctx` 至少要带 `rel`（相对路径）和 `lineIndex`（0 基行号）才能产出去重身份；
 * 解析过程中会被写入 `convId` / `cwd` / `project` / `model` / `provider` / `thinkingLevel`。
 *
 * @param {string} line 一行原文（允许带 `\r`、前后空白）
 * @param {object} ctx 见上
 * @returns {{row: object|null, reason: string|null}} `reason` 取自 `SKIP_REASONS`（成功为 null）
 */
export function parseSessionLine(line, ctx = {}) {
	if (typeof line !== "string") return { row: null, reason: "empty" };
	const text = line.trim();
	if (!text) return { row: null, reason: "empty" };
	let entry;
	try {
		entry = JSON.parse(text);
	} catch {
		return { row: null, reason: "bad-json" };
	}
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { row: null, reason: "bad-json" };

	const type = toStr(entry.type);
	if (type === "session") {
		ctx.convId = toStr(entry.id) ?? ctx.convId ?? null;
		ctx.cwd = toStr(entry.cwd) ?? ctx.cwd ?? null;
		ctx.project = projectFromCwd(ctx.cwd);
		return { row: null, reason: "context" };
	}
	if (type === "model_change") {
		ctx.provider = toStr(entry.provider) ?? ctx.provider ?? null;
		ctx.model = toStr(entry.modelId) ?? ctx.model ?? null;
		return { row: null, reason: "context" };
	}
	if (type === "thinking_level_change") {
		ctx.thinkingLevel = toStr(entry.thinkingLevel) ?? ctx.thinkingLevel ?? null;
		return { row: null, reason: "context" };
	}
	if (type !== "message") return { row: null, reason: "context" };

	const message = entry.message;
	if (!message || typeof message !== "object") return { row: null, reason: "bad-message" };
	if (toStr(message.role) !== "assistant") return { row: null, reason: "not-assistant" };

	const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
	const stopReason = toStr(message.stopReason);
	const ts = toNum(message.timestamp) ?? (entry.timestamp ? toNum(Date.parse(String(entry.timestamp))) : null);
	if (ts === null) return { row: null, reason: "no-timestamp" };

	const msgId = toStr(entry.id);
	const rel = toStr(ctx.rel);
	const durationMs = toNum(message.durationMs);
	// 历史导入没有 TTFT：genMs 按合同 §三「非流式：= e2e_ms」取 durationMs
	const costSdk = toNum(usage?.cost?.total);
	return {
		row: {
			entryKey: rel ? deriveEntryKey(rel, msgId, ctx.lineIndex) : null,
			ts,
			convId: ctx.convId ?? null,
			model: toStr(message.model) ?? ctx.model ?? null,
			provider: toStr(message.provider) ?? ctx.provider ?? null,
			project: ctx.project ?? null,
			status: normalizeStatus({ usage, stopReason, errorMessage: message.errorMessage }),
			origin: "backfill",
			inTok: toNum(usage?.input),
			outTok: toNum(usage?.output),
			cacheRead: toNum(usage?.cacheRead),
			cacheWrite: toNum(usage?.cacheWrite),
			reasoningTok: toNum(usage?.reasoning),
			totalTok: totalTokensOf(usage),
			costSdk,
			costEst: null,
			// 0 = 上游没给价（pi SDK 未收录该模型），留给价格表估算；真值仍留在 costSdk
			costSource: costSdk !== null && costSdk > 0 ? "sdk" : null,
			priceId: null,
			priceVersion: null,
			ttftMs: null,
			genMs: durationMs,
			e2eMs: durationMs,
			stopReason,
			src: rel ?? null,
			msgId,
		},
		reason: null,
	};
}

/**
 * 建一个「按文件」的解析状态（流式分块与一次性整文件共用同一份状态机，
 * 保证「分块读完」和「一次读完」产出**逐条相同**）。
 *
 * @param {{file?:string|null, sessionsRoot?:string|null, rel?:string|null}} options
 */
export function createSessionParseState(options = {}) {
	const rel =
		toStr(options.rel) ??
		(options.file ? relPathOf(options.sessionsRoot, options.file) : null);
	return {
		rel,
		ctx: { rel, convId: null, cwd: null, project: null, model: null, provider: null, thinkingLevel: null, lineIndex: 0 },
		seen: new Set(),
		out: [],
		stats: {
			rel,
			convId: null,
			project: null,
			lines: 0,
			rows: 0,
			skipped: emptySkipped(),
			errors: [],
		},
	};
}

/**
 * 消费一批「完整行」（不含半行），把产出的记录**追加**进 `state.out`。
 * 分块调用时行号连续、`seen` 连续、`ctx` 连续 → 与整文件一次解析等价。
 *
 * @param {object} state `createSessionParseState` 的返回值
 * @param {string[]} lines 完整行（可含空行 / `\r`）
 * @returns {object[]} 本次新增的记录（同时也在 `state.out` 里）
 */
export function consumeSessionLines(state, lines) {
	const produced = [];
	const ctx = state.ctx;
	const stats = state.stats;
	for (let i = 0; i < lines.length; i++) {
		const { row, reason } = parseSessionLine(lines[i], ctx);
		if (reason !== null) {
			stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
			if (reason !== "empty") stats.lines++;
		} else {
			stats.lines++;
		}
		ctx.lineIndex++;
		if (!row) continue;
		const dedupeKey = row.msgId ?? `#${ctx.lineIndex - 1}`;
		if (state.seen.has(dedupeKey)) {
			stats.skipped.duplicate = (stats.skipped.duplicate ?? 0) + 1;
			continue;
		}
		state.seen.add(dedupeKey);
		state.out.push(row);
		stats.rows++;
		produced.push(row);
	}
	stats.convId = ctx.convId;
	stats.project = ctx.project;
	return produced;
}

/** 文本 / Buffer / 行数组 → 完整行数组（Buffer 末尾没有换行的半行会被当成一行）。 */
function toLines(input) {
	if (Array.isArray(input)) return input;
	if (typeof input === "string") {
		const lines = input.split("\n");
		const tail = lines.pop() ?? "";
		if (tail) lines.push(tail);
		return lines;
	}
	if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
		const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
		const nl = buf.lastIndexOf(0x0a);
		const lines = nl < 0 ? [] : buf.subarray(0, nl + 1).toString("utf8").split("\n");
		if (lines.length > 0) lines.pop(); // 以 \n 结尾 → 末尾空串
		if (nl < buf.length - 1) lines.push(buf.subarray(nl + 1).toString("utf8"));
		return lines;
	}
	return [];
}

/**
 * 解析一个完整会话文件（`lines` 可以是行数组、整段文本或 Buffer）。
 *
 * @param {string[]|string|Buffer} lines
 * @param {{file?:string|null, sessionsRoot?:string|null, rel?:string|null}} options
 * @returns {{rows: object[], stats: object}}
 */
export function sessionFileToRows(lines, options = {}) {
	const state = createSessionParseState(options);
	consumeSessionLines(state, toLines(lines));
	return { rows: state.out, stats: state.stats };
}

/**
 * 跨目录 fs 错误分类（合同 §4.6；宿主未授权时抛的是中文文案，不是 errno）。
 *
 * @param {unknown} err
 * @returns {{code:string, reason:string, reasonEn:string, hint:string, hintEn:string}}
 */
export function classifyFsError(err) {
	const message = String(err?.message ?? err ?? "");
	const code = String(err?.code ?? "");
	if (/未授权|not authorized|EACCES|EPERM/i.test(`${message} ${code}`)) {
		return {
			code: "denied",
			reason: "会话目录未授权",
			reasonEn: "Sessions directory not authorized",
			hint: "在看板点「授权并导入历史」，或重装插件时批准该目录读取",
			hintEn: "Click “Authorize & import history” in the dashboard, or grant the directory on install",
		};
	}
	if (/未声明读能力|fs:read|no permissions/i.test(message)) {
		return {
			code: "no-permission",
			reason: "插件未声明 fs:read 权限",
			reasonEn: "Plugin lacks the fs:read permission",
			hint: "manifest.permissions 需要包含 fs:read（安装时人工确认）",
			hintEn: "manifest.permissions must include fs:read (confirmed by hand on install)",
		};
	}
	if (/ENOENT|not found|不存在/i.test(`${message} ${code}`)) {
		return {
			code: "missing",
			reason: "会话目录不存在",
			reasonEn: "Sessions directory not found",
			hint: "确认 pi 至少跑过一次对话，或在设置里指定 sessionsDir",
			hintEn: "Make sure pi has run at least one conversation, or set sessionsDir",
		};
	}
	return {
		code: "fs-error",
		reason: `读取会话目录失败：${message || "未知错误"}`,
		reasonEn: `Cannot read the sessions directory: ${message || "unknown error"}`,
		hint: "",
		hintEn: "",
	};
}
