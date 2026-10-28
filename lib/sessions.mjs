/**
 * 会话 JSONL 回填（唯一能拿到逐轮 token 的来源）。
 *
 * 目录：`<sessionsRoot>/<项目目录名>/<ISO时间>_<uuid>.jsonl`，每行一个 entry。
 * sessionsRoot 解析顺序：设置项 `sessionsDir` → `$PI_CODING_AGENT_DIR/sessions` →
 * `~/.pi/agent/sessions`。**只读**：一律经 `host.fs`（fs:read 权限 + 目录授权），
 * 插件绝不写这个目录。
 *
 * 增量：每个文件记 `{mtime, size, offset, unit, ctx}`，下次从 offset 继续读。
 * 文件变小（被轮转/截断）就从头重读。残留的半行不消费（offset 停在最后一个换行）。
 *
 * 限速：单次最多 `maxFilesPerRun`（默认 200）个文件、按 mtime 新→旧；单文件大于
 * `maxFileBytes`（默认 100MB）跳过并记日志；每处理一个文件让出一次事件循环。
 */
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

/** 会话子目录名（相对 pi agent 根）。 */
export const SESSIONS_DIRNAME = "sessions";
/** 回填状态文件名（放 `host.dataDir` 下）。 */
export const BACKFILL_STATE_FILE = "backfill-state.json";
/** 默认回填天数。 */
export const DEFAULT_BACKFILL_DAYS = 30;
/** 单文件上限：超过就跳过（记日志），避免把服务端内存打满。 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** 单次回填最多处理多少个文件。 */
export const MAX_FILES_PER_RUN = 200;
/** 单次回填最多枚举多少个文件（枚举本身也要设上限）。 */
export const MAX_SCAN_FILES = 2000;
/** 回填天数允许区间。 */
export const MIN_BACKFILL_DAYS = 1;
export const MAX_BACKFILL_DAYS = 3650;

const DAY_MS = 86_400_000;

function toStr(v) {
	if (typeof v !== "string") return null;
	const s = v.trim();
	return s ? s : null;
}

function toNum(v) {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/** `~/x`、`~` 展开成家目录；其它原样返回。 */
export function expandHomePath(input, home = homedir()) {
	const s = toStr(input);
	if (!s) return "";
	if (s === "~") return home;
	if (s.startsWith("~/") || s.startsWith("~\\")) return join(home, s.slice(2));
	return s;
}

/**
 * 解析会话根目录。非法/相对路径一律回落默认值（回填不能因为设置写错就炸）。
 * @param {{settings?:Record<string,unknown>, env?:Record<string,string|undefined>, home?:string}} [opts]
 */
export function resolveSessionsRoot(opts = {}) {
	const settings = opts.settings ?? {};
	const env = opts.env ?? {};
	const home = toStr(opts.home) ?? homedir();
	const fromSettings = expandHomePath(settings.sessionsDir, home);
	if (fromSettings && isAbsolute(fromSettings)) {
		return { root: fromSettings, source: "setting" };
	}
	const agentDir = expandHomePath(env.PI_CODING_AGENT_DIR, home);
	if (agentDir && isAbsolute(agentDir)) {
		return { root: join(agentDir, SESSIONS_DIRNAME), source: "env" };
	}
	return { root: join(home, ".pi", "agent", SESSIONS_DIRNAME), source: "default" };
}

/** 回填天数白名单化（非法 → 默认 30；夹取 1–3650）。 */
export function resolveBackfillDays(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_BACKFILL_DAYS;
	return Math.min(MAX_BACKFILL_DAYS, Math.max(MIN_BACKFILL_DAYS, Math.trunc(n)));
}

/**
 * 跨目录 fs 错误分类。宿主在目录未授权时抛 `目录未授权：…`，
 * 声明缺失时给 `插件未声明读能力`，其余按 Node errno 归类。
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

/** 每条 assistant 记录的 `usage.totalTokens` 缺失时的兜底口径（与 pi SDK 一致）。 */
function totalTokensOf(usage) {
	const total = toNum(usage?.totalTokens);
	if (total !== null) return total;
	const parts = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].map((v) => toNum(v) ?? 0);
	const sum = parts.reduce((a, b) => a + b, 0);
	return sum > 0 ? sum : null;
}

