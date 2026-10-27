/**
 * usage-ledger 插件单测（合成 fixture，不依赖 E: 盘真库）。
 *
 * 覆盖的边界（对应任务硬要求）：
 *  - ttft_ms 为 NULL 与 0 的行不污染分位数；
 *  - failed 与 canceled 同时为 1 的行不重复计数（并集口径）；
 *  - 除零：0 请求 / latency == ttft / output_tokens == 0；
 *  - 时区：「今日」按本地日界，不是 UTC 日界（真库 timestamp 带 +08:00 偏移）；
 *  - 路径校验（绝对路径 / .db / 拒绝 ..）、自动发现取最新版本目录、降级与冷却。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	CLIENT_KEYS,
	GROUP_KEYS,
	activate,
	aggregateCostBuckets,
	aggregateGroups,
	aggregateSeriesBreakdown,
	costOf,
	localHourKey,
	normalizeGroupBy,
	WINDOW_KEYS,
	aggregateModels,
	aggregateSeries,
	aggregateSummary,
	clampLimit,
	classifyDbError,
	clientFamily,
	createStatsService,
	defaultSearchRoots,
	discoverDbPath,
	listEvents,
	normalizeClient,
	percentileOf,
	percentilePos,
	resolveDbPath,
	resolveTtlMs,
	resolveWindow,
	validateDbPath,
} from "../../index.mjs";
import { sandboxDeps } from "../support/sandbox-deps.mjs";
import {
	buildPriceIndex,
	normalizeLiteLlm,
	normalizeModelsDev,
	normalizeOpenRouter,
	parsePriceOverrides,
} from "../../lib/prices.mjs";

// ─────────────────────────────────────────────────────────── 合成 fixture 工具

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 清理尽力而为 */
		}
	}
});

/** 与真库同形的 usage_events 建表语句（列名/类型一致，忽略与本插件无关的索引）。 */
const SCHEMA = `CREATE TABLE usage_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	event_key TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	timestamp_ms INTEGER NOT NULL,
	local_hour TEXT NOT NULL,
	latency_ms INTEGER NOT NULL DEFAULT 0,
	ttft_ms INTEGER,
	source TEXT NOT NULL DEFAULT '',
	auth_index TEXT NOT NULL DEFAULT '',
	failed INTEGER NOT NULL DEFAULT 0,
	provider TEXT NOT NULL DEFAULT '',
	model TEXT NOT NULL DEFAULT '',
	alias TEXT NOT NULL DEFAULT '',
	reasoning_effort TEXT NOT NULL DEFAULT '',
	service_tier TEXT NOT NULL DEFAULT '',
	response_service_tier TEXT NOT NULL DEFAULT '',
	executor_type TEXT NOT NULL DEFAULT '',
	endpoint TEXT NOT NULL DEFAULT '',
	auth_type TEXT NOT NULL DEFAULT '',
	api_key_hash TEXT NOT NULL DEFAULT '',
	api_key_display TEXT NOT NULL DEFAULT '',
	api_key_remark TEXT NOT NULL DEFAULT '',
	request_id TEXT NOT NULL DEFAULT '',
	api_group_key TEXT NOT NULL DEFAULT '',
	model_alias TEXT,
	client_ip TEXT,
	x_forwarded_for TEXT,
	user_agent TEXT,
	generate INTEGER NOT NULL DEFAULT 1,
	cached_tokens INTEGER NOT NULL DEFAULT 0,
	collector_source TEXT NOT NULL DEFAULT '',
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	reasoning_tokens INTEGER NOT NULL DEFAULT 0,
	cache_read_tokens INTEGER NOT NULL DEFAULT 0,
	cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
	total_tokens INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	canceled INTEGER NOT NULL DEFAULT 0,
	failure_status INTEGER NOT NULL DEFAULT 0,
	failure_body TEXT NOT NULL DEFAULT '',
	response_model TEXT NOT NULL DEFAULT ''
)`;

/** 用本机时区拼出带偏移的 ISO 字符串（真库形状：`2026-10-27T21:38:40+08:00`）。 */
function isoWithOffset(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number, len = 2) => String(Math.abs(Math.trunc(n))).padStart(len, "0");
	const offsetMin = -d.getTimezoneOffset();
	const sign = offsetMin >= 0 ? "+" : "-";
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000` +
		`${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`
	);
}

/** 本地小时键（真库形状：`2026-10-27-21`）。 */
function localHour(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}`;
}

/** 聚合结果的行形状（插件是 .mjs，这里显式声明以便 tsc 收窄）。 */
interface ModelRow {
	model: string;
	calls: number;
	bad: number;
	failRate: number | null;
	ttftP50: number | null;
	tokPerSec: number | null;
	tokens: { total: number };
}

interface HourRow {
	hour: string;
	calls: number;
	bad: number;
	ttftSamples: number;
	ttftP50: number | null;
}

interface EventRow {
	id: number;
	timestamp: string;
	timestampMs: number;
	ttftMs: number | null;
	latencyMs: number;
	outputTokens: number;
}

/** 分组行与成本桶的形状（插件是 .mjs，这里显式声明便于 tsc 收窄）。 */
interface CostInfo {
	amount: number | null;
	pricedCalls: number;
	unknownCalls: number;
	unknownRatio: number | null;
	unknownRate: number | null;
	totalCalls: number;
	multiSourceCalls: number;
	multiSourceRatio: number | null;
}

interface GroupRow {
	key: string;
	model?: string;
	calls: number;
	bad: number;
	failRate: number | null;
	ttftP50: number | null;
	tokPerSec: number | null;
	tokens: { total: number };
	cost: CostInfo | null;
}

interface SeriesRow {
	hour: string;
	cost: CostInfo | null;
}

interface PricedEventRow extends EventRow {
	model: string;
	costAmount: number | null;
}

interface BreakdownRow {
	key: string;
	hours: Array<{ hour: string; calls: number }>;
}

interface Row {
	tsMs: number;
	model?: string;
	provider?: string;
	executor?: string;
	endpoint?: string;
	ua?: string | null;
	failed?: number;
	canceled?: number;
	latency: number;
	ttft: number | null;
	inTok?: number;
	outTok?: number;
	reaTok?: number;
	crTok?: number;
	ccTok?: number;
	totalTok?: number;
}

