/**
 * usage-ledger 服务端入口
 *
 * 职责（只读，不写账本）：
 *  1. 按固定链路发现 usage.db（每步都写 info 日志，见 discoverLedger）：
 *     设置项 dbPath → 环境变量 CLIPROXY_USAGE_DB → pi 代理配置 baseUrl 的端口 →
 *     已知安装位置 → 搜索根（只 readdir 两层，不递归整盘）；都找不到给结构化空态；
 *  2. 用 `node:sqlite` 的 `{ readOnly: true }` 复用单个只读连接，绝不起写事务；
 *  3. 聚合「请求数 / 成功率 / TTFT 分位 / 时延 / 输出速率 / token 用量」，
 *     按窗口（today | 7d | 30d）与客户端族（all | pi）出数；
 *  4. `host.route` 暴露 GET /api/summary、/api/series、/api/events；
 *  5. `host.schedule` 定时预热缓存（默认 60s），`host.registerBackgroundTask` 心跳，
 *     `host.effect` 登记 dispose，反激活时彻底释放连接与定时器；
 *  6. 账本缺失 / 被占用 / 路径非法一律优雅降级（明确空态文案 + 冷却期，不抛错、不刷屏）。
 *
 * 数字口径（与 docs / README 一致，勿混用）：
 *  - `ttft_ms` = 代理收到请求 → 上游首包；与 response-speed 插件的客户端 TTFT 口径不同；
 *  - 分位数为 nearest-rank，仅统计 `ttft_ms > 0` 的行（NULL 与 0 不参与）；
 *  - 失败口径：`failed = 1 OR canceled = 1` 计一次（canceled 通常是 failed 的子集，不重复计数）；
 *  - 速率 `tok/s` = output_tokens / ((latency_ms - ttft_ms) / 1000)，仅当
 *    `latency_ms > ttft_ms` 且 `output_tokens > 0` 的行参与均值。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { computeRowCost, createPriceBook, matchPrice, parsePriceOverrides, PRICE_STORAGE_KEY } from "./lib/prices.mjs";

const BADGE_ID = "usage-ledger-badge";
const DAY_MS = 86_400_000;
const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 10_000;
const MAX_TTL_MS = 3_600_000;
/** 失败后的冷却期：冷却期内直接回上次的降级结果，不重复尝试打开 / 查询。 */
const FAIL_COOLDOWN_MS = 30_000;
/** 路径解析结果的短缓存（自动发现要 readdir 根目录，不能每请求都扫）。 */
const PATH_CACHE_MS = 10_000;
/** 聚合缓存条目上限（键含 window/client/groupBy/limit，防长跑进程无界增长）。 */
const CACHE_MAX_ENTRIES = 64;
const MAX_EVENT_LIMIT = 100;
const DEFAULT_EVENT_LIMIT = 20;
/** 小时聚合用本地时区（与服务端进程同口径，与「今日」日界一致）。 */
const HOUR_SQL = "strftime('%Y-%m-%dT%H:00:00', timestamp_ms / 1000, 'unixepoch', 'localtime')";
const MODEL_SQL = "COALESCE(NULLIF(model, ''), '(unknown)')";
/** 客户端族归一（与 JS 侧 clientFamily 同口径）：其余一律 other。 */
const CLIENT_DIM_SQL = `CASE
		WHEN user_agent IS NULL OR trim(user_agent) = '' THEN 'other'
		WHEN lower(user_agent) = 'pi' OR lower(user_agent) LIKE 'pi %' OR lower(user_agent) LIKE 'pi/%' THEN 'pi'
		WHEN lower(user_agent) LIKE 'zcode/%' THEN 'zcode'
		WHEN lower(user_agent) LIKE 'claude-cli/%' THEN 'claude-cli'
		WHEN lower(user_agent) LIKE 'bun/%' THEN 'bun'
		ELSE 'other'
	END`;

/**
 * 分组维度（`groupBy` 白名单）：SQL 表达式是固定字面量，值只来自这张表，
 * 请求参数永远不参与拼接。
 */
export const GROUP_DIMS = {
	model: MODEL_SQL,
	provider: "COALESCE(NULLIF(provider, ''), '(unknown)')",
	executor: "COALESCE(NULLIF(executor_type, ''), '(unknown)')",
	endpoint: "COALESCE(NULLIF(endpoint, ''), '(unknown)')",
	client: CLIENT_DIM_SQL,
};
export const GROUP_KEYS = Object.keys(GROUP_DIMS);

/** 分组维度白名单（非法值回落 model）。 */
export function normalizeGroupBy(key) {
	return GROUP_KEYS.includes(key) ? key : "model";
}

export const WINDOW_KEYS = ["today", "7d", "30d"];
export const CLIENT_KEYS = ["all", "pi"];
/** 客户端族过滤：只按 user_agent 前缀区分「pi 家族」；无法区分 pi-web-ui 与 pi CLI。 */
const PI_UA_SQL = "(lower(user_agent) = 'pi' OR lower(user_agent) LIKE 'pi %' OR lower(user_agent) LIKE 'pi/%')";

// ──────────────────────────────────────────────────────────── 窗口与过滤

/**
 * 解析时间窗口。`today` = 进程本地时区的当日 00:00 起；`7d`/`30d` = 滚动 7/30×24h。
 * @param {unknown} key 客户端传入的窗口键（非法一律回落 today）
 * @param {number} [nowMs] 供测试注入的「现在」
 */
export function resolveWindow(key, nowMs = Date.now()) {
	const k = WINDOW_KEYS.includes(key) ? key : "today";
	if (k === "today") {
		const d = new Date(nowMs);
		const fromMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		return { key: k, fromMs, nowMs };
	}
	const days = k === "7d" ? 7 : 30;
	return { key: k, fromMs: nowMs - days * DAY_MS, nowMs };
}

/** 客户端族白名单（非法值回落 all，绝不把请求体内容拼进 SQL）。 */
export function normalizeClient(key) {
	return CLIENT_KEYS.includes(key) ? key : "all";
}

/** 组装 WHERE：只用 `?` 占位符，条件片段是固定字面量。 */
function buildWhere(window, client) {
	const parts = ["timestamp_ms >= ?"];
	const params = [window.fromMs];
	if (normalizeClient(client) === "pi") parts.push(PI_UA_SQL);
	return { sql: parts.join(" AND "), params };
}

// ──────────────────────────────────────────────────────────── 路径解析与校验

// ── 账本发现（跨平台、按顺序、每步可观测）

/** 自动发现单层目录的条目上限：超过即跳过该层（防超大根目录拖住事件循环）。 */
export const DISCOVERY_MAX_ENTRIES = 500;
/** 自动发现的最大深度：只 readdir 两层，绝不递归整盘。 */
export const DISCOVERY_MAX_DEPTH = 2;
/** 账本相对代理数据目录的路径。 */
export const LEDGER_RELATIVE = ["usage-records", "usage.db"];
/** 代理目录名匹配（CLIProxyAPI / EasyCLIProxyAPI / cliproxyapi，大小写不敏感）。 */
export const LEDGER_DIR_RE = /cliproxyapi/i;
/** 手动指定账本的环境变量（优先级仅次于设置项）。 */
export const DB_ENV_VAR = "CLIPROXY_USAGE_DB";

/** 发现来源标签（`meta.pathSource` 与日志共用）。 */
export const PATH_SOURCE_LABELS = {
	setting: "设置项 dbPath",
	env: "环境变量 CLIPROXY_USAGE_DB",
	"agent-config": "pi 代理配置 baseUrl 端口",
	"known-location": "已知安装位置",
	"search-root": "搜索根目录",
};

/**
 * 发现链的依赖（默认取真实平台；单测注入后与真机隔离，不会误命中本机真库）。
 * @param {{ platform?: string, env?: object, home?: string, exists?: Function, readText?: Function, log?: Function }} [overrides]
 */
export function discoveryDeps(overrides = {}) {
	return {
		platform: overrides.platform ?? process.platform,
		env: overrides.env ?? process.env,
		home: overrides.home ?? homedir(),
		exists: overrides.exists ?? ((p) => existsSync(p)),
		readText: overrides.readText ?? ((file) => readFileSync(file, "utf8")),
		// 目录枚举可注入：单测里限制在临时目录，绝不扫真盘
		readDir: overrides.readDir ?? ((dir) => readdirSync(dir, { withFileTypes: true })),
		log: overrides.log ?? null,
	};
}