/**
 * 解析一行 entry。命中 assistant 消息时返回账本记录（`source:"backfill"`）。
 * `ctx` 会被就地更新（sessionFile / sessionId / provider / model / thinkingLevel 来自前置行）。
 *
 * **身份**：回填记录的账本身份就是 `sessionFile + entry.id`。实测 pi 的每个 assistant
 * 行都有自己的 `id`（7 天内 48,867 行全唯一），所以它就是「这一次调用」的凭证。
 * 老文件里万一没有 `id`，就在本文件内按出现顺序合成一个稳定序号（`~1`、`~2`…），
 * 绝不退化成 `ts + model + provider`（同一毫秒多次调用会被合并掉，见 2.0.1 的 P0）。
 *
 * @param {unknown} entry 已解析的 JSON 对象
 * @param {{sessionFile?:string|null, sessionId?:string|null, provider?:string|null, model?:string|null, thinkingLevel?:string|null, projectDir?:string|null, synthetic?:number}} ctx
 */
export function parseSessionEntry(entry, ctx = {}) {
	if (!entry || typeof entry !== "object") return null;
	const type = toStr(entry.type);
	if (type === "session") {
		ctx.sessionId = toStr(entry.id) ?? ctx.sessionId ?? null;
		ctx.cwd = toStr(entry.cwd) ?? ctx.cwd ?? null;
		return null;
	}
	if (type === "model_change") {
		ctx.provider = toStr(entry.provider) ?? ctx.provider ?? null;
		ctx.model = toStr(entry.modelId) ?? ctx.model ?? null;
		return null;
	}
	if (type === "thinking_level_change") {
		ctx.thinkingLevel = toStr(entry.thinkingLevel) ?? ctx.thinkingLevel ?? null;
		return null;
	}
	if (type !== "message") return null;
	const message = entry.message;
	if (!message || typeof message !== "object") return null;
	if (toStr(message.role) !== "assistant") return null;

	const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
	const stopReason = toStr(message.stopReason) ?? null;
	const errored = stopReason === "error" || Boolean(toStr(message.errorMessage));
	const ts = toNum(message.timestamp) ?? (entry.timestamp ? toNum(Date.parse(String(entry.timestamp))) : null);
	const model = toStr(message.model) ?? ctx.model ?? null;
	const provider = toStr(message.provider) ?? ctx.provider ?? null;
	let entryId = toStr(entry.id);
	if (!entryId) {
		// 没有 id 的老行：本文件内按出现顺序给一个稳定序号（ctx 会随 offset 持久化）
		ctx.synthetic = (toNum(ctx.synthetic) ?? 0) + 1;
		entryId = `~${ctx.synthetic}`;
	}
	return {
		ts,
		sessionFile: toStr(ctx.sessionFile) ?? null,
		sessionId: ctx.sessionId ?? null,
		entryId,
		projectDir: ctx.projectDir ?? null,
		provider,
		model,
		thinkingLevel: toStr(message.thinkingLevel) ?? ctx.thinkingLevel ?? null,
		inputTokens: toNum(usage?.input),
		outputTokens: toNum(usage?.output),
		cacheReadTokens: toNum(usage?.cacheRead),
		cacheWriteTokens: toNum(usage?.cacheWrite),
		reasoningTokens: toNum(usage?.reasoning),
		totalTokens: totalTokensOf(usage),
		costUsd: toNum(usage?.cost?.total),
		durationMs: toNum(message.durationMs),
		ttftMs: null,
		stopReason,
		// 没有 usage 块 = 没拿到 token（老会话 / 中断），标 incomplete 而非 0
		status: errored ? "error" : usage ? "ok" : "incomplete",
		hasUsage: Boolean(usage),
		source: "backfill",
	};
}

/**
 * 解析一段 JSONL 文本（可能以半行结尾）。
 * @returns {{records:object[], lines:number, bad:number, tail:string, ctx:object}}
 */
export function parseSessionText(text, ctx = {}) {
	const records = [];
	const source = String(text ?? "");
	const lineList = source.split("\n");
	// 最后一段没有换行结尾 = 半行，留给下次（调用方据 consumed 决定 offset）
	const tail = lineList.pop() ?? "";
	let lines = 0;
	let bad = 0;
	for (const raw of lineList) {
		const line = raw.trim();
		if (!line) continue;
		lines++;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			bad++;
			continue;
		}
		const record = parseSessionEntry(entry, ctx);
		if (record) records.push(record);
	}
	return { records, lines, bad, tail, ctx };
}