/** 建一个合成 usage.db，返回文件路径（写权限只用于造 fixture，插件侧始终只读）。 */
function makeFixture(rows: Row[]): string {
	const dir = tempDir("cliproxy-fixture-");
	const file = join(dir, "usage.db");
	const db = new DatabaseSync(file);
	db.exec(SCHEMA);
	const stmt = db.prepare(`INSERT INTO usage_events (
			event_key, timestamp, timestamp_ms, local_hour, latency_ms, ttft_ms, failed, canceled,
			provider, model, user_agent, executor_type, endpoint, input_tokens, output_tokens, reasoning_tokens,
			cache_read_tokens, cache_creation_tokens, total_tokens, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	rows.forEach((row, i) => {
		stmt.run(
			`evt-${i}`,
			isoWithOffset(row.tsMs),
			row.tsMs,
			localHour(row.tsMs),
			row.latency,
			row.ttft,
			row.failed ?? 0,
			row.canceled ?? 0,
			row.provider ?? "antigravity",
			row.model ?? "model-a",
			row.ua === undefined ? "pi (win32 10.0.26200; x64)" : row.ua,
			row.executor ?? "AntigravityExecutor",
			row.endpoint ?? "POST /v1/messages",
			row.inTok ?? 0,
			row.outTok ?? 0,
			row.reaTok ?? 0,
			row.crTok ?? 0,
			row.ccTok ?? 0,
			row.totalTok ?? 0,
			isoWithOffset(row.tsMs),
		);
	});
	db.close();
	return file;
}

function openReadOnly(file: string): DatabaseSync {
	return new DatabaseSync(file, { readOnly: true });
}

/** 本地「今天」的某时刻（时区无关：都是本机本地时间）。 */
function todayAt(hour: number, minute = 0): number {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).getTime();
}

function yesterdayAt(hour: number, minute = 0): number {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, minute).getTime();
}

const PI_UA = "pi (win32 10.0.26200; x64)";

/** 六条今日 + 一条昨日的标准 fixture（见各断言注释）。 */
function standardFixture(): string {
	return makeFixture([
		// 1) 正常行：ttft 200，输出 50 → tok/s = 50 / 0.8 = 62.5
		{
			tsMs: todayAt(1, 0),
			model: "model-a",
			ua: PI_UA,
			latency: 1000,
			ttft: 200,
			inTok: 100,
			outTok: 50,
			crTok: 10,
			totalTok: 160,
		},
		// 2) ttft 为 NULL：不进分位、不进 tok/s
		{
			tsMs: todayAt(1, 30),
			model: "model-a",
			ua: "pi/1.4.0 (win32; node/v24.19.0; x64)",
			latency: 2000,
			ttft: null,
			outTok: 0,
		},
		// 3) ttft == 0：不进分位（但 latency > 0 计平均时延）；tok/s = 100 / 1.5 ≈ 66.67
		{ tsMs: todayAt(2, 0), model: "model-b", ua: "ZCode/3.11.2", latency: 1500, ttft: 0, outTok: 100 },
		// 4) failed=1 且 canceled=1：并集计一次；输出 0 → 不进 tok/s
		{ tsMs: todayAt(3, 0), model: "model-b", ua: null, failed: 1, canceled: 1, latency: 500, ttft: 300, outTok: 0 },
		// 5) canceled=1 但 failed=0：同样按并集计一次；tok/s = 20 / 0.4 = 50
		{
			tsMs: todayAt(4, 0),
			model: "model-a",
			ua: "pi (linux 6.18.33.2-microsoft-standard-WSL2; x64)",
			canceled: 1,
			latency: 800,
			ttft: 400,
			outTok: 20,
		},
		// 6) latency == ttft：不满足 latency > ttft → 不进 tok/s，但进时延均值与分位
		{ tsMs: todayAt(5, 0), model: "model-a", ua: PI_UA, latency: 500, ttft: 500, outTok: 10 },
		// 7) 昨天 23:30：不属于「今日」
		{ tsMs: yesterdayAt(23, 30), model: "model-a", ua: PI_UA, latency: 900, ttft: 100, outTok: 10 },
	]);
}

// ─────────────────────────────────────────────────────────────── 基础纯函数

describe("窗口与过滤白名单", () => {
	it("窗口键白名单，非法值回落 today", () => {
		expect(WINDOW_KEYS).toEqual(["today", "7d", "30d"]);
		expect(resolveWindow("bogus").key).toBe("today");
		expect(resolveWindow("7d").key).toBe("7d");
		expect(resolveWindow("30d").key).toBe("30d");
	});

	it("today = 本地当日 00:00（不是 UTC 日界）", () => {
		const w = resolveWindow("today");
		const from = new Date(w.fromMs);
		expect(from.getHours()).toBe(0);
		expect(from.getMinutes()).toBe(0);
		expect(from.getSeconds()).toBe(0);
		const now = new Date(w.nowMs);
		expect([from.getFullYear(), from.getMonth(), from.getDate()]).toEqual([
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
		]);
		// 本机时区非 UTC 时，本地日界必须与 UTC 日界不同（证明没走 UTC 口径）
		if (now.getTimezoneOffset() !== 0) {
			const utcMidnight = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
			expect(w.fromMs).not.toBe(utcMidnight);
		}
	});

	it("7d / 30d 是滚动窗口", () => {
		const now = todayAt(12);
		expect(resolveWindow("7d", now).fromMs).toBe(now - 7 * 86_400_000);
		expect(resolveWindow("30d", now).fromMs).toBe(now - 30 * 86_400_000);
	});

	it("客户端族白名单", () => {
		expect(CLIENT_KEYS).toEqual(["all", "pi"]);
		expect(normalizeClient("pi")).toBe("pi");
		expect(normalizeClient("zcode")).toBe("all");
		expect(normalizeClient(undefined)).toBe("all");
		expect(normalizeClient("pi' OR 1=1 --")).toBe("all");
	});

	it("clientFamily 只归并家族，其余一律 other", () => {
		expect(clientFamily("pi (win32 10.0.26200; x64)")).toBe("pi");
		expect(clientFamily("pi/1.4.0 (win32; node/v24.19.0; x64)")).toBe("pi");
		expect(clientFamily("ZCode/3.11.2")).toBe("zcode");
		expect(clientFamily("claude-cli/2.0.1")).toBe("claude-cli");
		expect(clientFamily("Bun/1.3.14")).toBe("bun");
		expect(clientFamily("curl/8.21.0")).toBe("other");
		expect(clientFamily("")).toBe("other");
		expect(clientFamily(null)).toBe("other");
	});

	it("分组维度白名单：非法值回落 model", () => {
		expect(GROUP_KEYS).toEqual(["model", "provider", "executor", "endpoint", "client"]);
		expect(normalizeGroupBy("provider")).toBe("provider");
		expect(normalizeGroupBy("provider; DROP TABLE usage_events")).toBe("model");
		expect(normalizeGroupBy(undefined)).toBe("model");
	});
});

describe("分位口径", () => {
	it("nearest-rank：pos = round(p*(n-1))", () => {
		expect(percentilePos(0.5, 0)).toBe(null);
		expect(percentilePos(0.5, 1)).toBe(0);
		expect(percentilePos(0.5, 4)).toBe(2);
		expect(percentilePos(0.9, 4)).toBe(3);
		expect(percentilePos(0.99, 4)).toBe(3);
		expect(percentilePos(0.5, 10)).toBe(5);
		expect(percentileOf([200, 300, 400, 500], 0.5)).toBe(400);
		expect(percentileOf([200, 300, 400, 500], 0.9)).toBe(500);
		expect(percentileOf([], 0.5)).toBe(null);
	});
});

describe("账本路径校验", () => {
	it("必须绝对路径 + .db 结尾 + 存在的普通文件", () => {
		const dir = tempDir("cliproxy-path-");
		const ok = join(dir, "usage.db");
		writeFileSync(ok, "");
		expect(validateDbPath(ok)).toMatchObject({ ok: true });
		expect(validateDbPath("usage.db").ok).toBe(false); // 相对路径
		expect(validateDbPath(join(dir, "usage.sqlite")).ok).toBe(false); // 扩展名
		expect(validateDbPath(join(dir, "missing.db")).ok).toBe(false); // 不存在
		expect(validateDbPath(dir).ok).toBe(false); // 目录
		expect(validateDbPath("").ok).toBe(false);
		expect(validateDbPath(123).ok).toBe(false);
		expect(validateDbPath(`${ok.slice(0, 3)}../etc/passwd.db`).ok).toBe(false); // 目录穿越
	});

	it("自动发现：取版本号最新的 EasyCLIProxyAPI-*", () => {
		const root = tempDir("cliproxy-root-");
		for (const [name, payload] of [
			["EasyCLIProxyAPI-v0.2.9-Windows-amd64", "old"],
			["EasyCLIProxyAPI-v0.2.25-Windows-amd64", "new"],
			["EasyCLIProxyAPI-v0.10.0-Windows-amd64", "newest"],
			["unrelated-dir", "ignore"],
		] as const) {
			const dir = join(root, name, "usage-records");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "usage.db"), payload);
		}
		const deps = sandboxDeps(root);
		const found = discoverDbPath([root], deps);
		expect(found).toContain("v0.10.0");
		expect(discoverDbPath([join(root, "nope")], deps)).toBe(null);
		// 空 roots → 默认搜索根（沙箱只允许枚举临时目录，真实盘不参与）
		expect(discoverDbPath([], deps)).toBe(discoverDbPath(defaultSearchRoots(deps), deps));
		expect(defaultSearchRoots(deps).length).toBeGreaterThan(0);
	});

	it("resolveDbPath：设置项优先，留空走自动发现，都失败给结构化空态 db-not-found", () => {
		const emptyRoot = tempDir("cliproxy-empty-");
		const deps = sandboxDeps(emptyRoot);
		const none = resolveDbPath({ searchRoots: emptyRoot }, deps) as {
			ok: boolean;
			code?: string;
			candidates?: string[];
			hint?: string;
		};
		expect(none.ok).toBe(false);
		expect(none.code).toBe("db-not-found");
		// 结构化空态：必须带已试候选与下一步提示，不许静默回退到 0 数据
		expect(Array.isArray(none.candidates)).toBe(true);
		expect((none.candidates ?? []).length).toBeGreaterThan(0);
		expect(String(none.hint)).toContain("usage.db");

		const bad = resolveDbPath({ dbPath: "relative/usage.db", searchRoots: emptyRoot }, deps);
		expect(bad.ok).toBe(false);
		expect((bad as { code?: string }).code).toBe("bad-path");

		const root = tempDir("cliproxy-root2-");
		const rdeps = sandboxDeps(root);
		const dir = join(root, "EasyCLIProxyAPI-v1.0.0", "usage-records");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "usage.db");
		writeFileSync(file, "");
		const auto = resolveDbPath({ searchRoots: root }, rdeps);
		expect(auto).toMatchObject({ ok: true, source: "search-root" });
		expect(auto.path).toContain("v1.0.0");
		const explicit = resolveDbPath({ dbPath: file }, rdeps);
		expect(explicit).toMatchObject({ ok: true, source: "setting" });
	});
});

describe("降级与参数夹取", () => {
	it("classifyDbError 分出 busy / missing / schema", () => {
		expect(classifyDbError(new Error("database is locked"))).toMatchObject({ code: "busy" });
		expect(classifyDbError(new Error("SQLITE_BUSY: database is locked"))).toMatchObject({ code: "busy" });
		expect(classifyDbError(new Error("unable to open database file"))).toMatchObject({ code: "missing" });
		expect(classifyDbError(new Error("no such table: usage_events"))).toMatchObject({ code: "schema" });
		expect(classifyDbError(new Error("weird")).code).toBe("error");
	});

	it("clampLimit / resolveTtlMs 夹取范围", () => {
		expect(clampLimit(undefined)).toBe(20);
		expect(clampLimit("7")).toBe(7);
		expect(clampLimit(0)).toBe(1);
		expect(clampLimit(9999)).toBe(100);
		expect(clampLimit("abc")).toBe(20);
		expect(clampLimit("1; DROP TABLE usage_events")).toBe(20);
		expect(resolveTtlMs(undefined)).toBe(60_000);
		expect(resolveTtlMs(1)).toBe(10_000);
		expect(resolveTtlMs(9999)).toBe(3_600_000);
	});
});

// ─────────────────────────────────────────────────────────────── 聚合口径

describe("聚合：总量 / TTFT 分位 / 速率 / token", () => {
	const file = standardFixture();
	const db = openReadOnly(file);
	const window = resolveWindow("today");

	it("请求数、失败并集、成功率", () => {
		const s = aggregateSummary(db, { window, client: "all" });
		expect(s.calls).toBe(6); // 昨日那条不计
		expect(s.failed).toBe(1); // 只有第 4 条 failed=1
		expect(s.canceled).toBe(2); // 第 4、5 条 canceled=1
		expect(s.bad).toBe(2); // 并集：第 4 条不重复计数
		expect(s.success).toBe(4);
		expect(s.successRate).toBeCloseTo(4 / 6, 10);
	});

	it("ttft 为 NULL / 0 的行不进分位", () => {
		const s = aggregateSummary(db, { window, client: "all" });
		// 只有 200 / 300 / 400 / 500 四个样本
		expect(s.ttft.samples).toBe(4);
		expect(s.ttft.p50).toBe(400);
		expect(s.ttft.p90).toBe(500);
		expect(s.ttft.p99).toBe(500);
		expect(s.ttft.avg).toBeCloseTo((200 + 300 + 400 + 500) / 4, 10);
	});

	it("latency == ttft 与输出为 0 的行不进速率均值", () => {
		const s = aggregateSummary(db, { window, client: "all" });
		// 有效样本：62.5（第 1 条）、66.66…（第 3 条）、50（第 5 条）
		expect(s.tokPerSecSamples).toBe(3);
		expect(s.tokPerSec).toBeCloseTo((62.5 + 100 / 1.5 + 50) / 3, 6);
		expect(s.latencyAvg).toBeCloseTo((1000 + 2000 + 1500 + 500 + 800 + 500) / 6, 10);
		expect(s.latencyMax).toBe(2000);
	});

	it("token 合计", () => {
		const s = aggregateSummary(db, { window, client: "all" });
		expect(s.tokens).toEqual({
			input: 100,
			output: 50 + 100 + 20 + 10,
			reasoning: 0,
			cacheRead: 10,
			cacheCreation: 0,
			total: 160,
		});
	});

	it("0 请求窗口：不吐 NaN / Infinity", () => {
		const future = { key: "today", fromMs: Date.now() + 86_400_000, nowMs: Date.now() };
		const s = aggregateSummary(db, { window: future, client: "all" });
		expect(s.calls).toBe(0);
		expect(s.successRate).toBe(null);
		expect(s.tokPerSec).toBe(null);
		expect(s.latencyAvg).toBe(null);
		expect(s.ttft).toMatchObject({ samples: 0, p50: null, p90: null, p99: null, avg: null });
		expect(Number.isNaN(s.successRate as unknown as number)).toBe(false);
	});

	it("client=pi 只统计 pi 家族 user_agent", () => {
		const s = aggregateSummary(db, { window, client: "pi" });
		expect(s.calls).toBe(4); // 第 1、2、5、6 条（第 5 条是 pi (linux …)）
		expect(s.bad).toBe(1); // 第 5 条 canceled=1
		expect(s.success).toBe(3);
		expect(s.ttft.samples).toBe(3); // 200 / 400 / 500（第 2 条 ttft 为 NULL）
	});

	it("30d 窗口把昨天那条算进来", () => {
		const s = aggregateSummary(db, { window: resolveWindow("30d"), client: "all" });
		expect(s.calls).toBe(7);
	});

	it("SQL 分位与 JS nearest-rank 完全一致（含单行分组）", () => {
		const values = db
			.prepare("SELECT ttft_ms AS v FROM usage_events WHERE timestamp_ms >= ? AND ttft_ms > 0 ORDER BY v")
			.all(window.fromMs)
			.map((r) => Number(r.v));
		const s = aggregateSummary(db, { window, client: "all" });
		expect(s.ttft.p50).toBe(percentileOf(values, 0.5));
		expect(s.ttft.p90).toBe(percentileOf(values, 0.9));
		expect(s.ttft.p99).toBe(percentileOf(values, 0.99));
	});
});

describe("聚合：按模型 / 按小时 / 事件明细", () => {
	const file = standardFixture();
	const db = openReadOnly(file);
	const window = resolveWindow("today");

	it("按模型汇总", () => {
		const models = aggregateModels(db, { window, client: "all" }) as ModelRow[];
		const a = models.find((m) => m.model === "model-a")!;
		const b = models.find((m) => m.model === "model-b")!;
		expect(a.calls).toBe(4);
		expect(a.bad).toBe(1); // 第 5 条 canceled=1
		expect(a.failRate).toBeCloseTo(1 / 4, 10);
		expect(a.ttftP50).toBe(400); // 200 / 400 / 500 → pos=round(0.5*2)=1 → 400
		expect(b.calls).toBe(2);
		expect(b.bad).toBe(1); // 第 4 条 failed=1 且 canceled=1，并集只算一次
		expect(b.failRate).toBeCloseTo(1 / 2, 10);
		expect(b.ttftP50).toBe(300); // 只有第 4 条的 300（第 3 条 ttft=0 被排除）
	});

	it("按小时聚合：同小时合并，且小时键是本地时间", () => {
		const hours = aggregateSeries(db, { window, client: "all" }) as HourRow[];
		const hourOf = (ms: number) => {
			const d = new Date(ms);
			const pad = (n: number) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00:00`;
		};
		expect(hours.map((h) => h.hour)).toEqual(
			[hourOf(todayAt(1)), hourOf(todayAt(2)), hourOf(todayAt(3)), hourOf(todayAt(4)), hourOf(todayAt(5))].sort(),
		);
		const first = hours.find((h) => h.hour === hourOf(todayAt(1)))!;
		expect(first.calls).toBe(2); // 01:00 + 01:30 同桶
		expect(first.ttftSamples).toBe(1); // 01:30 的 ttft 是 NULL
		expect(first.ttftP50).toBe(200);
	});

	it("事件明细：倒序、limit 生效、绝不下发敏感列", () => {
		const events = listEvents(db, { window, client: "all", limit: 2 }) as EventRow[];
		expect(events).toHaveLength(2);
		expect(events[0].timestampMs).toBeGreaterThan(events[1].timestampMs);
		expect(events[0].timestampMs).toBe(todayAt(5));
		const allowed = new Set([
			"id",
			"timestamp",
			"timestampMs",
			"model",
			"provider",
			"client",
			"failed",
			"canceled",
			"latencyMs",
			"ttftMs",
			"inputTokens",
			"outputTokens",
			"reasoningTokens",
			"cacheReadTokens",
			"totalTokens",
			"costAmount",
		]);
		for (const key of Object.keys(events[0])) expect(allowed.has(key), key).toBe(true);
		// ttft_ms = 0 在明细里按「无样本」下发
		const zeroTtft = (listEvents(db, { window, client: "all", limit: 100 }) as EventRow[]).find(
			(e) => e.timestampMs === todayAt(2),
		);
		expect(zeroTtft?.ttftMs).toBe(null);
	});
});

