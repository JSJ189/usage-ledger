/**
 * 会话 JSONL fixture 构造器 + 临时目录助手。
 *
 * 形状对齐 pi 的真实会话文件（人类已实测）：
 *  1. 首行 `{"type":"session","version":3,"id":...,"cwd":...}`
 *  2. `model_change` / `thinking_level_change` 行在消息之前
 *  3. assistant 行的 `message` 里有 `usage{input,output,cacheRead,cacheWrite,reasoning,
 *     totalTokens,cost{...,total}}`、`model`、`provider`、`stopReason`、`timestamp`、
 *     `durationMs`
 */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 新建一个临时目录（测试用；不自动清理，交给进程结束时系统回收）。 */
export function makeTmpDir(prefix = "ul-test-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** 会话文件首行。 */
export function sessionHeader({ id = "sess-1", cwd = "C:\\work\\demo", timestamp = "2026-10-12T03:00:10.854Z" } = {}) {
	return { type: "session", version: 3, id, timestamp, cwd };
}

/** 模型切换行。 */
export function modelChange({ id = "m1", provider = "cliproxyapi", modelId = "grok-4.7" } = {}) {
	return { type: "model_change", id, parentId: null, timestamp: "2026-10-12T03:00:11.203Z", provider, modelId };
}

/** 思考档切换行。 */
export function thinkingChange({ id = "t1", thinkingLevel = "high" } = {}) {
	return { type: "thinking_level_change", id, parentId: null, timestamp: "2026-10-12T03:00:12.000Z", thinkingLevel };
}

/**
 * assistant 消息行。
 * @param {object} spec
 * @param {string} [spec.id] entry id（去重键的一半）
 * @param {number} [spec.ts] `message.timestamp`（毫秒，live 与回填的交集）
 * @param {string|null} [spec.model]
 * @param {string|null} [spec.provider]
 * @param {object|null} [spec.usage] 传 `null` 模拟「没有 usage 块」
 * @param {number|null} [spec.durationMs]
 * @param {string|null} [spec.stopReason]
 * @param {string} [spec.entryTimestamp] 行的 ISO 时间戳
 */
export function assistantLine(spec = {}) {
	const {
		id = "a1",
		ts = 1791774070834,
		model = "grok-4.7",
		provider = "cliproxyapi",
		usage = {
			input: 7309,
			output: 825,
			cacheRead: 1152,
			cacheWrite: 0,
			reasoning: 558,
			totalTokens: 9286,
			cost: { input: 0.014618, output: 0.00495, cacheRead: 0.000576, cacheWrite: 0, total: 0.020144 },
		},
		durationMs = 4321,
		stopReason = "stop",
		entryTimestamp = "2026-10-12T03:01:30.947Z",
		thinkingLevel = "high",
	} = spec;
	const message = { role: "assistant", api: "openai-completions", provider, model, content: [{ type: "text", text: "ok" }] };
	if (usage !== null) message.usage = usage;
	if (durationMs !== null) message.durationMs = durationMs;
	if (stopReason !== null) message.stopReason = stopReason;
	if (thinkingLevel !== null) message.thinkingLevel = thinkingLevel;
	message.timestamp = ts;
	return { type: "message", id, parentId: "p1", timestamp: entryTimestamp, message };
}

/** 用户消息行（回填必须忽略）。 */
export function userLine({ id = "u1", ts = 1791774070000 } = {}) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-12T03:01:00.000Z",
		message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: ts },
	};
}

/** 把 entry 数组写成 JSONL 文本（每条一行，末尾带换行）。 */
export function jsonl(entries) {
	return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/** 在 `root/<projectDir>/<name>` 写一个会话文件，返回绝对路径。 */
export function writeSessionFile(root, projectDir, name, entries) {
	const dir = join(root, projectDir);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, Array.isArray(entries) ? jsonl(entries) : String(entries), "utf8");
	return path;
}

/** 往会话文件追加文本（模拟「又跑了几轮」）。 */
export function appendSessionFile(path, text) {
	appendFileSync(path, text, "utf8");
}

/** 把文件 mtime 改成指定毫秒（覆盖 backfillDays 过滤逻辑）。 */
export function setMtime(path, ms) {
	const sec = ms / 1000;
	utimesSync(path, sec, sec);
}

/** 造一棵 `root/<project>/*.jsonl` 的会话树，返回 `{root, files}`。 */
export function makeSessionTree({ projects = 1, filesPerProject = 1, entries } = {}) {
	const root = makeTmpDir("ul-sessions-");
	const files = [];
	for (let p = 0; p < projects; p++) {
		for (let f = 0; f < filesPerProject; f++) {
			const name = `2026-10-12T03-0${f}-00-000Z_00000000-0000-0000-0000-00000000000${f}.jsonl`;
			files.push(writeSessionFile(root, `--proj-${p}--`, name, entries ?? [sessionHeader(), assistantLine()]));
		}
	}
	return { root, files };
}
