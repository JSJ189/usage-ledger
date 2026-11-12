/**
 * v3 导入核心：会话目录扫描 + **流式**读取 + 行 → 明细行（在 worker 里跑）。
 *
 * 与 v2 `lib/sessions.mjs` 的关键差异（这是「回填卡死」的根治点）：
 *  - v2 每轮把整个文件 `readFile` 进内存（最大 73.6MB）再 split；
 *    这里一律 `createReadStream` + 1MB 分块 + 半行拼接，**峰值内存 ≈ 2×chunkBytes**。
 *  - 扫描只 `stat`（不读内容），按 mtime 新→旧排序，`maxFiles` 截断并给出 `truncated`。
 *  - 行解析、去重、跳过计数全部复用 `parser.mjs` 的状态机，
 *    「分块读完」与「一次性读完」产出**逐条相同**。
 *
 * 本文件不做 SQLite 写入（那是 `store.insertBatch` + worker 的事），
 * 只负责把文件变成行数组；调用方可按 `batchRows` 切片写入。
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { consumeSessionLines, createSessionParseState, classifyFsError } from "./parser.mjs";

/** 会话文件后缀。 */
export const SESSION_EXT = ".jsonl";
/** 默认单次读取块（1MB）。 */
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
/** `createReadStream` 高水位（1MB，与默认块对齐）。 */
export const HIGH_WATER_MARK = 1024 * 1024;

function slashPath(p) {
	return String(p ?? "").replace(/\\/g, "/");
}

/**
 * 扫会话目录：`<root>/<项目目录>/*.jsonl`（只两层，不递归；**只 stat 不读内容**）。
 *
 * @param {object} [options]
 * @param {string} options.root 会话根目录
 * @param {number} [options.sinceMs] 只保留 mtime ≥ 该时刻的文件（0 = 全收）
 * @param {number} [options.maxFiles] 最多返回多少个（按 mtime 新→旧截断）
 * @returns {{files: Array<{path:string, size:number, mtimeMs:number, rel:string}>, truncated: boolean,
 *            errors: Array<{path:string, code:string, message:string}>}}
 */
export function scanSessionFiles(options = {}) {
	const root = typeof options.root === "string" ? options.root : "";
	if (!root) throw new Error("scanSessionFiles: root 不能为空");
	const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Number(options.sinceMs) : 0;
	const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Math.max(0, Math.trunc(Number(options.maxFiles))) : Infinity;
	const files = [];
	const errors = [];

	let top = [];
	try {
		top = readdirSync(root, { withFileTypes: true });
	} catch (err) {
		errors.push({ path: root, code: String(err?.code ?? "fs-error"), message: String(err?.message ?? err) });
		return { files, truncated: false, errors };
	}

	for (const dir of top) {
		if (!dir.isDirectory()) continue;
		const projectDir = dir.name;
		let inner = [];
		try {
			inner = readdirSync(join(root, projectDir), { withFileTypes: true });
		} catch (err) {
			errors.push({
				path: slashPath(join(root, projectDir)),
				code: String(err?.code ?? "fs-error"),
				message: String(err?.message ?? err),
			});
			continue;
		}
		for (const entry of inner) {
			if (!entry.isFile()) continue;
			if (!entry.name.toLowerCase().endsWith(SESSION_EXT)) continue;
			const path = join(root, projectDir, entry.name);
			let st;
			try {
				st = statSync(path);
			} catch (err) {
				errors.push({ path: slashPath(path), code: String(err?.code ?? "fs-error"), message: String(err?.message ?? err) });
				continue;
			}
			if (st.mtimeMs < sinceMs) continue;
			files.push({
				path,
				size: st.size,
				mtimeMs: st.mtimeMs,
				rel: `${slashPath(projectDir)}/${entry.name}`,
			});
		}
	}

	// 新→旧；同 mtime 用 rel 排，保证两次扫描顺序一致（可复现的测试/日志）
	files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	const truncated = files.length > maxFiles;
	return { files: truncated ? files.slice(0, maxFiles) : files, truncated, errors };
}

/**
 * 读一个文件的一块（`createReadStream` + 1MB 高水位，**不整文件读入**）。
 *
 * @param {string} path
 * @param {{offset?:number, maxBytes?:number}} [options]
 * @returns {Promise<{buf: Buffer, bytesRead: number, nextOffset: number}>} 短读 = 到文件尾
 */