describe("时区：今日按本地日界，不按 UTC 日界", () => {
	it("本地日界前 60s 的行不算今日，后 60s 的算", () => {
		const w = resolveWindow("today");
		const file = makeFixture([
			{ tsMs: w.fromMs - 60_000, model: "edge", latency: 100, ttft: 50, outTok: 5 },
			{ tsMs: w.fromMs + 60_000, model: "edge", latency: 100, ttft: 50, outTok: 5 },
		]);
		const db = openReadOnly(file);
		const summary = aggregateSummary(db, { window: w, client: "all" });
		expect(summary.calls).toBe(1);
		db.close();
	});

	it("timestamp 字符串带 +08:00 偏移时，仍以 timestamp_ms + 本地日界判定", () => {
		const w = resolveWindow("today");
		const file = makeFixture([{ tsMs: w.fromMs + 5 * 60_000, model: "tz", latency: 100, ttft: 50, outTok: 5 }]);
		const db = openReadOnly(file);
		const row = db.prepare("SELECT timestamp, timestamp_ms FROM usage_events").get() as
			{ timestamp: string; timestamp_ms: number } | undefined;
		expect(row).toBeTruthy();
		// 真库形状：ISO 字符串带显式偏移；聚合只认 timestamp_ms
		expect(String(row?.timestamp)).toMatch(/[+-]\d{2}:\d{2}$/);
		expect(Number(row?.timestamp_ms)).toBe(w.fromMs + 5 * 60_000);
		expect(aggregateSummary(db, { window: w, client: "all" }).calls).toBe(1);
		db.close();
	});
});

