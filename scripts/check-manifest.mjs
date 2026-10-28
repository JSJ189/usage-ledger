#!/usr/bin/env node
/**
 * 本地自检：`npm run check`（CI 也跑这条）。
 *
 * 只查「提交前能被机器判定」的硬约束，不重复单测：
 *  1. manifest.json 必填字段与取值域（对齐 pi-web-ui 的 validatePluginManifest 与 registry schema）；
 *  2. 权限白名单：ui / http / net / storage / fs:read；`fs:read` 必须与 README 的说明并存；
 *  3. 图标不得是 ⚡（与内置插件撞脸）；
 *  4. manifest.version 与 package.json.version 一致；
 *  5. registry/plugin.json 与 manifest 的 id / name / homepage / author 对齐，描述是中文；
 *  6. 仓库里不得残留代理账本的实现或数据；价格表只允许 `lib/prices.mjs` 一个模块，
 *     且只能引用三个固定的公开价格源（2.1 的估算依据）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

// ── 1. manifest
let manifest;
try {
	manifest = readJson("manifest.json");
} catch (err) {
	fail(`manifest.json 读不了：${err.message}`);
	manifest = {};
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ID_RE = /^[A-Za-z0-9_-]+$/;

if (!ID_RE.test(String(manifest.id ?? ""))) fail(`manifest.id 非法（只允许 [A-Za-z0-9_-]）：${manifest.id}`);
else if (String(manifest.id).length < 2 || String(manifest.id).length > 50) fail(`manifest.id 长度必须 2–50：${manifest.id}`);
if (typeof manifest.name !== "string" || !manifest.name.trim()) fail("manifest.name 必填");
if (!SEMVER.test(String(manifest.version ?? ""))) fail(`manifest.version 不是 semver：${manifest.version}`);
if (manifest.apiVersion !== 2) fail(`manifest.apiVersion 必须是 2（本插件用 host.route / settings 声明），实为 ${manifest.apiVersion}`);
if (manifest.view !== false) fail("manifest.view 必须显式 false（底栏 + 看板双入口）");
if (manifest.preload !== true) fail("manifest.preload 必须显式 true（底栏预热需要）");
for (const key of ["author", "homepage", "license"]) {
	if (typeof manifest[key] !== "string" || !manifest[key].trim()) fail(`manifest.${key} 必填（registry 审计要求）`);
}
if (manifest.author && !/^[A-Za-z0-9_.-]+$/.test(manifest.author)) fail(`manifest.author 非法：${manifest.author}`);
if (manifest.homepage && !/^https?:\/\//.test(manifest.homepage)) fail(`manifest.homepage 必须是 http(s) URL：${manifest.homepage}`);

// ── 2. 权限白名单
const ALLOWED_PERMISSIONS = ["ui", "http", "net", "storage", "fs:read"];
const perms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
if (!perms.length) fail("manifest.permissions 不能为空");
for (const p of perms) {
	if (!ALLOWED_PERMISSIONS.includes(p)) {
		fail(`未批准的权限「${p}」：白名单只有 ui/http/net/storage/fs:read`);
	}
}
if (new Set(perms).size !== perms.length) fail("manifest.permissions 有重复项");
// 2.1 用 host.fetch 抓价格表（http 权限已覆盖），不需要 net
if (perms.includes("net")) fail("价格抓取走 host.fetch（http 权限），不需要 net 权限");
if (!perms.includes("fs:read")) fail("缺少 fs:read：读会话 JSONL 拿 token 需要它");
if (!perms.includes("http")) fail("缺少 http：看板的数据路由（host.route）需要它");
if (manifest.netAllowlist) fail("netAllowlist 已废弃（抓取走 host.fetch + 固定主机白名单），必须删掉");
// fs:read 会提高 registry 风险等级：README 必须写清原因
try {
	const readme = readFileSync(join(ROOT, "README.md"), "utf8");
	if (!/fs:read/.test(readme)) fail("README 必须解释 fs:read 的用途与风险（registry 人工审核会看）");
} catch {
	fail("README.md 读不了，无法核对 fs:read 说明");
}

// ── 3. 图标
if (manifest.icon === "⚡") fail("manifest.icon 不能是 ⚡（与内置插件撞脸）");
if (!manifest.icon && !manifest.iconSvg) warn("既没有 icon 也没有 iconSvg，界面会显示占位");

// ── 4. 版本一致
let pkg = {};
try {
	pkg = readJson("package.json");
	if (pkg.version !== manifest.version) fail(`package.json.version(${pkg.version}) 与 manifest.version(${manifest.version}) 不一致`);
} catch (err) {
	fail(`package.json 读不了：${err.message}`);
}
if (pkg.scripts && pkg.scripts["verify:db"]) fail("package.json 还留着 verify:db（代理账本脚本已删除）");

// ── 5. registry 元数据
try {
	const entry = readJson("registry/plugin.json");
	const allowedKeys = new Set([
		"id",
		"name",
		"source",
		"author",
		"description",
		"descriptionEn",
		"homepage",
		"icon",
		"iconSvg",
		"tags",
	]);
	for (const key of Object.keys(entry)) {
		if (!allowedKeys.has(key)) fail(`registry/plugin.json 多写了字段「${key}」（schema 是 additionalProperties:false）`);
	}
	for (const key of ["id", "name", "source", "author", "description"]) {
		if (typeof entry[key] !== "string" || !entry[key].trim()) fail(`registry/plugin.json 缺必填字段 ${key}`);
	}
	if (entry.id !== manifest.id) fail(`registry.id(${entry.id}) 与 manifest.id(${manifest.id}) 不一致`);
	if (entry.name !== manifest.name) fail(`registry.name(${entry.name}) 与 manifest.name(${manifest.name}) 不一致`);
	if (entry.author !== manifest.author) fail(`registry.author(${entry.author}) 与 manifest.author(${manifest.author}) 不一致`);
	if (entry.homepage && entry.homepage !== manifest.homepage) fail("registry.homepage 与 manifest.homepage 不一致");
	if (entry.source && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.source)) fail(`registry.source 不是 GitHub specifier：${entry.source}`);
	if (entry.source && entry.source.split("/")[0] !== entry.author) fail(`registry.source 的 owner 必须等于 author：${entry.source} vs ${entry.author}`);
	if (entry.source && entry.source.split("/")[1] !== manifest.id) fail(`registry.source 的仓库名必须等于 id（安装目录名 = id）：${entry.source}`);
	const desc = String(entry.description ?? "");
	const cjk = (desc.match(/[\u4e00-\u9fff]/g) ?? []).length;
	if (cjk < 5) fail(`registry.description 必须是中文（≥5 个汉字），实测 ${cjk}`);
	if (desc.length > 300) fail(`registry.description 超 300 字：${desc.length}`);
	if (entry.descriptionEn && entry.descriptionEn.length > 300) fail("registry.descriptionEn 超 300 字");
	if (/EasyCLIProxyAPI|usage\.db|价目表/i.test(desc)) fail("registry.description 还在讲代理账本 / 价目表（2.0 已删除）");
	if (entry.tags) {
		if (!Array.isArray(entry.tags)) fail("registry.tags 必须是数组");
		else {
			if (entry.tags.length > 10) fail("registry.tags 最多 10 个");
			for (const t of entry.tags) if (typeof t !== "string" || !t || t.length > 30) fail(`registry.tags 条目非法：${t}`);
		}
	}
} catch (err) {
	fail(`registry/plugin.json 读不了：${err.message}`);
}

// ── 6. 交付文件 + 不许残留代理账本
const REQUIRED_FILES = [
	"LICENSE",
	"README.md",
	"CHANGELOG.md",
	"index.mjs",
	"client/entry.mjs",
	"lib/ledger.mjs",
	"lib/sessions.mjs",
	"lib/metrics.mjs",
	"lib/live.mjs",
	"lib/prices.mjs",
	"manifest.json",
];
for (const rel of REQUIRED_FILES) {
	try {
		if (!statSync(join(ROOT, rel)).isFile()) fail(`缺交付文件：${rel}`);
	} catch {
		fail(`缺交付文件：${rel}`);
	}
}
const REMOVED_FILES = ["scripts/verify-real-db.mjs", "tests/fixtures/cliproxy-prices"];
for (const rel of REMOVED_FILES) {
	try {
		statSync(join(ROOT, rel));
		fail(`代理账本时代的文件必须删除：${rel}`);
	} catch {
		/* 不存在 = 正确 */
	}
}
// 源码里不得再出现只读 SQLite / 代理账本的痕迹（价格源只允许出现在 lib/prices.mjs）
const BANNED_IN_SOURCE = [/node:sqlite/, /usage_events/, /EasyCLIProxyAPI/];
/** 允许外部 HTTPS 的来源白名单（只有价格表模块能引用）。 */
const PRICE_HOSTS = ["models.dev", "raw.githubusercontent.com", "openrouter.ai"];
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", ".cps-tmp", "docs"]);
const walkSource = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name) || entry.name === "tests") continue;
			walkSource(join(dir, entry.name));
			continue;
		}
		if (!/\.(mjs|js|ts|json)$/i.test(entry.name)) continue;
		// 本文件自己就带着这些关键词（它就是检查它们的地方）
		if (entry.name === "plugin.json" || entry.name === "check-manifest.mjs") continue;
		const rel = join(dir, entry.name).slice(ROOT.length);
		const body = readFileSync(join(dir, entry.name), "utf8");
		for (const re of BANNED_IN_SOURCE) {
			if (re.test(body)) fail(`${rel} 还在提代理账本（${re}），2.x 的数据源只有 pi 自己的调用`);
		}
		// 价格源主机只允许 lib/prices.mjs 引用（manifest 的描述文案除外，那是给用户看的说明）
		const isManifest = entry.name === "manifest.json";
		if (!isManifest && !rel.endsWith(join("lib", "prices.mjs"))) {
			for (const host of PRICE_HOSTS) {
				if (body.includes(host)) fail(`${rel} 引用了价格源主机 ${host}（只允许 lib/prices.mjs）`);
			}
		}
	}
};
try {
	walkSource(ROOT);
} catch (err) {
	warn(`源码扫描跳过：${err.message}`);
}

// ── 7. 价格表：只允许三个固定来源，且必须能离线降级
let priceSource = "";
try {
	priceSource = readFileSync(join(ROOT, "lib/prices.mjs"), "utf8");
	for (const host of PRICE_HOSTS) {
		if (!priceSource.includes(host)) fail(`lib/prices.mjs 缺少价格源 ${host}`);
	}
	const urls = [...priceSource.matchAll(/https:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]);
	for (const host of urls) {
		if (!PRICE_HOSTS.includes(host)) fail(`lib/prices.mjs 引用了未批准的价格源主机：${host}`);
	}
	if (!/PRICE_TTL_MS/.test(priceSource)) fail("lib/prices.mjs 必须带缓存 TTL");
} catch (err) {
	fail(`lib/prices.mjs 读不了：${err.message}`);
}

function report() {
	for (const w of warnings) console.warn(`warn  ${w}`);
	if (errors.length) {
		for (const e of errors) console.error(`error ${e}`);
		console.error(`\n✗ manifest 自检失败：${errors.length} 条错误`);
		process.exit(1);
	}
	console.log(`✓ manifest 自检通过（manifest ${manifest?.version ?? "?"}，权限 ${(manifest?.permissions ?? []).join("/")}）`);
}
report();
