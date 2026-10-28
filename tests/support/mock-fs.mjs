/**
 * 单测用的 `host.fs` 替身：真实磁盘 + 权限门。
 *
 * 为什么不用全内存假 fs：跨目录读取的语义（Buffer 偏移、目录枚举、stat 的
 * mtime/size）用真实临时目录才有保真度；权限门用 `authorized` 模拟宿主的
 * 「目录未授权」抛错，`requestAccess()` 可授权（供「授权并导入历史」路径用）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 宿主的真实措辞（server/plugins.ts 的 crossDirFs），尽量对齐。 */
export const UNAUTHORIZED = "目录未授权：先 await host.fs.requestAccess(dir)";

export function createMockFs(options = {}) {
	const state = {
		authorized: options.authorized !== false,
		readOnly: options.readOnly !== false,
		requests: [],
		reads: 0,
		maxReadBytes: options.maxReadBytes ?? 0,
	};

	const guard = (abs) => {
		if (!state.authorized) throw new Error(`${UNAUTHORIZED}（${abs}）`);
	};

	const fs = {
		authorizedDirs: () => (state.authorized ? ["mock"] : []),
		requestAccess: async (dir, reason) => {
			state.requests.push({ dir, reason });
			if (options.grantOnRequest === false) return false;
			state.authorized = true;
			return true;
		},
		listPath: async (absDir) => {
			guard(absDir);
			return readdirSync(absDir, { withFileTypes: true }).map((e) => ({
				name: e.name,
				type: e.isDirectory() ? "dir" : "file",
			}));
		},
		readPath: async (absPath) => {
			guard(absPath);
			state.reads++;
			return readFileSync(absPath);
		},
		readTextPath: async (absPath, maxBytes) => {
			guard(absPath);
			state.reads++;
			const buf = readFileSync(absPath);
			const cap = Number(maxBytes) || buf.length;
			return buf.subarray(0, cap).toString("utf8");
		},
		statPath: async (absPath) => {
			guard(absPath);
			try {
				const st = statSync(absPath);
				return {
					name: absPath.split(/[/\\]/).pop() ?? absPath,
					type: st.isDirectory() ? "dir" : "file",
					size: st.isDirectory() ? 0 : st.size,
					mtime: Number(st.mtimeMs) || 0,
				};
			} catch (err) {
				const e = new Error(`ENOENT: ${absPath}`);
				e.code = "ENOENT";
				throw Object.assign(e, { cause: err });
			}
		},
		writePath: async (absPath, data) => {
			guard(absPath);
			if (state.readOnly) throw new Error("mock fs 只读");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(absPath, data);
		},
		/** 断言面 */
		state,
		/** 关掉授权（模拟「用户拒绝 / 没声明 fs:read」） */
		revoke: () => {
			state.authorized = false;
		},
		grant: () => {
			state.authorized = true;
		},
	};
	return fs;
}

/** 只读模式（缺 readPath，只有 readTextPath）的替身：覆盖「按字符偏移」退化路径。 */
export function createTextOnlyFs(options = {}) {
	const base = createMockFs(options);
	const { readPath: _drop, ...rest } = base;
	return rest;
}

export default createMockFs;