// ─────────────────────────────────────────────────────────────── 服务层

describe("服务层：缓存、降级、连接复用", () => {
	it("同一窗口二次查询命中缓存；不同窗口各算一次", async () => {
		const file = standardFixture();
		const service = createStatsService({ getSettings: () => ({ dbPath: file }) });
		service.applySettings({ dbPath: file });
		const first = await service.summary({ window: "today", client: "all" });
		expect(first.ok).toBe(true);
		expect(first.meta.cached).toBe(false);
		const second = await service.summary({ window: "today", client: "all" });
		expect(second.meta.cached).toBe(true);
		expect(second.summary.calls).toBe(first.summary.calls);
		const other = await service.summary({ window: "7d", client: "all" });
		expect(other.meta.cached).toBe(false);
		service.dispose();
	});

	it("账本不存在：ok:false + 明确原因 + 冷却（不重试风暴）", async () => {
		const dir = tempDir("cliproxy-missing-");
		const missing = join(dir, "usage.db");
		const service = createStatsService({ getSettings: () => ({ dbPath: missing }) });
		service.applySettings({ dbPath: missing });
		const first = await service.summary({ window: "today", client: "all" });
		expect(first.ok).toBe(false);
		expect(first.code).toBe("bad-path");
		expect(first.reasonEn).toBeTruthy();
		const st = service.state();
		expect(st.cooldownUntil).toBeGreaterThan(Date.now());
		const second = await service.summary({ window: "today", client: "all" });
		expect(second.ok).toBe(false);
		expect(second.code).toBe(first.code);
		// 底栏降级文案：明确空态、不抛错
		const badge = service.badge(second);
		expect(badge.badge).toBe("--");
		expect(String(badge.hint)).toContain("用量账本");
		service.dispose();
	});

	it("非法 client / window 参数被白名单拦下", async () => {
		const file = standardFixture();
		const service = createStatsService({ getSettings: () => ({ dbPath: file }) });
		service.applySettings({ dbPath: file });
		const res = await service.summary({ window: "'; DROP TABLE usage_events; --", client: "../../etc" });
		expect(res.ok).toBe(true);
		expect(res.meta.window).toBe("today");
		expect(res.meta.client).toBe("all");
		// 表还在
		const db = openReadOnly(file);
		const count = db.prepare("SELECT COUNT(*) AS c FROM usage_events").get() as { c: number } | undefined;
		expect(Number(count?.c)).toBeGreaterThan(0);
		db.close();
		service.dispose();
	});

	it("events 端点 limit 夹取 + 明细不外泄敏感列", async () => {
		const file = standardFixture();
		const service = createStatsService({ getSettings: () => ({ dbPath: file }) });
		service.applySettings({ dbPath: file });
		const res = await service.events({ window: "today", client: "all", limit: 9999 });
		expect(res.ok).toBe(true);
		expect(res.events.length).toBeLessThanOrEqual(100);
		expect(Object.keys(res.events[0])).not.toContain("api_key_hash");
		service.dispose();
	});
});