/** yield 一次宏任务（回填必须让出事件循环，不能一口气读 200 个文件）。 */
function yieldToLoop() {
	return new Promise((resolve) => {
		if (typeof setImmediate === "function") setImmediate(resolve);
		else setTimeout(resolve, 0);
	});
}

/**
 * 会话回填器。
 *
 * @param {object} options
 * @param {object|null} options.fsApi `host.fs`（缺失或能力不足 → 只采 live）
 * @param {{root:string, source:string}} [options.rootInfo] resolveSessionsRoot 的结果
 * @param {Record<string,unknown>} [options.settings]
 * @param {Record<string,unknown>} [options.state] 上次的回填状态（会被就地更新）
 * @param {() => void} [options.persist] 状态变化后落盘
 * @param {(level:string, ...args:unknown[])=>void} [options.log]
 * @param {number} [options.days] 回填天数
 * @param {number} [options.maxFilesPerRun]
 * @param {number} [options.maxFileBytes]
 * @param {() => number} [options.now]
 */
export function createSessionImporter(options = {}) {
	const fsApi = options.fsApi ?? null;
	const log = typeof options.log === "function" ? options.log : () => {};
	const now = typeof options.now === "function" ? options.now : () => Date.now();
	const rootInfo = options.rootInfo ?? resolveSessionsRoot({ settings: options.settings });
	const root = rootInfo.root;
	const days = resolveBackfillDays(options.days);
	const maxFilesPerRun = Math.max(1, Math.trunc(Number(options.maxFilesPerRun) || MAX_FILES_PER_RUN));
	const maxFileBytes = Math.max(1, Math.trunc(Number(options.maxFileBytes) || MAX_FILE_BYTES));
	const persist = typeof options.persist === "function" ? options.persist : () => {};
	const state = options.state && typeof options.state === "object" ? options.state : { version: 1, root, files: {} };
	if (!state.files || typeof state.files !== "object") state.files = {};
	state.root = state.root ?? root;
	if (state.root !== root) {
		// 根目录换了 → 旧 offset 全部作废
		state.root = root;
		state.files = {};
	}
	let lastRun = null;

	function fsReady() {
		if (!fsApi) return false;
		return typeof fsApi.readTextPath === "function" || typeof fsApi.readPath === "function";
	}

	async function readStat(absPath) {
		if (typeof fsApi?.statPath !== "function") return { mtime: null, size: null };
		try {
			const st = await fsApi.statPath(absPath);
			return { mtime: toNum(st?.mtime), size: toNum(st?.size) };
		} catch (err) {
			return { mtime: null, size: null, error: classifyFsError(err) };
		}
	}

	/** 枚举 `<root>/<projectDir>/*.jsonl`（只两层，不递归）。 */
	async function scan() {
		const out = { files: [], errors: [], truncated: false };
		if (!fsReady()) {
			out.errors.push(classifyFsError(new Error("插件未声明读能力 fs:read")));
			return out;
		}
		let top = [];
		try {
			top = await fsApi.listPath(root);
		} catch (err) {
			out.errors.push(classifyFsError(err));
			return out;
		}
		const dirs = (Array.isArray(top) ? top : []).filter((e) => e && e.type === "dir" && toStr(e.name));
		for (const dir of dirs) {
			if (out.files.length >= MAX_SCAN_FILES) {
				out.truncated = true;
				break;
			}
			const projectDir = String(dir.name);
			let inner = [];
			try {
				inner = await fsApi.listPath(join(root, projectDir));
			} catch (err) {
				out.errors.push(classifyFsError(err));
				continue;
			}
			for (const entry of Array.isArray(inner) ? inner : []) {
				if (!entry || entry.type !== "file") continue;
				const name = toStr(entry.name);
				if (!name || !name.toLowerCase().endsWith(".jsonl")) continue;
				out.files.push({ path: join(root, projectDir, name), projectDir });
				if (out.files.length >= MAX_SCAN_FILES) {
					out.truncated = true;
					break;
				}
			}
		}
		return out;
	}

	/** 读一段并切出「已换行的完整部分」。 */
	function cutCompleteChunk(chunk, offset) {
		if (chunk.unit === "bytes") {
			const buf = chunk.buf;
			if (offset >= buf.length) return { text: "", nextOffset: buf.length };
			const tailBuf = buf.subarray(offset);
			const nl = tailBuf.lastIndexOf(0x0a);
			if (nl < 0) return { text: "", nextOffset: offset };
			return { text: tailBuf.subarray(0, nl + 1).toString("utf8"), nextOffset: offset + nl + 1 };
		}
		const text = chunk.text;
		if (offset >= text.length) return { text: "", nextOffset: text.length };
		const tail = text.slice(offset);
		const nl = tail.lastIndexOf("\n");
		if (nl < 0) return { text: "", nextOffset: offset };
		return { text: tail.slice(0, nl + 1), nextOffset: offset + nl + 1 };
	}

	/**
	 * 导入单个文件（增量）。
	 * @returns {{status:string, records:object[], bytes:number, error?:object}}
	 */
	async function importFile(file, statInfo) {
		const path = file.path;
		const prev = state.files[path] ?? null;
		const stat = statInfo ?? (await readStat(path));
		if (stat.error) return { status: "error", records: [], bytes: 0, error: stat.error };
		if (stat.size !== null && stat.size > maxFileBytes) {
			log("info", `跳过过大会话文件（>${Math.round(maxFileBytes / 1024 / 1024)}MB）：${path}`);
			return { status: "too-large", records: [], bytes: 0 };
		}
		if (prev && stat.size !== null && stat.mtime !== null && prev.size === stat.size && prev.mtime === stat.mtime) {
			return { status: "unchanged", records: [], bytes: 0 };
		}
		const sizeShrunk = prev && stat.size !== null && typeof prev.size === "number" && stat.size < prev.size;
		const offset = prev && !sizeShrunk ? toNum(prev.offset) ?? 0 : 0;
		const ctx =
			sizeShrunk || !prev?.ctx
				? { projectDir: file.projectDir, sessionFile: path }
				: { ...prev.ctx, projectDir: file.projectDir, sessionFile: path };

		let chunk;
		try {
			if (typeof fsApi.readPath === "function") {
				const buf = await fsApi.readPath(path);
				chunk = { unit: "bytes", buf: Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? "") };
			} else {
				const text = await fsApi.readTextPath(path, maxFileBytes);
				chunk = { unit: "chars", text: String(text ?? "") };
			}
		} catch (err) {
			return { status: "error", records: [], bytes: 0, error: classifyFsError(err) };
		}

		const cut = cutCompleteChunk(chunk, offset);
		const parsed = parseSessionText(cut.text, ctx);
		state.files[path] = {
			mtime: stat.mtime,
			size: stat.size,
			offset: cut.nextOffset,
			unit: chunk.unit,
			projectDir: file.projectDir,
			ctx: parsed.ctx,
			bad: (toNum(prev?.bad) ?? 0) + parsed.bad,
		};
		return {
			status: parsed.records.length > 0 || cut.nextOffset !== offset ? "read" : "unchanged",
			records: parsed.records,
			bytes: chunk.unit === "bytes" ? Math.max(0, cut.nextOffset - offset) : 0,
			lines: parsed.lines,
			bad: parsed.bad,
		};
	}

	/** 一个文件是否已经「读完到当前大小」（覆盖率里的「已导入」）。 */
	function isUpToDate(file) {
		const prev = state.files[file.path];
		if (!prev) return false;
		const size = file.stat?.size ?? null;
		const mtime = file.stat?.mtime ?? null;
		const sameSize = size === null || prev.size === size;
		const sameMtime = mtime === null || prev.mtime === mtime;
		return sameSize && sameMtime;
	}

	/**
	 * 跑一次回填：枚举 → 按 mtime 过滤天数 → 新→旧取前 N 个 → 逐个增量导入。
	 * 返回统计（`records` 里是本次新解析出的记录，交给调用方写账本）。
	 */
	async function run() {
		const startedAt = now();
		const summary = {
			ok: true,
			root,
			rootSource: rootInfo.source ?? "default",
			days,
			files: 0,
			read: 0,
			records: [],
			errors: [],
			skipped: { unchanged: 0, tooLarge: 0, tooOld: 0 },
			coverage: { imported: 0, eligible: 0, remaining: 0 },
			truncated: false,
			pending: 0,
			settled: 0,
			startedAt,
			finishedAt: startedAt,
		};
		if (!fsReady()) {
			summary.ok = false;
			summary.errors.push(classifyFsError(new Error("插件未声明读能力 fs:read")));
			summary.finishedAt = now();
			lastRun = summary;
			return summary;
		}
		const scanned = await scan();
		summary.truncated = scanned.truncated;
		for (const err of scanned.errors) summary.errors.push(err);
		// 目录级失败（未授权 / 目录不存在）必须显式 ok:false，前端据此显示授权按钮
		if (scanned.errors.some((e) => e.code === "denied" || e.code === "no-permission")) summary.ok = false;
		const cutoff = startedAt - days * DAY_MS;
		const candidates = [];
		for (const file of scanned.files) {
			const stat = await readStat(file.path);
			if (stat.error) {
				summary.errors.push(stat.error);
				continue;
			}
			if (stat.size !== null && stat.size > maxFileBytes) {
				log("info", `跳过过大会话文件（>${Math.round(maxFileBytes / 1024 / 1024)}MB）：${file.path}`);
				summary.skipped.tooLarge++;
				continue;
			}
			// mtime 未知（宿主没给 statPath）时按新文件处理，宁可多读一点都不漏数据
			if (stat.mtime !== null && stat.mtime < cutoff) {
				summary.skipped.tooOld++;
				continue;
			}
			candidates.push({ ...file, mtime: stat.mtime ?? 0, size: stat.size, stat });
		}
		// 先读「没读过 / 有变化」的文件，再读已经读完的：否则文件数超过批量上限时，
		// 老文件会被一直更新的新文件挤出批次，永远轮不到（真实会话有上千个文件）。
		const pending = [];
		const settled = [];
		for (const file of candidates) {
			const prev = state.files[file.path];
			const changed = !prev || prev.mtime !== file.stat.mtime || prev.size !== file.stat.size;
			(changed ? pending : settled).push(file);
		}
		pending.sort((a, b) => b.mtime - a.mtime);
		settled.sort((a, b) => b.mtime - a.mtime);
		summary.pending = pending.length;
		summary.settled = settled.length;
		const ordered = [...pending, ...settled];
		const batch = ordered.slice(0, maxFilesPerRun);
		const eligible = candidates.length;
		for (const file of batch) {
			const res = await importFile(file, file.stat);
			summary.files++;
			if (res.status === "error") {
				summary.errors.push(res.error);
			} else if (res.records.length > 0) {
				summary.read++;
				for (const record of res.records) summary.records.push(record);
			} else if (res.status === "unchanged") {
				summary.skipped.unchanged++;
			}
			await yieldToLoop();
		}
		summary.finishedAt = now();
		// 覆盖率：eligible = 本窗口内应扫的文件数（M），imported = 已经读完的（X）
		let imported = 0;
		for (const file of candidates) if (isUpToDate(file)) imported++;
		const remaining = Math.max(0, eligible - imported);
		summary.coverage = { imported, eligible, remaining };
		// truncated 必须表达「还没导完」：只按批次数切而不看进度的话，第二轮明明导完了还在喊导入中
		summary.truncated = summary.truncated || remaining > 0;
		state.lastRunAt = summary.finishedAt;
		state.lastRecords = summary.records.length;
		state.lastCoverage = summary.coverage;
		persist();
		lastRun = summary;
		return summary;
	}

	return {
		root,
		rootSource: rootInfo.source ?? "default",
		days,
		state,
		fsReady,
		scan,
		importFile,
		run,
		/** 去掉 `records` 的精简统计（给 /api/meta 用，别把几千条记录塞进 meta）。 */
		summary(from = lastRun) {
			if (!from) return null;
			const { records, ...rest } = from;
			return {
				...rest,
				records: Array.isArray(records) ? records.length : Number(records) || 0,
				errors: (from.errors ?? []).slice(0, 5),
			};
		},
	};
}

/** `~/.pi/agent/sessions` 这类绝对路径给不出可读名字时用的兜底标签。 */
export function sessionsRootLabel(root) {
	return toStr(root) ?? "";
}

export default createSessionImporter;