export async function readFileChunk(path, options = {}) {
	const offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
	const maxBytes = Math.max(1, Math.trunc(Number(options.maxBytes) || DEFAULT_CHUNK_BYTES));
	const stream = createReadStream(path, {
		start: offset,
		end: offset + maxBytes - 1,
		highWaterMark: Math.min(HIGH_WATER_MARK, maxBytes),
	});
	const parts = [];
	let total = 0;
	try {
		for await (const chunk of stream) {
			parts.push(chunk);
			total += chunk.length;
			if (total >= maxBytes) break; // break 会让流自动 destroy，不泄漏 fd
		}
	} catch (err) {
		stream.destroy();
		throw err;
	}
	const buf = parts.length === 0 ? Buffer.alloc(0) : parts.length === 1 ? parts[0] : Buffer.concat(parts, total);
	return { buf, bytesRead: buf.length, nextOffset: offset + buf.length };
}

/**
 * 切行：只切出**已换行**的完整行，最后一个换行之后的半行原样留在 `tail`（下次拼回来）。
 * 顺带吃掉行尾 `\r`（`\r\n` 容错）；多字节 UTF-8 字符不会在换行处被切断。
 *
 * @param {Buffer|Uint8Array|string} buf
 * @returns {{lines: string[], tail: Buffer|string}}
 */
export function splitLines(buf) {
	if (typeof buf === "string") {
		const all = buf.split("\n");
		const tail = all.pop() ?? "";
		return { lines: all.map(stripCr), tail };
	}
	const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
	const nl = bytes.lastIndexOf(0x0a);
	if (nl < 0) return { lines: [], tail: bytes };
	const lines = bytes.subarray(0, nl + 1).toString("utf8").split("\n");
	lines.pop(); // 以 \n 结尾 → 末尾空串
	for (let i = 0; i < lines.length; i++) lines[i] = stripCr(lines[i]);
	return { lines, tail: bytes.subarray(nl + 1) };
}

function stripCr(line) {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * 异步生成器：文件 → 块 → 行 → rows。
 *
 * 每**读完一个文件** yield 一次（调用方据 `stats` 记进度、据 `rows` 切片写库）：
 * `{ path, rel, size, mtimeMs, bytesRead, rows, stats }`。
 * 半行跨块拼接；文件尾没有换行的残行在 EOF 当作完整行消费。
 * 单个文件读失败（被 pi 轮转 / 删除）不会中断整个生成器：照常 yield，失败信息进
 * `stats.errors`（`classifyFsError` 形状），调用方据此记 `import/errors` 后继续下一个文件。
 *
 * @param {object} options
 * @param {string} options.root 会话根目录
 * @param {Array<{path:string, size:number, mtimeMs:number, rel:string}>} [options.files]
 *       省略则内部调 `scanSessionFiles`
 * @param {number} [options.sinceMs]
 * @param {number} [options.maxFiles]
 * @param {number} [options.chunkBytes] 单块字节数（默认 1MB）
 */
export async function* iterSessionRows(options = {}) {
	const root = options.root;
	const chunkBytes = Math.max(1, Math.trunc(Number(options.chunkBytes) || DEFAULT_CHUNK_BYTES));
	const files = Array.isArray(options.files)
		? options.files
		: scanSessionFiles({ root, sinceMs: options.sinceMs, maxFiles: options.maxFiles }).files;

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const state = createSessionParseState({ rel: file.rel, file: file.path, sessionsRoot: root });
		let offset = 0;
		let tail = Buffer.alloc(0);
		try {
			// 一直读到短读为止（不依赖扫描时的 size：文件可能在扫描后又长了）
			for (;;) {
				const read = await readFileChunk(file.path, { offset, maxBytes: chunkBytes });
				if (read.bytesRead === 0) break;
				offset = read.nextOffset;
				const combined = tail.length > 0 ? Buffer.concat([tail, read.buf], tail.length + read.bytesRead) : read.buf;
				const split = splitLines(combined);
				tail = split.tail;
				consumeSessionLines(state, split.lines);
			}
			// EOF：没有换行结尾的残行也是完整一行
			if (tail.length > 0) consumeSessionLines(state, [tail.toString("utf8")]);
		} catch (err) {
			state.stats.errors.push(classifyFsError(err));
		}
		yield {
			path: file.path,
			rel: state.rel,
			size: file.size,
			mtimeMs: file.mtimeMs,
			bytesRead: offset,
			rows: state.out,
			stats: state.stats,
		};
	}
}