// ─────────────────────────────────────────────────────────── 插件静态资产

describe("插件资产（manifest / 文档）", () => {
	it("manifest 关键字段符合约定", async () => {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const base = fileURLToPath(new URL("../../manifest.json", import.meta.url));
		const manifest = JSON.parse(readFileSync(base, "utf8"));
		expect(manifest.id).toBe("usage-ledger");
		expect(manifest.version).toBe("1.0.0"); // 首个对外版本；manifest 与代码改动同提交递版
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.icon).toBe("📊");
		expect(manifest.preload).toBe(true);
		expect(manifest.view).toBe(false);
		expect(manifest.permissions).toEqual(["ui", "http", "net", "storage"]);
		// 联网白名单：三源主机必须列全（fail-closed）
		expect(manifest.netAllowlist).toEqual(["models.dev", "raw.githubusercontent.com", "openrouter.ai"]);
		expect(manifest.settings.map((s: { key: string }) => s.key)).toContain("priceOverrides");
		const bar = manifest.ui.bottombar[0];
		expect(bar).toMatchObject({ id: "usage-ledger-badge", order: 17, align: "start", kind: "action" });
		const view = manifest.ui["topbar.primary"][0];
		expect(view).toMatchObject({ id: "__view", kind: "view", view: "plugin:usage-ledger" });
	});
});

// ─────────────────────────────────────────────────────────── 宿主接线（activate）

/** 最小可用宿主替身：只实现插件真正用到的那几个面。 */
function fakeHost(settings: Record<string, unknown>) {
	const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
	const badgeUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
	const effects: Array<{ label: string; dispose: () => void }> = [];
	const scheduled: Array<{ ms: number; id?: string }> = [];
	let bgRegistered = false;
	const host = {
		getSettings: () => settings,
		onSettingsChanged: () => () => {},
		notify: () => {},
		broadcast: () => {},
		log: () => {},
		route: (method: string, path: string, handler: (req: unknown, res: unknown) => unknown) => {
			const key = `${method} ${path}`;
			routes.set(key, handler);
			return () => routes.delete(key);
		},
		schedule: (ms: number, _fn: () => void, opts?: { id?: string }) => {
			scheduled.push({ ms, id: opts?.id });
			return () => {};
		},
		registerBackgroundTask: () => {
			bgRegistered = true;
			return { update: () => {}, unregister: () => {} };
		},
		ui: {
			update: (id: string, patch: Record<string, unknown>) => badgeUpdates.push({ id, patch }),
			register: () => () => {},
			remove: () => {},
			arrange: () => {},
			list: () => ({ items: [], arrange: [] }),
		},
		effect: (label: string, dispose: () => void) => {
			effects.push({ label, dispose });
			return () => dispose();
		},
	};
	return {
		host,
		routes,
		badgeUpdates,
		effects,
		scheduled,
		bgRegistered: () => bgRegistered,
	};
}

/** 统一的假 res：记录 json 载荷。 */
function fakeRes() {
	const captured: { status?: number; body?: unknown } = {};
	return {
		captured,
		res: {
			status(code: number) {
				captured.status = code;
				return this;
			},
			json(body: unknown) {
				captured.body = body;
				return this;
			},
		},
	};
}

describe("宿主接线：activate 注册路由 / 预热 / 后台任务 / 释放", () => {
	it("注册三条 GET 路由并返回可用的 JSON 信封", async () => {
		const file = standardFixture();
		const fake = fakeHost({ dbPath: file, cacheTtlSec: 60 });
		const dispose = activate(fake.host as never);
		try {
			expect([...fake.routes.keys()].sort()).toEqual([
				"GET /api/events",
				"GET /api/prices",
				"GET /api/series",
				"GET /api/summary",
				"POST /api/prices/refresh",
			]);
			const summary = fakeRes();
			await fake.routes.get("GET /api/summary")?.({ query: { window: "today", client: "pi" } }, summary.res);
			expect(summary.captured.status).toBe(200);
			const body = summary.captured.body as { ok: boolean; meta: { client: string }; summary: { calls: number } };
			expect(body.ok).toBe(true);
			expect(body.meta.client).toBe("pi");
			expect(body.summary.calls).toBe(4);

			const events = fakeRes();
			await fake.routes.get("GET /api/events")?.({ query: { window: "today", limit: "9999" } }, events.res);
			const evBody = events.captured.body as { ok: boolean; events: unknown[] };
			expect(evBody.ok).toBe(true);
			expect(evBody.events.length).toBeLessThanOrEqual(100);
		} finally {
			dispose();
		}
	});

	it("activate 会预热底栏徽标、登记后台任务与 schedule，并在 dispose 时断开连接", async () => {
		const file = standardFixture();
		const fake = fakeHost({ dbPath: file, cacheTtlSec: 120 });
		const dispose = activate(fake.host as never);
		await vi.waitFor(() => expect(fake.badgeUpdates.length).toBeGreaterThan(0));
		const badge = fake.badgeUpdates[0];
		expect(badge.id).toBe("usage-ledger-badge");
		expect(String(badge.patch.badge)).toContain("/");
		expect(String(badge.patch.hint)).toContain("6 请求");
		expect(fake.scheduled[0]?.ms).toBe(120_000);
		expect(fake.bgRegistered()).toBe(true);
		expect(fake.effects.map((e) => e.label)).toContain("usage-ledger:sqlite");
		dispose();
		// dispose 幂等：再调一次不抛错
		expect(() => dispose()).not.toThrow();
	});

	it("账本缺失时 activate 不抛错，底栏给空态文案", async () => {
		const fake = fakeHost({ dbPath: join(tempDir("cliproxy-nodb-"), "usage.db") });
		const dispose = activate(fake.host as never);
		await vi.waitFor(() => expect(fake.badgeUpdates.length).toBeGreaterThan(0));
		expect(String(fake.badgeUpdates[0].patch.badge)).toBe("--");
		expect(String(fake.badgeUpdates[0].patch.hint)).toContain("用量账本");
		dispose();
	});
});

// ───────────────────────────────────────────── 分组维度（路由）与估算成本