/** Windows 盘符根：只 existsSync 探测，不遍历。 */
export function windowsDriveRoots(deps = discoveryDeps()) {
	const roots = [];
	for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
		const root = `${letter}:\\`;
		try {
			if (deps.exists(root)) roots.push(root);
		} catch {
			/* 无权限 / 不含该盘：跳过 */
		}
	}
	return roots;
}

/** 已知安装位置的候选目录（逐个 existsSync，不递归）。 */
export function knownCandidateDirs(deps = discoveryDeps()) {
	const dirs = [];
	const push = (p) => {
		if (p && !dirs.includes(p)) dirs.push(p);
	};
	if (deps.platform === "win32") {
		for (const key of ["LOCALAPPDATA", "APPDATA", "USERPROFILE"]) {
			const base = deps.env?.[key];
			if (!base) continue;
			for (const name of ["CLIProxyAPI", "EasyCLIProxyAPI"]) push(join(base, name));
		}
		return dirs;
	}
	push(join(deps.home, ".local", "share", "cliproxyapi"));
	push(join(deps.home, "CLIProxyAPI"));
	push(join(deps.home, ".config", "cliproxyapi"));
	push("/opt/cliproxyapi");
	return dirs;
}

/** 自动发现时扫描的根目录（设置项 searchRoots 可整体覆盖）。 */
export function defaultSearchRoots(deps = discoveryDeps()) {
	if (deps.platform === "win32") {
		const roots = windowsDriveRoots(deps);
		return roots.length ? roots : ["C:\\"];
	}
	return [join(deps.home, ".local", "share"), deps.home, "/opt", "/usr/local"];
}

