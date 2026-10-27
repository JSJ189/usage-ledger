/**
 * 发现链的沙箱依赖：把目录枚举锁在给定根内，绝不扫真盘。
 *
 * 为什么需要：`discoverDbPath` / `resolveDbPath` 默认会探测盘符根、已知安装位置、
 * pi 代理配置与真实环境变量。单测不能依赖开发机装了什么（也不能因为开发机装了
 * EasyCLIProxyAPI 就绿），所以这里注入：
 *  - `env: {}`：不读 LOCALAPPDATA / APPDATA / USERPROFILE / CLIPROXY_USAGE_DB；
 *  - `home`：指向不存在的临时目录，避免扫真家目录；
 *  - `readText`：一律 ENOENT，跳过 pi 代理配置；
 *  - `readDir`：只允许枚举 `root` 之下的目录，其它抛错（等价「不存在」）。
 */
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * @param {string} root 允许枚举的目录（临时目录）
 * @param {{ log?: Function, platform?: string, home?: string }} [extra]
 */
export function sandboxDeps(root, extra = {}) {
	const allowed = resolve(root).toLowerCase();
	const withinAllowed = (dir) => {
		const p = resolve(dir).toLowerCase();
		return p === allowed || p.startsWith(allowed.endsWith(sep) ? allowed : allowed + sep);
	};
	return {
		platform: extra.platform ?? "win32",
		env: {},
		home: extra.home ?? join(tmpdir(), "cps-no-such-home"),
		exists: () => false,
		readText: () => {
			throw new Error("ENOENT: sandbox");
		},
		readDir: (dir) => {
			if (!withinAllowed(dir)) throw new Error("EACCES: sandbox 只允许枚举临时目录");
			return readdirSync(dir, { withFileTypes: true });
		},
		log: extra.log ?? null,
	};
}

export default sandboxDeps;