/** 一条带路由维度的合成账本：4 条记录覆盖 provider / executor / endpoint / client 四类取值。 */
function routedFixture(): string {
	const t = (h: number, m = 0) => todayAt(h, m);
	return makeFixture([
		// 1) antigravity + gemini（有价）：input 100k 含 80k 缓存命中，output 1k
		{
			tsMs: t(1),
			model: "gemini-3.8-flash-high",
			provider: "antigravity",
			executor: "AntigravityExecutor",
			endpoint: "POST /v1/messages",
			ua: "pi (win32 10.0.26200; x64)",
			latency: 5000,
			ttft: 2000,
			inTok: 100_000,
			outTok: 1000,
			crTok: 80_000,
		},
		// 2) xai + grok（有价），长上下文触发分段价
		{
			tsMs: t(2),
			model: "grok-4.7",
			provider: "xai",
			executor: "XAIExecutor",
			endpoint: "GET /backend-api/codex/responses",
			ua: "ZCode/3.11.2",
			latency: 4000,
			ttft: 1500,
			inTok: 300_000,
			outTok: 500,
			crTok: 100_000,
		},
		// 3) xai + 未知模型（无价）
		{
			tsMs: t(2, 30),
			model: "mystery-model-x",
			provider: "xai",
			executor: "XAIExecutor",
			endpoint: "GET /backend-api/codex/responses",
			ua: "Bun/1.3.14",
			latency: 3000,
			ttft: 1000,
			inTok: 2000,
			outTok: 100,
		},
		// 4) antigravity + 未知模型（无价），客户端归 other
		{
			tsMs: t(3),
			model: "another-mystery",
			provider: "antigravity",
			executor: "AntigravityExecutor",
			endpoint: "POST /v1/chat/completions",
			ua: "curl/8.21.0",
			latency: 2000,
			ttft: 800,
			inTok: 1000,
			outTok: 50,
		},
	]);
}

/** 只给两个已知模型定价（覆盖条目，绝不写账本）。 */
function pricedIndex() {
	return buildPriceIndex(
		parsePriceOverrides({
			"gemini-3.8-flash-high": { input: 0.75, output: 3.75, cacheRead: 0.075 },
			"grok-4.7": { input: 2, output: 6, cacheRead: 0.5 },
		}).entries,
	);
}

describe("分组维度（groupBy）", () => {
	const db = openReadOnly(routedFixture());
	const window = resolveWindow("today");

	it("按 provider / executor / endpoint / client 分组，键值来自白名单 SQL", () => {
		const byProvider = aggregateGroups(db, { window, client: "all", groupBy: "provider" }) as GroupRow[];
		expect(byProvider.map((g) => g.key).sort()).toEqual(["antigravity", "xai"]);
		expect(byProvider.find((g) => g.key === "xai")!.calls).toBe(2);

		const byExecutor = aggregateGroups(db, { window, client: "all", groupBy: "executor" }) as GroupRow[];
		expect(byExecutor.map((g) => g.key).sort()).toEqual(["AntigravityExecutor", "XAIExecutor"]);

		const byEndpoint = aggregateGroups(db, { window, client: "all", groupBy: "endpoint" }) as GroupRow[];
		expect(byEndpoint.find((g) => g.key === "GET /backend-api/codex/responses")!.calls).toBe(2);

		const byClient = aggregateGroups(db, { window, client: "all", groupBy: "client" }) as GroupRow[];
		expect(byClient.map((g) => g.key).sort()).toEqual(["bun", "other", "pi", "zcode"]);
	});

	it("model 维度保留旧字段名，非法 groupBy 回落 model", () => {
		const groups = aggregateGroups(db, { window, client: "all", groupBy: "model" }) as GroupRow[];
		expect(groups[0]).toHaveProperty("model");
		expect(groups[0].key).toBe(groups[0].model);
		const fallback = aggregateGroups(db, {
			window,
			client: "all",
			groupBy: "'; DROP TABLE usage_events; --",
		}) as GroupRow[];
		const models = aggregateGroups(db, { window, client: "all", groupBy: "model" }) as GroupRow[];
		expect(fallback.map((g) => g.key).sort()).toEqual(models.map((g) => g.key).sort());
	});
});

describe("估算成本（未知价绝不冒充 0）", () => {
	const db = openReadOnly(routedFixture());
	const window = resolveWindow("today");
	const costs = aggregateCostBuckets(db, { window, client: "all" }, pricedIndex());

	it("总量：有价请求累加金额，未知价单独计数", () => {
		const bucket = costOf(costs.total)!;
		expect(bucket.pricedCalls).toBe(2);
		expect(bucket.unknownCalls).toBe(2);
		expect(bucket.unknownRate).toBeCloseTo(0.5, 10);
		// 行 1：billable input 20k × 0.75 + 80k × 0.075 + 1k × 3.75 = 15000+6000+3750 = 24750 → 0.02475 USD
		// 行 2：context 300k 命中分段价（覆盖条目无 tiers → 用基础价 2/6/0.5）
		//   billable input 200k × 2 + 100k × 0.5 + 500 × 6 = 400000+50000+3000 = 453000 → 0.453 USD
		expect(bucket.amount).toBeCloseTo(0.02475 + 0.453, 9);
	});

	it("维度桶：有价与未知价分开算，一条有价都没有时 amount = null", () => {
		const byProvider = aggregateGroups(db, {
			window,
			client: "all",
			groupBy: "provider",
			costs,
		}) as GroupRow[];
		const antigravity = byProvider.find((g) => g.key === "antigravity")!;
		expect(antigravity.cost!.pricedCalls).toBe(1);
		expect(antigravity.cost!.unknownCalls).toBe(1);
		expect(antigravity.cost!.amount).toBeCloseTo(0.02475, 9);

		// 全部未知价的桶必须是 null（不是 0）
		const onlyUnknown = costOf({ amount: 0, pricedCalls: 0, unknownCalls: 3, unknownBasisCalls: 0 })!;
		expect(onlyUnknown.amount).toBe(null);
		expect(onlyUnknown.unknownRate).toBe(1);
	});

	it("summary 带总成本；无价目表索引时 cost 为 null", () => {
		const withCost = aggregateSummary(db, { window, client: "all", costs });
		expect(withCost.cost!.amount).toBeCloseTo(0.02475 + 0.453, 9);
		const without = aggregateSummary(db, { window, client: "all" });
		expect(without.cost).toBe(null);
	});

	it("小时桶的键与 SQL 的 localtime 小时键一致", () => {
		const hours = aggregateSeries(db, { window, client: "all", costs }) as SeriesRow[];
		for (const row of hours) {
			expect(localHourKey(new Date(row.hour).getTime())).toBe(row.hour);
			expect(row.cost).toBeTruthy();
		}
		const sum = hours.reduce((acc: number, row) => acc + (row.cost?.amount ?? 0), 0);
		expect(sum).toBeCloseTo(costs.total.amount, 9);
	});

	it("事件明细带单行成本；未知模型为 null", () => {
		const events = listEvents(db, {
			window,
			client: "all",
			limit: 100,
			priceIndex: pricedIndex(),
		}) as PricedEventRow[];
		const known = events.find((e) => e.model === "grok-4.7")!;
		expect(known.costAmount).toBeCloseTo(0.453, 9);
		const unknown = events.find((e) => e.model === "mystery-model-x")!;
		expect(unknown.costAmount).toBe(null); // 不是 0
	});

	it("按维度 × 小时的拆分只留 topN", () => {
		const breakdown = aggregateSeriesBreakdown(db, {
			window,
			client: "all",
			groupBy: "provider",
			top: 1,
		}) as BreakdownRow[];
		expect(breakdown).toHaveLength(1);
		expect(breakdown[0].key).toBe("antigravity"); // 两家并列 2 条时按首次出现顺序取（稳定排序）
		expect(breakdown[0].hours.length).toBeGreaterThan(0);
	});
});