/** 从 baseUrl 抠端口（`http://127.0.0.1:8317` → 8317；无端口回 null）。 */
export function portOf(baseUrl) {
	const m = String(baseUrl ?? "").match(/:(\d{2,5})(?:[/?#]|$)/);
	if (!m) return null;
	const port = Number(m[1]);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * 读 pi 代理配置（默认 `~/.pi/agent/cliproxyapi.json`，`PI_CODING_AGENT_DIR` 可改目录），
 * 取出 baseUrl 的端口。读不到 / 解析失败一律返回带 error 的对象，不抛错。
 * @returns {{ file: string, baseUrl: string, port: number|null, error?: string } | null}
 */
export function readAgentProxyConfig(deps = discoveryDeps()) {
	const dir = String(deps.env?.PI_CODING_AGENT_DIR ?? "").trim() || join(deps.home, ".pi", "agent");
	const file = join(dir, "cliproxyapi.json");
	let text;
	try {
		text = deps.readText(file);
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { file, baseUrl: "", port: null, error: "配置不是合法 JSON" };
	}
	const baseUrl = typeof parsed?.baseUrl === "string" ? parsed.baseUrl.trim() : "";
	return { file, baseUrl, port: portOf(baseUrl) };
}

/** `<dir>/usage-records/usage.db` 是否是存在的普通文件（只 stat，只读）。 */
function ledgerUnder(dir) {
	const file = join(dir, ...LEDGER_RELATIVE);
	try {
		const st = statSync(file);
		return st.isFile() ? { file, mtimeMs: st.mtimeMs } : null;
	} catch {
		return null;
	}
}

/**
 * 校验用户配置的 dbPath：必须是绝对路径、必须以 .db 结尾、不允许出现 `..` 段
 * （防目录穿越式拼接），且必须是存在的普通文件。
 * @param {unknown} input 设置项原值
 * @returns {{ ok: true, path: string } | { ok: false, reason: string, reasonEn: string }}
 */
export function validateDbPath(input) {
	if (typeof input !== "string") {
		return { ok: false, reason: "账本路径必须是字符串", reasonEn: "dbPath must be a string" };
	}
	const raw = input.trim();
	if (!raw) return { ok: false, reason: "账本路径为空", reasonEn: "dbPath is empty" };
	if (raw.includes("\0")) return { ok: false, reason: "账本路径含非法字符", reasonEn: "dbPath contains NUL" };
	const segments = raw.split(/[\\/]+/);
	if (segments.includes("..")) {
		return { ok: false, reason: "账本路径不允许包含 ..（目录穿越）", reasonEn: "dbPath must not contain '..'" };
	}
	// UNC（\\server\share）一律拒：会触发 SMB 凭据协商，且与「本机代理账本」语义不符
	if (/^\\\\/.test(raw)) {
		return { ok: false, reason: "账本路径不支持网络共享（UNC）", reasonEn: "dbPath must not be a UNC path" };
	}
	if (!isAbsolute(raw)) {
		return { ok: false, reason: "账本路径必须是绝对路径", reasonEn: "dbPath must be an absolute path" };
	}
	if (!/\.db$/i.test(raw)) {
		return { ok: false, reason: "账本路径必须以 .db 结尾", reasonEn: "dbPath must end with .db" };
	}
	const abs = normalize(raw);
	let stat = null;
	try {
		stat = statSync(abs);
	} catch {
		return { ok: false, reason: `账本文件不存在：${abs}`, reasonEn: `ledger file not found: ${abs}` };
	}
	if (!stat.isFile()) return { ok: false, reason: "账本路径不是普通文件", reasonEn: "dbPath is not a regular file" };
	return { ok: true, path: abs };
}

/** 从目录名里抠出版本号数组（`EasyCLIProxyAPI-v0.2.25-Windows-amd64` → [0,2,25]）。 */
function parseVersion(name) {
	const m = String(name).match(/(\d+(?:\.\d+)+)/);
	return m ? m[1].split(".").map((n) => Number(n) || 0) : null;
}

/** 版本数组降序比较（无版本号的排最后）。 */
function compareVersionDesc(a, b) {
	if (!a.ver && !b.ver) return 0;
	if (!a.ver) return 1;
	if (!b.ver) return -1;
	const len = Math.max(a.ver.length, b.ver.length);
	for (let i = 0; i < len; i++) {
		const d = (b.ver[i] ?? 0) - (a.ver[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/**
 * 在一个根目录里找账本：**只 readdir 两层**，绝不递归整盘。
 *  - 第一层：目录名匹配 `LEDGER_DIR_RE` 的，试 `<root>/<dir>/usage-records/usage.db`；
 *  - 第二层：仅对命中的第一层目录再 readdir 一层（解包后多一层版本目录的布局）；
 *  - `loose=true`（/opt 这类系统安装根）第一层不要求目录名匹配；
 *  - 单层条目 > DISCOVERY_MAX_ENTRIES 直接跳过并记日志。
 * @returns {{ found: Array<{file:string,mtimeMs:number,dirName:string,ver:number[]|null}>, skipped: string[], scanned: string[] }}
 */
export function scanRootForLedger(root, deps = discoveryDeps(), options = {}) {
	const loose = options.loose === true;
	const found = [];
	const skipped = [];
	const scanned = [root];
	const readLevel = (dir) => {
		let entries = [];
		try {
			entries = deps.readDir(dir);
		} catch {
			return null; // 不存在 / 无权限：正常降级
		}
		if (entries.length > DISCOVERY_MAX_ENTRIES) {
			skipped.push(dir);
			deps.log?.("info", `[usage-ledger] 跳过 ${dir}：条目 ${entries.length} > ${DISCOVERY_MAX_ENTRIES}`);
			return null;
		}
		return entries;
	};
	const hit = (dir, dirName) => {
		const led = ledgerUnder(dir);
		if (!led) return false;
		found.push({ file: led.file, mtimeMs: led.mtimeMs, dirName: String(dirName ?? dir), ver: parseVersion(dirName) });
		return true;
	};
	const level1 = readLevel(root);
	if (!level1) return { found, skipped, scanned };
	hit(root, root); // 搜索根本身就是代理目录时（如 %LOCALAPPDATA%\CLIProxyAPI）
	for (const entry of level1) {
		if (!entry.isDirectory()) continue;
		if (!loose && !LEDGER_DIR_RE.test(entry.name)) continue;
		const dir1 = join(root, entry.name);
		if (hit(dir1, entry.name)) continue; // 深一层优先，找到就不下钻
		if (DISCOVERY_MAX_DEPTH < 2) continue;
		const level2 = readLevel(dir1);
		if (!level2) continue;
		for (const sub of level2) {
			if (!sub.isDirectory()) continue;
			scanned.push(join(dir1, sub.name));
			hit(join(dir1, sub.name), sub.name);
		}
	}
	return { found, skipped, scanned };
}

/**
 * 在给定搜索根里找账本，返回版本号最新（同版本比 mtime）的那一个路径。
 * @param {string[]} [roots] 搜索根（缺省走 defaultSearchRoots）
 * @returns {string | null}
 */
export function discoverDbPath(roots, deps = discoveryDeps()) {
	const list = Array.isArray(roots) && roots.length ? roots : defaultSearchRoots(deps);
	const candidates = [];
	for (const root of list) {
		if (!root) continue;
		candidates.push(...scanRootForLedger(root, deps, { loose: false }).found);
	}
	if (!candidates.length) return null;
	candidates.sort((a, b) => compareVersionDesc(a, b) || b.mtimeMs - a.mtimeMs);
	return candidates[0].file;
}

/** 端口在路径里出现则优先（同机多实例时选对那一个）。 */
function portRank(entry, port) {
	return port && String(entry.dirName ?? "").includes(String(port)) ? 1 : 0;
}

/**
 * 完整发现链（顺序固定，每一步都写 info 日志）：
 *  1. 设置项 `dbPath`（手动指定，最高优先；非法即报错，不静默回落到另一份数据）
 *  2. 环境变量 `CLIPROXY_USAGE_DB`
 *  3. pi 代理配置 `baseUrl` 的端口 → 已知安装位置里按端口找
 *  4. 已知安装位置 + 搜索根（只 readdir 两层）
 *  5. 都没有 → 结构化空态 `db-not-found`（带已尝试的候选路径，不抛错）
 * 设置项 `autoDiscover: false` 关掉第 3、4 步。
 * @param {{ dbPath?: unknown, searchRoots?: unknown, autoDiscover?: unknown }} settings
 * @param {object} [overrides] 依赖注入（测试用）
 */
export function discoverLedger(settings = {}, overrides = {}) {
	const deps = discoveryDeps(overrides);
	const candidates = [];
	const note = (msg) => {
		try {
			deps.log?.("info", `[usage-ledger] ${msg}`);
		} catch {
			/* 日志失败不影响发现 */
		}
	};
	const tried = (p) => {
		const s = typeof p === "string" ? p.trim() : "";
		if (s && !candidates.includes(s)) candidates.push(s);
	};
	let configFile = null;
	const notFound = (reason, reasonEn) => ({
		ok: false,
		code: "db-not-found",
		reason,
		reasonEn,
		hint: "在设置里填 usage.db 绝对路径",
		hintEn: "Set the absolute path to usage.db in settings",
		candidates,
		// 代理配置文件不是账本候选：单独字段给出，避免前端把它当候选路径展示
		configFile: configFile ?? null,
		path: "",
	});

	// 1. 设置项
	const configured = typeof settings.dbPath === "string" ? settings.dbPath.trim() : "";
	if (configured) {
		const v = validateDbPath(configured);
		if (!v.ok) {
			note(`设置项 dbPath 非法：${v.reason}`);
			return {
				ok: false,
				code: "bad-path",
				reason: v.reason,
				reasonEn: v.reasonEn,
				hint: "改设置里的「账本路径」，填 usage.db 的绝对路径",
				hintEn: "Fix the ledger path setting (absolute path to usage.db)",
				candidates: [configured],
				path: configured,
			};
		}
		note(`命中设置项 dbPath：${v.path}`);
		return { ok: true, path: v.path, source: "setting", candidates: [v.path] };
	}

	// 2. 环境变量
	const envRaw = String(deps.env?.[DB_ENV_VAR] ?? "").trim();
	if (envRaw) {
		tried(envRaw);
		const v = validateDbPath(envRaw);
		if (v.ok) {
			note(`命中环境变量 ${DB_ENV_VAR}：${v.path}`);
			return { ok: true, path: v.path, source: "env", candidates: [v.path] };
		}
		note(`环境变量 ${DB_ENV_VAR} 不可用（${v.reason}），继续自动发现`);
	}

	// 3、4 属于自动发现，可被设置项关闭
	if (settings.autoDiscover === false) {
		note("autoDiscover=false，跳过自动发现");
		return notFound("自动发现已关闭（autoDiscover=false），且未配置 dbPath", "Auto-discovery disabled (autoDiscover=false) and no dbPath configured");
	}

	// 3. 代理配置的端口
	const agentCfg = readAgentProxyConfig(deps);
	let port = null;
	if (agentCfg) {
		// 配置文件只用于推断端口：记到 configFile，不进 candidates（候选列表只放账本路径）
		configFile = agentCfg.file;
		if (agentCfg.port) {
			port = agentCfg.port;
			note(`读到代理配置 baseUrl 端口 ${port}（${agentCfg.file}）`);
			const portDirs = [];
			for (const base of knownCandidateDirs(deps)) portDirs.push(join(base, String(port)), base);
			for (const root of defaultSearchRoots(deps)) portDirs.push(join(root, String(port)));
			for (const dir of portDirs) {
				tried(dir);
				const led = ledgerUnder(dir);
				if (led) {
					note(`按端口 ${port} 命中账本：${led.file}`);
					return { ok: true, path: led.file, source: "agent-config", candidates: [led.file] };
				}
			}
			note(`端口 ${port} 未直接命中目录，转入已知位置 / 搜索根扫描`);
		} else {
			note(`代理配置没有可用端口（${agentCfg.error ?? agentCfg.file}）`);
		}
	} else {
		note("未找到 pi 代理配置，跳过端口推断");
	}

	// 4a. 已知安装位置
	const known = knownCandidateDirs(deps);
	const hits = [];
	for (const dir of known) {
		tried(dir);
		const led = ledgerUnder(dir);
		if (led) hits.push({ file: led.file, mtimeMs: led.mtimeMs, dirName: dir, ver: parseVersion(dir) });
	}
	if (hits.length) {
		hits.sort((a, b) => portRank(b, port) - portRank(a, port) || compareVersionDesc(a, b) || b.mtimeMs - a.mtimeMs);
		note(`命中已知安装位置：${hits[0].file}`);
		return { ok: true, path: hits[0].file, source: "known-location", candidates: [hits[0].file] };
	}
	note(`已知安装位置未命中（试过 ${known.length} 个）`);

	// 4b. 搜索根（设置项 searchRoots 整体覆盖默认根）
	const customRoots = splitRoots(settings.searchRoots);
	const roots = customRoots ?? defaultSearchRoots(deps);
	const collected = [];
	const scanned = [];
	for (const root of roots) {
		tried(root);
		const loose = deps.platform !== "win32" && (root === "/opt" || root === "/usr/local");
		const res = scanRootForLedger(root, deps, { loose });
		scanned.push(...res.scanned);
		collected.push(...res.found);
	}
	if (collected.length) {
		collected.sort((a, b) => portRank(b, port) - portRank(a, port) || compareVersionDesc(a, b) || b.mtimeMs - a.mtimeMs);
		note(`搜索根命中账本：${collected[0].file}`);
		return { ok: true, path: collected[0].file, source: "search-root", candidates: [collected[0].file] };
	}

	// 5. 都没有：结构化空态，绝不抛错、绝不静默回退到 0 数据
	const triedAll = candidates.slice(0, 40).concat(scanned.filter((p) => !candidates.includes(p)).slice(0, 20));
	note(`未找到账本：试过 ${triedAll.length} 个位置，搜索根 ${roots.join(", ")}`);
	return notFound(
		`未找到代理用量账本 usage.db（已试 ${triedAll.length} 个位置）`,
		`No proxy usage ledger found (tried ${triedAll.length} locations)`,
	);
}

/**
 * 解析最终账本路径（发现链见 discoverLedger）。
 * @param {{ dbPath?: unknown, searchRoots?: unknown, autoDiscover?: unknown }} settings
 * @param {object} [overrides] 依赖注入（测试用）
 */
export function resolveDbPath(settings = {}, overrides = {}) {
	return discoverLedger(settings, overrides);
}

/** 搜索根设置项 → 目录数组（分号/逗号分隔；非法条目丢弃）。 */
function splitRoots(value) {
	if (typeof value !== "string" || !value.trim()) return null;
	const list = value
		.split(/[;,]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && !s.includes("\0"))
		.filter((s) => isAbsolute(s))
		.map((s) => normalize(s));
	return list.length ? list : null;
}

// ──────────────────────────────────────────────────────────── SQLite 只读连接

/** 分类 SQLite 错误：busy/locked 与「文件不见了」要分开给文案。 */
export function classifyDbError(err) {
	const code = String(err?.code ?? err?.errcode ?? "");
	const msg = String(err?.message ?? err ?? "");
	const all = `${code} ${msg}`.toUpperCase();
	if (all.includes("SQLITE_BUSY") || all.includes("SQLITE_LOCKED") || all.includes("DATABASE IS LOCKED")) {
		return {
			code: "busy",
			reason: "账本正被代理占用（SQLITE_BUSY/LOCKED），稍后自动重试",
			reasonEn: "Ledger is locked by the proxy (SQLITE_BUSY/LOCKED); will retry later",
		};
	}
	if (
		all.includes("SQLITE_CANTOPEN") ||
		all.includes("ENOENT") ||
		all.includes("NO SUCH FILE") ||
		all.includes("UNABLE TO OPEN")
	) {
		return {
			code: "missing",
			reason: "账本文件无法打开（可能已被移动或删除）",
			reasonEn: "Ledger file cannot be opened (moved or deleted?)",
		};
	}
	if (all.includes("NO SUCH TABLE")) {
		return {
			code: "schema",
			reason: "账本缺少 usage_events 表（不是兼容 schema 的用量账本）",
			reasonEn: "Ledger has no usage_events table (not a compatible usage ledger)",
		};
	}
	return {
		code: "error",
		reason: `读取账本失败：${msg.slice(0, 200)}`,
		reasonEn: `Failed to read ledger: ${msg.slice(0, 200)}`,
	};
}

/**
 * 只读打开 usage.db（`node:sqlite`）。绝不写盘：readOnly + 只发 PRAGMA/SELECT。
 * @param {string} file 绝对路径
 */
export async function openReadOnlyDb(file) {
	const mod = await import("node:sqlite");
	const DatabaseSync = mod.DatabaseSync ?? mod.default?.DatabaseSync;
	if (!DatabaseSync) throw new Error("当前 Node 不支持 node:sqlite（需 ≥22.13）");
	// readOnly：任何写事务都会被 SQLite 拒绝（含 VACUUM / 建表），E: 盘原件零改动。
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		// 两个都是**连接级**设置，不写库：
		//  - busy_timeout：避免代理侧 checkpoint 时立刻抛 SQLITE_BUSY；
		//  - query_only：显式禁止本连接发出任何写语句（readOnly 之上再加一道）。
		db.exec("PRAGMA busy_timeout = 2000");
		db.exec("PRAGMA query_only = ON");
	} catch {
		/* 被拒也没关系：readOnly 仍在，靠上层冷却降级 */
	}
	return db;
}

// ──────────────────────────────────────────────────────────── 聚合（纯函数）

/** nearest-rank 分位：pos = round(p*(n-1))，0 基（与 JS 端取数口径一致）。 */
export function percentilePos(p, n) {
	if (!Number.isFinite(n) || n <= 0) return null;
	const idx = Math.round(p * (n - 1));
	return Math.min(n - 1, Math.max(0, idx));
}

/** JS 侧 nearest-rank（供分位 SQL 的单元自检与真库脚本使用）。 */
export function percentileOf(sortedValues, p) {
	const n = sortedValues.length;
	const idx = percentilePos(p, n);
	if (idx === null) return null;
	return sortedValues[idx];
}

/** 一条 SQL 取某维度（grp）的 nearest-rank 分位，返回 Map<grp, {n,p50,p90,p99,avg}>。 */
function percentileBy(db, groupSql, whereSql, params) {
	const sql = `WITH src AS (
			SELECT ${groupSql} AS grp, ttft_ms AS ttft
			FROM usage_events
			WHERE ${whereSql} AND ttft_ms IS NOT NULL AND ttft_ms > 0
		), ranked AS (
			SELECT grp, ttft,
				ROW_NUMBER() OVER (PARTITION BY grp ORDER BY ttft) AS rn,
				COUNT(*) OVER (PARTITION BY grp) AS n
			FROM src
		)
		SELECT grp AS grp, COUNT(*) AS n,
			MAX(CASE WHEN rn = CAST(ROUND(0.50 * (n - 1)) AS INTEGER) + 1 THEN ttft END) AS p50,
			MAX(CASE WHEN rn = CAST(ROUND(0.90 * (n - 1)) AS INTEGER) + 1 THEN ttft END) AS p90,
			MAX(CASE WHEN rn = CAST(ROUND(0.99 * (n - 1)) AS INTEGER) + 1 THEN ttft END) AS p99,
			AVG(ttft) AS avg
		FROM ranked
		GROUP BY grp`;
	const out = new Map();
	for (const row of db.prepare(sql).all(...params)) {
		out.set(String(row.grp), {
			n: Number(row.n) || 0,
			p50: row.p50 === null ? null : Number(row.p50),
			p90: row.p90 === null ? null : Number(row.p90),
			p99: row.p99 === null ? null : Number(row.p99),
			avg: row.avg === null ? null : Number(row.avg),
		});
	}
	return out;
}

/** 计数 / 时延 / 速率 / token 的通用聚合片段（同一份口径给总量与分组用）。 */
const AGG_COLUMNS = `COUNT(*) AS calls,
	SUM(CASE WHEN failed = 1 OR canceled = 1 THEN 1 ELSE 0 END) AS bad,
	SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END) AS failed,
	SUM(CASE WHEN canceled = 1 THEN 1 ELSE 0 END) AS canceled,
	AVG(CASE WHEN latency_ms > 0 THEN latency_ms END) AS latency_avg,
	MAX(CASE WHEN latency_ms > 0 THEN latency_ms END) AS latency_max,
	AVG(CASE WHEN latency_ms > ttft_ms AND output_tokens > 0 THEN output_tokens * 1000.0 / (latency_ms - ttft_ms) END) AS tokps_avg,
	SUM(CASE WHEN latency_ms > ttft_ms AND output_tokens > 0 THEN 1 ELSE 0 END) AS tokps_n,
	SUM(CAST(input_tokens AS REAL)) AS input_tokens,
	SUM(CAST(output_tokens AS REAL)) AS output_tokens,
	SUM(CAST(reasoning_tokens AS REAL)) AS reasoning_tokens,
	SUM(CAST(cache_read_tokens AS REAL)) AS cache_read_tokens,
	SUM(CAST(cache_creation_tokens AS REAL)) AS cache_creation_tokens,
	SUM(CAST(total_tokens AS REAL)) AS total_tokens`;

/** 行 → 指标对象（除零一律回 null，不吐 NaN/Infinity）。 */
function toMetrics(row) {
	const calls = Number(row?.calls) || 0;
	const bad = Number(row?.bad) || 0;
	const failed = Number(row?.failed) || 0;
	const canceled = Number(row?.canceled) || 0;
	const tokpsN = Number(row?.tokps_n) || 0;
	return {
		calls,
		failed,
		canceled,
		bad,
		success: Math.max(0, calls - bad),
		successRate: calls > 0 ? (calls - bad) / calls : null,
		latencyAvg: row?.latency_avg === null || row?.latency_avg === undefined ? null : Number(row.latency_avg),
		latencyMax: row?.latency_max === null || row?.latency_max === undefined ? null : Number(row.latency_max),
		tokPerSec: row?.tokps_avg === null || row?.tokps_avg === undefined ? null : Number(row.tokps_avg),
		tokPerSecSamples: tokpsN,
		tokens: {
			input: Number(row?.input_tokens) || 0,
			output: Number(row?.output_tokens) || 0,
			reasoning: Number(row?.reasoning_tokens) || 0,
			cacheRead: Number(row?.cache_read_tokens) || 0,
			cacheCreation: Number(row?.cache_creation_tokens) || 0,
			total: Number(row?.total_tokens) || 0,
		},
	};
}

// ──────────────────────────────────────────────── 成本（估算，未知价一律 null）

/** 一个成本桶：只累加有价的请求，未知价单独计数（绝不把未知当 0）。 */
function newCostBucket() {
	return { amount: 0, pricedCalls: 0, unknownCalls: 0, unknownBasisCalls: 0, multiSourceCalls: 0 };
}

function addCost(bucket, cost) {
	if (!bucket) return;
	if (cost === null) {
		bucket.unknownCalls += 1;
		return;
	}
	bucket.amount += cost.amount;
	bucket.pricedCalls += 1;
	// 跨源价格分歧的行：单独计数，与未知价互不干扰
	if (cost.multiSource === true) bucket.multiSourceCalls += 1;
	if (cost.outputBasis === "unknown") bucket.unknownBasisCalls += 1;
}

/**
 * 桶 → 下发形状。
 * - `amount`：**只累加有价请求**；一条有价都没有时是 `null`（绝不是 0，未知价不进分子）。
 * - `unknownCalls`：被排除在金额之外的请求数；`unknownRatio` = unknownCalls / 该桶总请求数，
 *   总请求数为 0 时是 `null`（不是 0，避免「0 请求 = 100% 未知」这种假信号）。
 * - `unknownRate`：旧字段名，值与 `unknownRatio` 相同，仅为兼容保留。
 * - `multiSourceCalls`：金额里用了「跨源价格分歧」价的请求数（价表里同模型多源报价不一致）；
 *   `multiSourceRatio` = multiSourceCalls / 该桶总请求数，总请求数为 0 时是 `null`。
 * @param {{ amount: number, pricedCalls: number, unknownCalls: number, unknownBasisCalls: number, multiSourceCalls?: number } | null} bucket
 * @param {number} [totalCalls] 该桶的请求总数（缺省用 priced + unknown）
 */
export function costOf(bucket, totalCalls) {
	if (!bucket) return null;
	const sampled = bucket.pricedCalls + bucket.unknownCalls;
	const declared = Number(totalCalls);
	const total = Number.isFinite(declared) ? Math.max(sampled, Math.trunc(declared)) : sampled;
	const ratio = total > 0 ? bucket.unknownCalls / total : null;
	const multiSourceCalls = Number(bucket.multiSourceCalls) || 0;
	return {
		amount: bucket.pricedCalls > 0 ? bucket.amount : null,
		pricedCalls: bucket.pricedCalls,
		unknownCalls: bucket.unknownCalls,
		totalCalls: total,
		unknownRatio: ratio,
		unknownRate: ratio,
		// 跨源价格分歧：这些请求的价是从多源不一致的价里选出来的（分母同 totalCalls）
		multiSourceCalls,
		multiSourceRatio: total > 0 ? multiSourceCalls / total : null,
		// 输出侧口径无法由账本 total_tokens 判定的行数（真库实测 0，留作透明）
		unknownBasisCalls: bucket.pricedCalls > 0 ? bucket.unknownBasisCalls : 0,
	};
}

/** 本地小时键（与 SQL 的 strftime localtime 同口径，供成本的小时桶复用）。 */
export function localHourKey(ms) {
	const d = new Date(Number(ms));
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00:00`;
}

/**
 * 成本扫描（一次行扫描同时累加总量 / 五个维度 / 小时桶）。
 * 只在有价目表索引时调用；行数 = 窗口内请求数（today 约 1.4k、30d 约 20k）。
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ window: { fromMs: number }, client?: string }} opts
 * @param {object} priceIndex buildPriceIndex 的返回值
 */
export function aggregateCostBuckets(db, opts, priceIndex) {
	const where = buildWhere(opts.window, opts.client);
	const rows = db
		.prepare(
			`SELECT model, provider, executor_type, endpoint, user_agent, timestamp_ms,
				input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, reasoning_tokens, total_tokens
			FROM usage_events WHERE ${where.sql}`,
		)
		.all(...where.params);
	const buckets = {
		total: newCostBucket(),
		model: new Map(),
		provider: new Map(),
		executor: new Map(),
		endpoint: new Map(),
		client: new Map(),
		hour: new Map(),
	};
	const bump = (map, key, cost) => {
		let bucket = map.get(key);
		if (!bucket) {
			bucket = newCostBucket();
			map.set(key, bucket);
		}
		addCost(bucket, cost);
	};
	for (const row of rows) {
		const match = matchPrice(priceIndex, { model: row.model, provider: row.provider });
		const cost = computeRowCost(match, {
			input: row.input_tokens,
			cacheRead: row.cache_read_tokens,
			cacheWrite: row.cache_creation_tokens,
			output: row.output_tokens,
			reasoning: row.reasoning_tokens,
			total: row.total_tokens,
		});
		addCost(buckets.total, cost);
		bump(buckets.model, String(row.model ?? "") || "(unknown)", cost);
		bump(buckets.provider, String(row.provider ?? "") || "(unknown)", cost);
		bump(buckets.executor, String(row.executor_type ?? "") || "(unknown)", cost);
		bump(buckets.endpoint, String(row.endpoint ?? "") || "(unknown)", cost);
		bump(buckets.client, clientFamily(row.user_agent), cost);
		bump(buckets.hour, localHourKey(row.timestamp_ms), cost);
	}
	return buckets;
}

/** 账本里出现过的模型（价格快照只保留这些：快照从 6MB 降到几十条）。 */
export function listLedgerModels(db) {
	return db
		.prepare("SELECT DISTINCT model FROM usage_events WHERE model != ''")
		.all()
		.map((r) => String(r.model));
}

/** 账本里出现过的路由 provider（价目表只拉这些 provider 的价，快照更小）。 */
export function listLedgerProviders(db) {
	return db
		.prepare("SELECT DISTINCT provider FROM usage_events WHERE provider != ''")
		.all()
		.map((r) => String(r.provider));
}

/**
 * 总量聚合：请求数 / 成功率 / TTFT 分位 / 时延 / 速率 / token（+ 可选估算成本）。
 * @param {import("node:sqlite").DatabaseSync} db 只读连接
 * @param {{ window: { fromMs: number }, client?: string, costs?: object }} opts
 */
export function aggregateSummary(db, opts) {
	const where = buildWhere(opts.window, opts.client);
	const row = db.prepare(`SELECT ${AGG_COLUMNS} FROM usage_events WHERE ${where.sql}`).get(...where.params);
	const metrics = toMetrics(row);
	const pct = percentileBy(db, "'all'", where.sql, where.params).get("all") ?? {
		n: 0,
		p50: null,
		p90: null,
		p99: null,
		avg: null,
	};
	return {
		...metrics,
		ttft: { samples: pct.n, p50: pct.p50, p90: pct.p90, p99: pct.p99, avg: pct.avg },
		cost: opts.costs ? costOf(opts.costs.total, metrics.calls) : null,
	};
}

/**
 * 按任意维度聚合（模型 / 路由 provider / 执行器 / 接口 / 客户端），带分位与可选成本。
 * @param {{ window: object, client?: string, groupBy?: string, costs?: object }} opts
 */
export function aggregateGroups(db, opts) {
	const dim = normalizeGroupBy(opts.groupBy);
	const groupSql = GROUP_DIMS[dim];
	const where = buildWhere(opts.window, opts.client);
	const rows = db
		.prepare(
			`SELECT ${groupSql} AS grp, ${AGG_COLUMNS} FROM usage_events WHERE ${where.sql} GROUP BY grp ORDER BY calls DESC`,
		)
		.all(...where.params);
	const pcts = percentileBy(db, groupSql, where.sql, where.params);
	const bucketMap = opts.costs ? (opts.costs[dim] ?? null) : null;
	return rows.map((row) => {
		const key = String(row.grp);
		const metrics = toMetrics(row);
		const pct = pcts.get(key);
		const bucket = bucketMap?.get(key) ?? null;
		return {
			key,
			// 兼容 model 维度的旧字段名
			...(dim === "model" ? { model: key } : {}),
			...metrics,
			failRate: metrics.calls > 0 ? metrics.bad / metrics.calls : null,
			ttftP50: pct?.p50 ?? null,
			ttftP90: pct?.p90 ?? null,
			ttftSamples: pct?.n ?? 0,
			cost: bucket ? costOf(bucket, metrics.calls) : null,
		};
	});
}

/** 按模型聚合（等价于 groupBy=model，保留旧接口）。 */
export function aggregateModels(db, opts) {
	return aggregateGroups(db, { ...opts, groupBy: "model" });
}

/**
 * 按小时聚合（请求数 / TTFT p50、p90 / 平均时延 / tok·s⁻¹ / 可选成本）。
 * 小时桶走 `strftime(..., 'localtime')`，与「今日」日界同源，避免时区混算。
 * @param {{ window: { fromMs: number }, client?: string, costs?: object }} opts
 */
export function aggregateSeries(db, opts) {
	const where = buildWhere(opts.window, opts.client);
	const rows = db
		.prepare(`SELECT ${HOUR_SQL} AS grp, ${AGG_COLUMNS} FROM usage_events WHERE ${where.sql} GROUP BY grp ORDER BY grp`)
		.all(...where.params);
	const pcts = percentileBy(db, HOUR_SQL, where.sql, where.params);
	return rows.map((row) => {
		const metrics = toMetrics(row);
		const pct = pcts.get(String(row.grp));
		const bucket = opts.costs?.hour.get(String(row.grp));
		return {
			hour: String(row.grp),
			...metrics,
			ttftP50: pct?.p50 ?? null,
			ttftP90: pct?.p90 ?? null,
			ttftSamples: pct?.n ?? 0,
			cost: bucket ? costOf(bucket) : null,
		};
	});
}

/**
 * 「维度 × 小时」拆分的序列（多线图用），只留请求数最多的 topN 个维度值。
 * @param {{ window: object, client?: string, groupBy: string, top?: number }} opts
 */
export function aggregateSeriesBreakdown(db, opts) {
	const dim = normalizeGroupBy(opts.groupBy);
	const groupSql = GROUP_DIMS[dim];
	const where = buildWhere(opts.window, opts.client);
	const topN = Math.min(10, Math.max(1, Math.trunc(Number(opts.top) || 5)));
	const rows = db
		.prepare(
			`SELECT ${groupSql} AS grp, ${HOUR_SQL} AS hour, COUNT(*) AS calls,
				SUM(CASE WHEN failed = 1 OR canceled = 1 THEN 1 ELSE 0 END) AS bad,
				SUM(CAST(total_tokens AS REAL)) AS total_tokens
			FROM usage_events WHERE ${where.sql} GROUP BY grp, hour ORDER BY hour`,
		)
		.all(...where.params);
	const totals = new Map();
	for (const row of rows) {
		const key = String(row.grp);
		totals.set(key, (totals.get(key) ?? 0) + (Number(row.calls) || 0));
	}
	const keep = [...totals.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, topN)
		.map(([key]) => key);
	const kept = new Set(keep);
	const out = new Map(keep.map((key) => [key, []]));
	for (const row of rows) {
		const key = String(row.grp);
		if (!kept.has(key)) continue;
		out.get(key).push({
			hour: String(row.hour),
			calls: Number(row.calls) || 0,
			bad: Number(row.bad) || 0,
			totalTokens: Number(row.total_tokens) || 0,
		});
	}
	return keep.map((key) => ({ key, hours: out.get(key) ?? [] }));
}

/** user_agent → 客户端族（只做家族归并，不指认具体程序版本；其余一律 other）。 */
export function clientFamily(ua) {
	const s = String(ua ?? "")
		.trim()
		.toLowerCase();
	if (!s) return "other";
	if (s === "pi" || s.startsWith("pi ") || s.startsWith("pi/")) return "pi";
	if (s.startsWith("zcode/")) return "zcode";
	if (s.startsWith("claude-cli/")) return "claude-cli";
	if (s.startsWith("bun/")) return "bun";
	return "other";
}

/**
 * 最近事件明细（只出必要的列；绝不下发 api_key_hash / client_ip / 上游账号邮箱）。
 * @param {{ window: { fromMs: number }, client?: string, limit?: unknown, priceIndex?: object }} opts
 */
export function listEvents(db, opts) {
	const where = buildWhere(opts.window, opts.client);
	const limit = clampLimit(opts.limit);
	const rows = db
		.prepare(
			`SELECT id, timestamp, timestamp_ms, model, provider, user_agent, failed, canceled,
				latency_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens,
				cache_read_tokens, cache_creation_tokens, total_tokens
			FROM usage_events
			WHERE ${where.sql}
			ORDER BY timestamp_ms DESC, id DESC
			LIMIT ?`,
		)
		.all(...where.params, limit);
	return rows.map((row) => {
		const match = opts.priceIndex ? matchPrice(opts.priceIndex, { model: row.model, provider: row.provider }) : null;
		const cost = match
			? computeRowCost(match, {
					input: row.input_tokens,
					cacheRead: row.cache_read_tokens,
					cacheWrite: row.cache_creation_tokens,
					output: row.output_tokens,
					reasoning: row.reasoning_tokens,
					total: row.total_tokens,
				})
			: null;
		return {
			id: Number(row.id),
			timestamp: String(row.timestamp),
			timestampMs: Number(row.timestamp_ms),
			model: String(row.model ?? ""),
			provider: String(row.provider ?? ""),
			client: clientFamily(row.user_agent),
			failed: Number(row.failed) === 1,
			canceled: Number(row.canceled) === 1,
			latencyMs: Number(row.latency_ms) || 0,
			// ttft_ms 为 0 = 代理没拿到首包时间，按「无样本」下发，前端显示 --
			ttftMs: Number(row.ttft_ms) > 0 ? Number(row.ttft_ms) : null,
			inputTokens: Number(row.input_tokens) || 0,
			outputTokens: Number(row.output_tokens) || 0,
			reasoningTokens: Number(row.reasoning_tokens) || 0,
			cacheReadTokens: Number(row.cache_read_tokens) || 0,
			totalTokens: Number(row.total_tokens) || 0,
			// 未知价 = null（绝不遗漏成 0）
			costAmount: cost ? cost.amount : null,
		};
	});
}

/** limit 白名单：非数字/越界一律夹取，绝不把请求体内容拼进 SQL。 */
export function clampLimit(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return DEFAULT_EVENT_LIMIT;
	return Math.min(MAX_EVENT_LIMIT, Math.max(1, Math.trunc(n)));
}

/** 缓存 TTL / 预热间隔（设置项夹取 10–3600 秒）。 */
export function resolveTtlMs(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
	return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.trunc(n * 1000)));
}

/** 账本存在性只探测到秒级即可（避免每请求 stat 抖动）。 */
function safeStat(file) {
	try {
		return statSync(file);
	} catch {
		return null;
	}
}

function fmtInt(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return "--";
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
	return String(Math.round(v));
}

function fmtMs(ms) {
	const v = Number(ms);
	if (!Number.isFinite(v) || v <= 0) return "--";
	if (v < 1000) return `${Math.round(v)}ms`;
	return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}s`;
}

// ──────────────────────────────────────────────────────────── 插件主体

/**
 * 服务对象：只读连接复用 + 聚合缓存 + 降级状态。
 * 拆成独立函数便于单测注入（tests 用合成 fixture 库直接调 aggregate* 纯函数，
 * 也用它跑一遍真实链路）。
 */
export function createStatsService(options = {}) {
	const ttlRef = { ms: DEFAULT_TTL_MS };
	const state = {
		db: null,
		dbPath: "",
		pathSource: "",
		cooldownUntil: 0,
		openError: null,
		overridesText: "",
	};
	const cache = new Map();
	let pathCache = { at: 0, value: null };
	let lastWarmAt = 0;
	let lastWarmKey = "";

	function currentSettings() {
		return options.getSettings ? options.getSettings() || {} : {};
	}

	/** 关闭连接（幂等）。 */
	function closeDb() {
		const db = state.db;
		state.db = null;
		if (db) {
			try {
				db.close();
			} catch {
				/* 已关闭 / 句柄失效：忽略 */
			}
		}
	}

	/** 设置变化 / 路径失效时整库重置（连接、缓存、路径解析结果、冷却全部作废）。 */
	function reset() {
		closeDb();
		cache.clear();
		pathCache = { at: 0, value: null };
		state.openError = null;
		state.dbPath = "";
		state.pathSource = "";
		state.cooldownUntil = 0;
	}

	/** 路径解析（带 10s 短缓存：自动发现要扫根目录，不能每请求都做）。 */
	function resolvePathCached() {
		const now = Date.now();
		if (pathCache.value && now - pathCache.at < PATH_CACHE_MS) return pathCache.value;
		// 发现链的每一步都写 info 日志（缓存 10s，不会逐请求刷屏）。
		// `options.discovery` 是发现依赖注入口（单测把枚举限制在临时目录）. 
		const discovery = options.discovery ?? null;
		const value = resolveDbPath(currentSettings(), { ...(discovery ?? {}), log: discovery?.log ?? options.log ?? null });
		pathCache = { at: now, value };
		return value;
	}

	/** 解析路径 + 打开连接；失败返回降级对象（不抛错）。 */
	async function ensureDb() {
		const now = Date.now();
		if (state.db) return { ok: true, db: state.db, path: state.dbPath };
		if (state.cooldownUntil > now && state.openError) {
			// 冷却期内直接复用上次失败结果：不重复 stat / open（防重试风暴）
			return { ok: false, ...state.openError };
		}
		const resolved = resolvePathCached();
		if (!resolved.ok) {
			state.openError = {
				code: resolved.code,
				reason: resolved.reason,
				reasonEn: resolved.reasonEn,
				path: resolved.path ?? "",
				// 结构化空态：已试过的候选 + 下一步提示，前端原样展示
				hint: resolved.hint ?? "",
				hintEn: resolved.hintEn ?? "",
				candidates: Array.isArray(resolved.candidates) ? resolved.candidates : [],
			};
			state.cooldownUntil = now + FAIL_COOLDOWN_MS;
			state.pathSource = resolved.source ?? "";
			return { ok: false, ...state.openError };
		}
		try {
			const db = await openReadOnlyDb(resolved.path);
			state.db = db;
			state.dbPath = resolved.path;
			state.pathSource = resolved.source;
			state.openError = null;
			state.cooldownUntil = 0;
			return { ok: true, db, path: resolved.path };
		} catch (err) {
			const cls = classifyDbError(err);
			state.openError = { code: cls.code, reason: cls.reason, reasonEn: cls.reasonEn, path: resolved.path };
			state.cooldownUntil = now + FAIL_COOLDOWN_MS;
			// 降级时也记住「路径从哪来」（设置项 / 自动发现），面板才显示得出
			state.dbPath = resolved.path;
			state.pathSource = resolved.source;
			closeDb();
			return { ok: false, ...state.openError };
		}
	}

	/** 账本被外部替换/删除时（代理升级换目录、文件被删），连接作废重开。 */
	function verifyPath(relPath) {
		if (!relPath) return false;
		const st = safeStat(relPath);
		if (!st || !st.isFile()) return false;
		return true;
	}

	/**
	 * 带缓存的查询执行。返回统一信封：
	 * `{ ok: true, meta, ...data }` 或 `{ ok: false, code, reason, reasonEn, meta }`。
	 */
	async function query(kind, params) {
		const window = resolveWindow(params.window);
		const client = normalizeClient(params.client);
		const groupBy = normalizeGroupBy(params.groupBy);
		const top = Math.min(10, Math.max(1, Math.trunc(Number(params.top) || 5)));
		// 路径进缓存键：代理升级换了账本目录，缓存自然失效
		const resolved = resolvePathCached();
		const pathKey = resolved.ok ? resolved.path : `!${resolved.code}`;
		const suffix = kind === "events" ? clampLimit(params.limit) : kind === "series" ? `${groupBy}|${top}` : groupBy;
		// 价格快照时间也进缓存键：价目表刷新后金额不能继续吃旧缓存
		const priceStamp = options.priceBook?.status?.().fetchedAt ?? 0;
		const cacheKey = `${pathKey}|${kind}|${window.key}|${client}|${suffix}|p${priceStamp}`;
		const ttl = ttlRef.ms;
		const now = Date.now();
		// 顺手淘汰：过期项直接丢，并给 map 一个硬上限（长跑进程不吃内存）
		for (const [key, entry] of cache) {
			if (now - entry.at >= ttl) cache.delete(key);
		}
		if (cache.size > CACHE_MAX_ENTRIES) {
			const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (oldest) cache.delete(oldest[0]);
		}
		const hit = cache.get(cacheKey);
		if (hit && now - hit.at < ttl) {
			return { ...hit.value, meta: { ...hit.value.meta, cached: true, ageMs: now - hit.at } };
		}
		const ready = await ensureDb();
		const priceBook = options.priceBook ?? null;
		const priceStatus = priceBook?.status?.() ?? null;
		const priceIndex = priceBook?.getIndex?.() ?? null;
		const metaBase = {
			dbPath: ready.ok ? ready.path : (ready.path ?? ""),
			pathSource: state.pathSource,
			window: window.key,
			client,
			groupBy,
			fromMs: window.fromMs,
			generatedAt: now,
			ttlMs: ttl,
			cached: false,
			price: priceStatus,
		};
		if (!ready.ok) {
			return {
				ok: false,
				code: ready.code,
				reason: ready.reason,
				reasonEn: ready.reasonEn,
				hint: ready.hint ?? "",
				hintEn: ready.hintEn ?? "",
				candidates: ready.candidates ?? [],
				meta: metaBase,
			};
		}
		if (!verifyPath(ready.path)) {
			// 文件消失：立即释放并报明确空态（下次请求会重新解析路径）
			reset();
			return {
				ok: false,
				code: "missing",
				reason: "账本文件已消失（清理连接，下次请求重新发现）",
				reasonEn: "Ledger file disappeared (connection dropped; will rediscover)",
				meta: metaBase,
			};
		}
		try {
			// 价目表：快照缺失 / 过期 / 未覆盖账本模型时后台异步刷新（绝不阻塞首屏）
			if (priceBook) {
				try {
					priceBook.ensureFresh({
						models: listLedgerModels(ready.db),
						providers: listLedgerProviders(ready.db),
						overridesText: state.overridesText,
					});
				} catch {
					/* 刷新调度失败不影响查询 */
				}
			}
			const costs =
				priceIndex && kind !== "lite" ? aggregateCostBuckets(ready.db, { window, client }, priceIndex) : null;
			let data;
			if (kind === "summary") {
				const summary = aggregateSummary(ready.db, { window, client, costs });
				const groups = aggregateGroups(ready.db, { window, client, groupBy, costs });
				data = {
					summary,
					groups,
					groupBy,
					// 兼容 R1 的字段名：groupBy=model 时 models === groups
					...(groupBy === "model" ? { models: groups } : {}),
				};
			} else if (kind === "lite") {
				// 底栏预热专用：只有总量 + 一个分位，不做 GROUP BY / 成本扫描
				data = { summary: aggregateSummary(ready.db, { window, client }), lite: true, groupBy: "model" };
			} else if (kind === "series") {
				data = {
					hours: aggregateSeries(ready.db, { window, client, costs }),
					groupBy,
					breakdown: groupBy === "hour" ? [] : aggregateSeriesBreakdown(ready.db, { window, client, groupBy, top }),
				};
			} else {
				data = {
					events: listEvents(ready.db, { window, client, limit: params.limit, priceIndex }),
				};
			}
			// 价目表可能在本次查询里刚刷新完：meta.price 取最新状态
			metaBase.price = priceBook?.status?.() ?? priceStatus;
			const value = { ok: true, ...data, meta: metaBase };
			cache.set(cacheKey, { at: now, value });
			return value;
		} catch (err) {
			const cls = classifyDbError(err);
			// 查询失败（多半是 BUSY/LOCKED 或文件被换掉）：作废连接 + 冷却
			reset();
			state.openError = { code: cls.code, reason: cls.reason, reasonEn: cls.reasonEn, path: ready.path };
			state.cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
			return { ok: false, code: cls.code, reason: cls.reason, reasonEn: cls.reasonEn, meta: metaBase };
		}
	}

	return {
		summary: (p = {}) => query("summary", p),
		series: (p = {}) => query("series", p),
		events: (p = {}) => query("events", p),
		/** 轻量总量（底栏预热用）：不含分组与成本，单次聚合约省一半时间。 */
		lite: (p = {}) => query("lite", p),
		/** 设置变更：TTL 与路径都可能变，整库重置最省心（设置保存是低频操作）。 */
		applySettings(values = {}) {
			ttlRef.ms = resolveTtlMs(values.cacheTtlSec);
			state.overridesText = typeof values.priceOverrides === "string" ? values.priceOverrides : "";
			reset();
		},
		/** 价目表状态（前端展示「价格快照：<时间>（刷新失败）」）。 */
		priceStatus() {
			return options.priceBook?.status?.() ?? null;
		},
		/** 手动刷新价目表（按钮触发；后台也在 TTL 到期时自动跑）。 */
		async refreshPrices(force = true) {
			const book = options.priceBook;
			if (!book) return null;
			let models = [];
			let providers = [];
			try {
				const ready = await ensureDb();
				if (ready.ok) {
					models = listLedgerModels(ready.db);
					providers = listLedgerProviders(ready.db);
				}
			} catch {
				/* 账本不可用时只刷新全局价目表 */
			}
			void force;
			return book.refresh({ models, providers, overridesText: state.overridesText });
		},
		/** 预热底栏数字（today 总量，不含分组/成本；看板首屏会各算一份）。 */
		async warm() {
			const res = await query("lite", { window: "today", client: "all" });
			lastWarmAt = Date.now();
			lastWarmKey = res.ok ? "ok" : (res.code ?? "error");
			return res;
		},
		/** 底栏徽标文案：今日请求数 / TTFT p50；空态给明确文案。 */
		badge(res) {
			if (!res || !res.ok) {
				return {
					label: "用量账本",
					badge: "--",
					hint: `📊 用量账本：${res?.reason ?? "账本暂不可用"}`,
					hintEn: `📊 Usage Ledger: ${res?.reasonEn ?? "ledger unavailable"}`,
				};
			}
			const s = res.summary;
			return {
				label: "用量账本",
				badge: `${fmtInt(s.calls)}/${fmtMs(s.ttft.p50)}`,
				hint: `📊 今日代理用量：${s.calls} 请求，失败 ${s.failed}（取消 ${s.canceled}），TTFT p50 ${fmtMs(s.ttft.p50)} / p90 ${fmtMs(s.ttft.p90)}，平均时延 ${fmtMs(s.latencyAvg)}，输出 ${fmtInt(s.tokens.output)} tokens`,
				hintEn: `📊 Today via proxy: ${s.calls} requests, ${s.failed} failed (${s.canceled} canceled), TTFT p50 ${fmtMs(s.ttft.p50)} / p90 ${fmtMs(s.ttft.p90)}, avg latency ${fmtMs(s.latencyAvg)}, output ${fmtInt(s.tokens.output)} tokens`,
			};
		},
		state() {
			return {
				dbPath: state.dbPath,
				pathSource: state.pathSource,
				open: Boolean(state.db),
				cooldownUntil: state.cooldownUntil,
				degraded: state.openError,
				resolved: pathCache.value ?? null,
				lastWarmAt,
				lastWarmKey,
				cacheSize: cache.size,
			};
		},
		dispose() {
			cache.clear();
			closeDb();
		},
	};
}

/** 插件入口：宿主按 `mod.default.activate(host)` 调用。 */
export function activate(host) {
	const settingsOf = () => host.getSettings?.() ?? {};
	// 价格簿：同步读 storage 快照（首屏绝不联网），刷新一律后台异步。
	// 联网走 host.fetch（带超时、随插件卸载 abort）；主机白名单在 lib/prices.mjs 里再自查一次。
	const priceBook = createPriceBook({
		storage: host.storage ?? null,
		fetchImpl: (url, init) => host.fetch(url, { ...(init ?? {}), timeoutMs: 60_000 }),
		log: (level, ...args) => host.log?.(level, ...args),
	});
	priceBook.load();
	const service = createStatsService({
		getSettings: settingsOf,
		priceBook,
		// 发现链的每一步都通过 host.log 留可观测日志（失败不波及插件）
		log: (level, ...args) => host.log?.(level, ...args),
	});
	service.applySettings(settingsOf());
	const disposers = [];

	/** 刷新底栏徽标（带缓存，一次 miss 最多一次聚合）。 */
	async function refreshBadge() {
		try {
			const res = await service.warm();
			host.ui?.update?.(BADGE_ID, service.badge(res));
		} catch (err) {
			host.log?.("warn", "badge refresh failed:", err?.message ?? err);
		}
	}

	/** GET 路由的统一应答：失败也是 200 + ok:false，前端只画空态不刷红。 */
	function sendJson(res, payload) {
		res.status?.(200);
		res.json(payload);
	}

	host.route?.("GET", "/api/summary", async (req, res) => {
		sendJson(res, await service.summary(req.query ?? {}));
	});
	host.route?.("GET", "/api/series", async (req, res) => {
		sendJson(res, await service.series(req.query ?? {}));
	});
	host.route?.("GET", "/api/events", async (req, res) => {
		sendJson(res, await service.events(req.query ?? {}));
	});
	host.route?.("GET", "/api/prices", async (_req, res) => {
		sendJson(res, { ok: true, price: service.priceStatus() });
	});
	// 手动刷新价目表：POST（有副作用，不用 GET）。同一时刻只会跑一个刷新。
	host.route?.("POST", "/api/prices/refresh", async (_req, res) => {
		try {
			const price = await service.refreshPrices(true);
			sendJson(res, { ok: Boolean(price?.available), price });
		} catch (err) {
			sendJson(res, { ok: false, error: String(err?.message ?? err) });
		}
	});

	// 缓存预热：间隔 = TTL（默认 60s，最少 10s）。内存版，不落盘。
	const ttlMs = resolveTtlMs(host.getSettings?.()?.cacheTtlSec);
	const cancelSchedule = host.schedule?.(ttlMs, () => void refreshBadge(), {
		id: "usage-ledger-warm",
		label: "用量账本缓存预热",
	});
	if (cancelSchedule) disposers.push(cancelSchedule);

	// 后台任务心跳：账本不可用时状态里写明原因，面板可见（不刷 console）。
	let bgTask = null;
	try {
		bgTask = host.registerBackgroundTask?.({
			id: "usage-ledger",
			label: "用量账本（账本只读聚合）",
			status: "待首次聚合",
			intervalMs: 5 * 60_000,
			check: () => {
				const st = service.state();
				const price = service.priceStatus();
				const priceText = price
					? price.available
						? `价格快照 ${price.entryCount} 条${price.stale ? "（待刷新）" : ""}`
						: "价格未同步"
					: "价格未同步";
				if (st.degraded) return { alive: true, status: `账本不可用：${st.degraded.code} · ${priceText}` };
				return {
					alive: true,
					status: st.open ? `只读连接就绪 · ${st.cacheSize} 项缓存 · ${priceText}` : `待首次聚合 · ${priceText}`,
				};
			},
		});
	} catch (err) {
		host.log?.("warn", "registerBackgroundTask failed:", err?.message ?? err);
	}

	if (host.onSettingsChanged) {
		disposers.push(
			host.onSettingsChanged((values) => {
				service.applySettings(values ?? {});
				// 价格覆盖改了要立刻重建索引（不等 TTL）
				void service.refreshPrices(true);
				void refreshBadge();
			}),
		);
	}

	// 连接释放走 effect：返回值与反激活都会调，dispose 幂等。
	const dropEffect = host.effect?.("usage-ledger:sqlite", () => service.dispose());
	if (dropEffect) disposers.push(dropEffect);

	void refreshBadge();

	return () => {
		for (const off of disposers.splice(0)) {
			try {
				off();
			} catch {
				/* 幂等清理：单条失败不影响其余 */
			}
		}
		try {
			bgTask?.unregister?.();
		} catch {
			/* ignore */
		}
		service.dispose();
	};
}

export default { activate };