describe("策略红线：插件源码不含任何写盘 / 写库调用", () => {
	it("index.mjs / lib / client 里没有 writeFile / VACUUM / ATTACH 之类的写操作", async () => {
		const { readFileSync: rf } = await import("node:fs");
		const base = new URL("../../", import.meta.url);
		const files = ["index.mjs", "lib/prices.mjs", "client/entry.mjs", "scripts/verify-real-db.mjs"];
		const forbidden = [
			/writeFileSync/,
			/writeFile\s*\(/,
			/appendFileSync/,
			/createWriteStream/,
			/unlinkSync/,
			/rmSync/,
			/renameSync/,
			/copyFileSync/,
			/VACUUM/i,
			/ATTACH\s+DATABASE/i,
			/INSERT\s+INTO/i,
			/DROP\s+TABLE/i,
		];
		// 注释里提到写操作（例如「不 VACUUM」）不算违规：先剥注释再扫
		const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
		for (const file of files) {
			const src = stripComments(rf(new URL(file, base), "utf8"));
			for (const pattern of forbidden) {
				expect(pattern.test(src), `${file} 命中 ${pattern}`).toBe(false);
			}
		}
	});
});

// ─────────────────────────────────────────────── 审核 finding 回归（R2/R3）

describe("回归：SUM 超 2^53 不得整块降级（P1-1）", () => {
	it("token 合计超过 Number.MAX_SAFE_INTEGER 仍然出数，且不泄漏 BigInt", async () => {
		// 单行 3e15 × 5 行 = 1.5e16，超过 2^53（≈9.007e15）
		const big = 3_000_000_000_000_000;
		const file = makeFixture(
			Array.from({ length: 5 }, (_, i) => ({
				tsMs: todayAt(1, i),
				latency: 1000,
				ttft: 500,
				inTok: big,
				outTok: 10,
				totalTok: big,
			})),
		);
		const db = openReadOnly(file);
		const summary = aggregateSummary(db, { window: resolveWindow("today"), client: "all" });
		expect(summary.tokens.input).toBeCloseTo(big * 5, -3);
		expect(Number.isFinite(summary.tokens.input)).toBe(true);
		// 下发前必须能 JSON 化（BigInt 会让 res.json 直接抛 TypeError）
		expect(() => JSON.stringify(summary)).not.toThrow();
		db.close();

		const service = createStatsService({ getSettings: () => ({ dbPath: file }) });
		service.applySettings({ dbPath: file });
		const res = await service.summary({ window: "today", client: "all" });
		expect(res.ok).toBe(true);
		expect(() => JSON.stringify(res)).not.toThrow();
		service.dispose();
	});
});

describe("回归：路径与缓存边界（P2-3 / P2-4）", () => {
	it("UNC 网络共享路径一律拒绝", () => {
		expect(validateDbPath("\\\\srv\\share\\usage.db").ok).toBe(false);
		expect(validateDbPath("\\\\srv\\share\\usage.db")).toMatchObject({ ok: false });
		// 盘符绝对路径仍然放行（不依赖 E: 盘存在，只测校验分支）
		const dir = tempDir("cliproxy-unc-");
		const ok = join(dir, "usage.db");
		writeFileSync(ok, "");
		expect(validateDbPath(ok).ok).toBe(true);
	});

	it("聚合缓存有上限且会淘汰过期项", async () => {
		const file = standardFixture();
		const service = createStatsService({ getSettings: () => ({ dbPath: file, cacheTtlSec: 10 }) });
		service.applySettings({ dbPath: file, cacheTtlSec: 10 });
		for (const limit of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
			await service.events({ window: "today", client: "all", limit });
		}
		for (const window of ["today", "7d", "30d"]) {
			for (const client of ["all", "pi"]) {
				for (const groupBy of ["model", "provider", "executor", "endpoint", "client"]) {
					await service.summary({ window, client, groupBy });
				}
			}
		}
		expect(service.state().cacheSize).toBeLessThanOrEqual(64);
		service.dispose();
	});

	it("lite 只算总量：不返回分组、不带成本", async () => {
		const file = routedFixture();
		const service = createStatsService({ getSettings: () => ({ dbPath: file }) });
		service.applySettings({ dbPath: file });
		const res = await service.lite({ window: "today", client: "all" });
		expect(res.ok).toBe(true);
		expect(res.lite).toBe(true);
		expect(res.groups).toBeUndefined();
		expect(res.summary.cost).toBe(null);
		expect(res.summary.calls).toBe(4);
		service.dispose();
	});
});

// ─────────────────────────────────────────────── R5：未知价占比语义

describe("R5：未知价请求占比（unknownRatio）", () => {
	/** 已知价 + 未知价混排的账本：2 条有价、3 条无价 */
	function mixedFixture() {
		return makeFixture([
			{
				tsMs: todayAt(1, 0),
				model: "gemini-3.8-flash-high",
				latency: 1000,
				ttft: 500,
				inTok: 1_000_000,
				outTok: 0,
				totalTok: 1_000_000,
			},
			{
				tsMs: todayAt(1, 1),
				model: "gemini-3.8-flash-high",
				latency: 1000,
				ttft: 500,
				inTok: 0,
				outTok: 1_000_000,
				totalTok: 1_000_000,
			},
			{ tsMs: todayAt(1, 2), model: "mystery-a", latency: 1000, ttft: 500 },
			{ tsMs: todayAt(1, 3), model: "mystery-b", latency: 1000, ttft: 500 },
			{ tsMs: todayAt(1, 4), model: "mystery-c", latency: 1000, ttft: 500 },
		]);
	}

	it("未知价绝不进金额分子：金额只等于有价行的和", () => {
		const db = openReadOnly(mixedFixture());
		const window = resolveWindow("today");
		const priceIndex = pricedIndex();
		const costs = aggregateCostBuckets(db, { window, client: "all" }, priceIndex);
		const summary = aggregateSummary(db, { window, client: "all", costs });
		const cost = summary.cost!;
		// 1M input × 0.75 + 1M output × 3.75 = 0.75 + 3.75 = 4.5 USD
		expect(cost.amount).toBeCloseTo(4.5, 6);
		expect(cost.pricedCalls).toBe(2);
		expect(cost.unknownCalls).toBe(3);
		expect(cost.totalCalls).toBe(5);
		expect(cost.unknownRatio).toBeCloseTo(3 / 5, 10);
		// 旧字段名同步
		expect(cost.unknownRate).toBe(cost.unknownRatio);
		// 三行无价模型各自持账，且金额为 null（不是 0）
		const groups = aggregateGroups(db, { window, client: "all", groupBy: "model", costs });
		for (const key of ["mystery-a", "mystery-b", "mystery-c"]) {
			const g = groups.find((it: { key: string }) => it.key === key)!;
			expect(g.cost!.unknownCalls).toBe(1);
			expect(g.cost!.unknownRatio).toBe(1);
			expect(g.cost!.amount).toBe(null);
			expect(g.cost!.pricedCalls).toBe(0);
		}
		db.close();
	});

	it("0 请求：占比是 null 而不是 0，金额也是 null", async () => {
		const file = makeFixture([]); // 空库 = 0 请求
		const db = openReadOnly(file);
		const window = resolveWindow("today");
		const priceIndex = pricedIndex();
		const costs = aggregateCostBuckets(db, { window, client: "all" }, priceIndex);
		const summary = aggregateSummary(db, { window, client: "all", costs });
		expect(summary.calls).toBe(0);
		expect(summary.cost!.amount).toBe(null);
		expect(summary.cost!.unknownCalls).toBe(0);
		expect(summary.cost!.totalCalls).toBe(0);
		expect(summary.cost!.unknownRatio).toBe(null);
		db.close();

		// 服务层：没有价目表时 cost 整体为 null（不是 0、也不是「0%」）
		const noPrices = createStatsService({ getSettings: () => ({ dbPath: file }) });
		noPrices.applySettings({ dbPath: file });
		const bare = await noPrices.summary({ window: "today", client: "all" });
		expect(bare.ok).toBe(true);
		expect(bare.summary.cost).toBe(null);
		noPrices.dispose();

		// 服务层：装了价目表后 0 请求 → amount / unknownRatio 均为 null
		const withPrices = createStatsService({
			getSettings: () => ({ dbPath: file }),
			priceBook: { getIndex: () => priceIndex, ensureFresh: () => undefined },
		});
		withPrices.applySettings({ dbPath: file });
		const res = await withPrices.summary({ window: "today", client: "all" });
		expect(res.ok).toBe(true);
		expect(res.summary.cost.unknownRatio).toBe(null);
		expect(res.summary.cost.amount).toBe(null);
		expect(res.summary.cost.totalCalls).toBe(0);
		withPrices.dispose();
	});

	it("全部未知价：amount = null、unknownRatio = 1、pricedCalls = 0", () => {
		const db = openReadOnly(
			makeFixture([{ tsMs: todayAt(2, 0), model: "totally-new-model", latency: 900, ttft: 400 }]),
		);
		const window = resolveWindow("today");
		const priceIndex = pricedIndex();
		const costs = aggregateCostBuckets(db, { window, client: "all" }, priceIndex);
		const summary = aggregateSummary(db, { window, client: "all", costs });
		expect(summary.cost!.amount).toBe(null);
		expect(summary.cost!.pricedCalls).toBe(0);
		expect(summary.cost!.unknownCalls).toBe(1);
		expect(summary.cost!.unknownRatio).toBe(1);
		// 也绝不等于 0（0 会被当成「免费」）
		expect(summary.cost!.amount === 0).toBe(false);
		db.close();
	});

	it("costOf 的分母以窗口总请求数为准（缺省回退 priced + unknown）", () => {
		const onlyPriced = costOf({ amount: 2, pricedCalls: 2, unknownCalls: 0, unknownBasisCalls: 0 })!;
		expect(onlyPriced.unknownRatio).toBe(0);
		expect(onlyPriced.totalCalls).toBe(2);
		const empty = costOf({ amount: 0, pricedCalls: 0, unknownCalls: 0, unknownBasisCalls: 0 })!;
		expect(empty.amount).toBe(null);
		expect(empty.unknownRatio).toBe(null);
		const declared = costOf({ amount: 1, pricedCalls: 1, unknownCalls: 1, unknownBasisCalls: 0 }, 4)!;
		expect(declared.totalCalls).toBe(4);
		expect(declared.unknownRatio).toBeCloseTo(0.25, 10);
		expect(costOf(null)).toBe(null);
	});

	it("R7：多源不一致单独计数（0 请求时占比是 null），与未知价互不干扰", () => {
		// 纯函数层：0 请求 → 比例 null（不是 0）；有请求 → 分母同 totalCalls
		const empty = costOf({ amount: 0, pricedCalls: 0, unknownCalls: 0, unknownBasisCalls: 0, multiSourceCalls: 0 })!;
		expect(empty.multiSourceCalls).toBe(0);
		expect(empty.multiSourceRatio).toBe(null);
		const mixed = costOf({ amount: 1, pricedCalls: 3, unknownCalls: 1, unknownBasisCalls: 0, multiSourceCalls: 2 }, 4)!;
		expect(mixed.multiSourceCalls).toBe(2);
		expect(mixed.multiSourceRatio).toBeCloseTo(0.5, 10);
		expect(mixed.unknownRatio).toBeCloseTo(0.25, 10); // 各算各的，互不吞并

		// 扫描层：amb-m 只能走多源多数价（provider 对不上），mystery 无价 → 两桶独立
		const t = todayAt(4);
		const db = openReadOnly(
			makeFixture([
				{
					tsMs: t,
					model: "amb-m",
					provider: "no-such-provider",
					latency: 1000,
					ttft: 200,
					inTok: 1_000,
					outTok: 1_000,
					totalTok: 2_000,
				},
				{
					tsMs: t + 1,
					model: "amb-m",
					provider: "no-such-provider",
					latency: 1000,
					ttft: 200,
					inTok: 1_000,
					outTok: 1_000,
					totalTok: 2_000,
				},
				{
					tsMs: t + 2,
					model: "mystery-m",
					provider: "no-such-provider",
					latency: 900,
					ttft: 100,
					inTok: 10,
					outTok: 10,
					totalTok: 20,
				},
			]),
		);
		const index = buildPriceIndex([
			...normalizeModelsDev({ p1: { models: { "amb-m": { cost: { input: 1, output: 3 } } } } }),
			...normalizeLiteLlm({
				"x/amb-m": { litellm_provider: "xai2", input_cost_per_token: 100e-6, output_cost_per_token: 400e-6 },
			}),
			...normalizeOpenRouter({ data: [{ id: "z/amb-m", pricing: { prompt: "0.0001", completion: "0.0004" } }] }),
		]);
		const costs = aggregateCostBuckets(db, { window: resolveWindow("today"), client: "all" }, index);
		const total = costOf(costs.total, 3)!;
		expect(total.multiSourceCalls).toBe(2);
		expect(total.multiSourceRatio).toBeCloseTo(2 / 3, 10);
		expect(total.unknownCalls).toBe(1);
		expect(total.unknownRatio).toBeCloseTo(1 / 3, 10);
		// 每行 0.004（models.dev 1/3 胜出，不是 100/400 的 0.5）
		expect(total.amount).toBeCloseTo(0.008, 9);
		// 未知价那一桶不得把多源标记算进去
		const unknownModel = aggregateGroups(db, {
			window: resolveWindow("today"),
			client: "all",
			groupBy: "model",
			costs,
		}) as GroupRow[];
		const mystery = unknownModel.find((g) => g.key === "mystery-m")!;
		expect(mystery.cost!.multiSourceCalls).toBe(0);
		expect(mystery.cost!.unknownCalls).toBe(1);
		expect(mystery.cost!.multiSourceRatio).toBe(0); // 该桶无分歧行 → 0（不是 null：该桶有 1 次请求）
		db.close();
	});
});
