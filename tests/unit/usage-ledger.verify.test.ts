/**
 * usage-ledger 审核用独立验证单测（review-agent 产出，与实现方测试互不引用）。
 *
 * 立场：证伪。每条断言只针对「错误实现会露馅」的性质，fixture 全部为合成数据，
 * 不读 E: 盘真库（CI 无该盘）。覆盖任务攻击清单 A/B/C/D 可单测化的部分：
 *  A 正确性：分位（n=1..12、重复值、极端离群、全 NULL、全 0、单行、空窗口）、
 *    本地日界 vs UTC 日界、tok/s 除零、failed/canceled 并集、SUM 溢出。
 *  B 健壮性：缺库、空库缺表、非 SQLite 文件、他进程写事务锁库、dispose 后句柄释放。
 *  C 安全：dbPath 校验攻击表、route 参数注入（含 dbPath 覆盖尝试）、明细敏感列零出现。
 *  D 一致性：manifest 权限/版本/图标/底栏 order 与全体插件的冲突面、catalog 交付闸门。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { createMockHost } from "../support/mock-host.mjs";
import {
	CLIENT_KEYS,
	WINDOW_KEYS,
	activate,
	aggregateCostBuckets,
	aggregateGroups,
	aggregateModels,
	aggregateSeries,
	aggregateSummary,
	clampLimit,
	clientFamily,
	costOf,
	createStatsService,
	defaultSearchRoots,
	discoverDbPath,
	listEvents,
	percentileOf,
	percentilePos,
	resolveDbPath,
	resolveTtlMs,
	resolveWindow,
	validateDbPath,
} from "../../index.mjs";
import { sandboxDeps } from "../support/sandbox-deps.mjs";
import {
	billableOutput,
	buildPriceIndex,
	computeRowCost,
	createPriceBook,
	matchPrice,
	normalizeModelsDev,
	PRICE_STORAGE_KEY,
	normalizeSource,
	pickTier,
	stripEffort,
} from "../../lib/prices.mjs";

// ───────────────────────────────────────────────────────── 合成 fixture 工具

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const tempDirs: string[] = [];
const openDbs: DatabaseSync[] = [];

function tempDir(prefix = "cpx-"): string {
	const dir = mkdtempSafe(prefix);
	tempDirs.push(dir);
	return dir;
}

function mkdtempSafe(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

afterAll(() => {
	for (const db of openDbs.splice(0)) {
		try {
			db.close();
		} catch {
			/* 已关 */
		}
	}
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 尽力清理 */
		}
	}
});

/** 与真库同形（列名一致，未用到的列照抄真库存在性）。 */
const SCHEMA = `CREATE TABLE usage_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	event_key TEXT,
	timestamp TEXT NOT NULL,
	timestamp_ms INTEGER NOT NULL,
	local_hour TEXT,
	latency_ms INTEGER NOT NULL DEFAULT 0,
	ttft_ms INTEGER,
	source TEXT NOT NULL DEFAULT '',
	auth_index TEXT NOT NULL DEFAULT '',
	failed INTEGER NOT NULL DEFAULT 0,
	canceled INTEGER NOT NULL DEFAULT 0,
	failure_status INTEGER,
	failure_body TEXT,
	provider TEXT NOT NULL DEFAULT '',
	model TEXT NOT NULL DEFAULT '',
	alias TEXT NOT NULL DEFAULT '',
	model_alias TEXT NOT NULL DEFAULT '',
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
	client_ip TEXT NOT NULL DEFAULT '',
	x_forwarded_for TEXT NOT NULL DEFAULT '',
	user_agent TEXT NOT NULL DEFAULT '',
	generate TEXT NOT NULL DEFAULT '',
	cached_tokens INTEGER NOT NULL DEFAULT 0,
	collector_source TEXT NOT NULL DEFAULT '',
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	reasoning_tokens INTEGER NOT NULL DEFAULT 0,
	cache_read_tokens INTEGER NOT NULL DEFAULT 0,
	cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
	total_tokens INTEGER NOT NULL DEFAULT 0,
	created_at TEXT
)`;

type Row = Partial<{
	tsMs: number;
	timestamp: string;
	latency: number;
	ttft: number | null;
	failed: number;
	canceled: number;
	model: string;
	provider: string;
	ua: string;
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheCreation: number;
	total: number;
}>;

/** 建库：默认 WAL（真库口径），rows 决定内容。返回库路径。 */
function makeDb(
	dir: string,
	rows: Row[],
	opts: { journal?: "delete" | "wal"; file?: string; keepOpen?: boolean } = {},
): string {
	const file = join(dir, opts.file ?? "usage.db");
	const db = new DatabaseSync(file);
	if (opts.journal === "delete") db.exec("pragma journal_mode=delete");
	else db.exec("pragma journal_mode=wal");
	db.exec("pragma synchronous=off"); // 仅临时 fixture
	db.exec(SCHEMA);
	db.exec("BEGIN");
	const ins = db.prepare(
		`INSERT INTO usage_events(timestamp, timestamp_ms, local_hour, latency_ms, ttft_ms, failed, canceled,
			provider, model, source, api_key_hash, api_key_display, client_ip, x_forwarded_for, user_agent,
			request_id, failure_body, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
			cache_creation_tokens, total_tokens, created_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	for (const r of rows) {
		const ms = r.tsMs ?? 0;
		const iso = r.timestamp ?? new Date(ms).toISOString();
		ins.run(
			iso,
			ms,
			iso.slice(0, 13),
			r.latency ?? 0,
			r.ttft === undefined ? null : r.ttft,
			r.failed ?? 0,
			r.canceled ?? 0,
			r.provider ?? "xai",
			r.model ?? "m-a",
			"upstream-account@example.com",
			"deadbeefcafe0001",
			"sk-asdf1234",
			"198.51.100.7",
			"203.0.113.9",
			r.ua ?? "pi (win32 10.0.26200; x64) pi-web-ui",
			"req-0001",
			"secret upstream failure body",
			r.input ?? 0,
			r.output ?? 0,
			r.reasoning ?? 0,
			r.cacheRead ?? 0,
			r.cacheCreation ?? 0,
			r.total ?? 0,
			"2026-01-01T00:00:00+08:00",
		);
	}
	db.exec("COMMIT");
	if (opts.keepOpen) openDbs.push(db);
	else db.close(); // 不留句柄：否则 Windows 删文件用例误报
	return file;
}

/** 在指定绝对路径落一个空账本（建完立刻关连接，不留句柄）。 */
function seedDb(absFile: string): string {
	mkdirSync(join(absFile, ".."), { recursive: true });
	const db = new DatabaseSync(absFile);
	db.exec(SCHEMA);
	db.close();
	return absFile;
}

function openDb(file: string): DatabaseSync {
	const db = new DatabaseSync(file, { readOnly: true });
	openDbs.push(db);
	return db;
}

const ALL = { fromMs: 0 } as { fromMs: number };

// ───────────────────────────────────────────────────────── A1 分位数

describe("A1 分位数：性质而非印象", () => {
	it("n=1..12 扫描：SQL 分位与 JS nearest-rank 逐项一致，且必须是样本中的真实值", () => {
		for (let n = 1; n <= 12; n++) {
			const dir = tempDir();
			const values = Array.from({ length: n }, (_, i) => 1000 * (i + 1));
			const file = makeDb(
				dir,
				values.map((v) => ({ tsMs: 1, ttft: v, latency: v + 100 })),
			);
			const s = aggregateSummary(openDb(file), { window: ALL, client: "all" });
			const sorted = [...values].sort((a, b) => a - b);
			expect(s.ttft.samples, `n=${n} samples`).toBe(n);
			for (const p of ["p50", "p90", "p99"] as const) {
				const pr = Number(p.slice(1)) / 100;
				const ref = percentileOf(sorted, pr);
				expect(s.ttft[p], `n=${n} ${p}`).toBe(ref);
				expect(sorted, `n=${n} ${p} 必须是真实样本`).toContain(s.ttft[p]);
			}
			expect(s.ttft.p50! <= s.ttft.p90!, `n=${n} 分位必须单调`).toBe(true);
			expect(s.ttft.p90! <= s.ttft.p99!, `n=${n} 分位必须单调`).toBe(true);
		}
	});

	it("代码注释声称 pos=round(p*(n-1))：偶数样本 p50 必须取中间偏上位（可验证的文档口径）", () => {
		const dir = tempDir();
		const file = makeDb(
			dir,
			[10, 20, 30, 40].map((v) => ({ tsMs: 1, ttft: v, latency: v + 1 })),
		);
		const s = aggregateSummary(openDb(file), { window: ALL, client: "all" });
		expect(percentilePos(0.5, 4)).toBe(2);
		expect(s.ttft.p50).toBe(30);
	});

	it("全等值 / 单行 / 极端离群：不产生 NaN、不外插值", () => {
		const dir = tempDir();
		const file = makeDb(dir, [
			...Array.from({ length: 99 }, () => ({ tsMs: 1, ttft: 4000, latency: 5000 })),
			{ tsMs: 1, ttft: 219_944, latency: 355_509 }, // 真库实测最大值
		]);
		const s = aggregateSummary(openDb(file), { window: ALL, client: "all" });
		expect(s.ttft.p50).toBe(4000);
		expect(s.ttft.p99).toBe(4000);
		expect(Number.isFinite(s.ttft.avg!)).toBe(true);

		const single = tempDir();
		const f2 = makeDb(single, [{ tsMs: 1, ttft: 777, latency: 1000 }]);
		const s2 = aggregateSummary(openDb(f2), { window: ALL, client: "all" });
		expect([s2.ttft.p50, s2.ttft.p90, s2.ttft.p99]).toEqual([777, 777, 777]);
	});

	it("全 NULL / 全 0 / 空窗口：分位一律 null，绝不返回 0 或 NaN", () => {
		const dir = tempDir();
		const file = makeDb(
			dir,
			[
				{ tsMs: 1, ttft: null, latency: 900 },
				{ tsMs: 1, ttft: null, latency: 900 },
			],
			{ file: "null.ttft.db" },
		);
		const sNull = aggregateSummary(openDb(file), { window: ALL, client: "all" });
		expect(sNull.calls).toBe(2);
		expect(sNull.ttft).toEqual({ samples: 0, p50: null, p90: null, p99: null, avg: null });

		const f2 = join(dir, "zero.ttft.db");
		const db2 = new DatabaseSync(f2);
		openDbs.push(db2);
		db2.exec(SCHEMA);
		db2.exec(
			`INSERT INTO usage_events(timestamp,timestamp_ms,latency_ms,ttft_ms) VALUES
			 ('2026-01-01T00:00:00+08:00',1,500,0),('2026-01-01T00:00:00+08:00',2,500,0)`,
		);
		const sZero = aggregateSummary(openDb(f2), { window: ALL, client: "all" });
		expect(sZero.ttft.samples, "ttft=0 不是样本").toBe(0);
		expect(sZero.ttft.p50).toBeNull();
	});
});

// ───────────────────────────────────────────────────────── A2 日界

describe("A2 「今日」日界按服务器本地时区，不受 UTC 影响", () => {
	it("fromMs 恰为本地 00:00（与 Date 本地构造一致），而非 UTC 日界", () => {
		const now = Date.now();
		const d = new Date(now);
		const localMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		expect(resolveWindow("today", now).fromMs).toBe(localMidnight);
		// 只有本机 TZ=UTC 时两者才相同；否则必须能区分
		const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
		if (localMidnight !== utcMidnight) {
			expect(resolveWindow("today", now).fromMs).not.toBe(utcMidnight);
		}
	});

	it("刚过本地午夜 1 秒的行算今日；午夜前 1 秒的行不算", () => {
		const from = resolveWindow("today").fromMs;
		const dir = tempDir();
		const file = makeDb(
			dir,
			[
				{ tsMs: from - 1000, ttft: 100, latency: 200 },
				{ tsMs: from + 1000, ttft: 300, latency: 400 },
				{ tsMs: from + 2000, ttft: 500, latency: 600 },
			],
			{ file: "boundary.db" },
		);
		const s = aggregateSummary(openDb(file), { window: resolveWindow("today"), client: "all" });
		expect(s.calls).toBe(2);
		expect(s.ttft.p50).toBe(500);
	});

	it("本地 00:00–08:00 之间的行（UTC 仍属昨日）必须计入今日：真库 +08:00 场景", () => {
		// 构造一个绝对时刻：某日 01:30 本地。它是否属于「今日」只由本地日界决定。
		const dir = tempDir();
		const probe = resolveWindow("today");
		const file = makeDb(dir, [{ tsMs: probe.fromMs + 90 * 60 * 1000, ttft: 1200, latency: 2000 }], {
			file: "early-morning.db",
		});
		const s = aggregateSummary(openDb(file), { window: probe, client: "all" });
		expect(s.calls).toBe(1);
		// 该行的 ISO 字符串（UTC）日期可能 != 本地日期，这里断言按 ms 过滤而非按字符串日期
		const row = listEvents(openDb(file), { window: probe, client: "all", limit: 5 })[0]!;
		expect(row.timestampMs).toBe(probe.fromMs + 90 * 60 * 1000);
	});

	it("7d/30d 是滚动窗口而非自然日", () => {
		const now = 1_790_000_000_000;
		expect(resolveWindow("7d", now).fromMs).toBe(now - 7 * 86_400_000);
		expect(resolveWindow("30d", now).fromMs).toBe(now - 30 * 86_400_000);
		expect(resolveWindow("today", now).nowMs).toBe(now);
	});
});

// ───────────────────────────────────────────────────────── A3 计数与除零

describe("A3 计数口径与除零", () => {
	it("failed 与 canceled 同时为 1 只算一次（并集），且 canceled ⊂ failed 时不虚高", () => {
		const dir = tempDir();
		const file = makeDb(
			dir,
			[
				{ tsMs: 1, failed: 0, canceled: 0, ttft: 10, latency: 20 },
				{ tsMs: 1, failed: 1, canceled: 0, ttft: 10, latency: 20 },
				{ tsMs: 1, failed: 1, canceled: 1, ttft: 10, latency: 20 },
				{ tsMs: 1, failed: 0, canceled: 1, ttft: 10, latency: 20 },
			],
			{ file: "flags.db" },
		);
		const s = aggregateSummary(openDb(file), { window: ALL, client: "all" });
		expect(s.calls).toBe(4);
		expect(s.failed).toBe(2);
		expect(s.canceled).toBe(2);
		expect(s.bad, "并集：3 行异常而非 4").toBe(3);
		expect(s.success).toBe(1);
		expect(s.successRate).toBeCloseTo(0.25, 10);
	});

	it("latency=0 / latency==ttft / output=0 都不进 tok/s，且绝不出现 Infinity", () => {
		const dir = tempDir();
		const file = makeDb(
			dir,
			[
				{ tsMs: 1, latency: 0, ttft: 0, output: 500, total: 500 }, // 除零源
				{ tsMs: 1, latency: 1000, ttft: 1000, output: 500 }, // 分母 0
				{ tsMs: 1, latency: 1000, ttft: 200, output: 0 }, // 分子 0
				{ tsMs: 1, latency: 1000, ttft: 200, output: 160 }, // 正常：160/0.8s = 200
			],
			{ file: "divzero.db" },
		);
		const s = aggregateSummary(openDb(file), { window: ALL, client: "all" });
		expect(s.tokPerSecSamples).toBe(1);
		expect(s.tokPerSec).toBeCloseTo(200, 6);
		expect(Number.isFinite(s.tokPerSec!)).toBe(true);
		expect(JSON.stringify(s)).not.toMatch(/Infinity|NaN/);
		// 全零时延窗口：latencyAvg 也必须 null 而非 0（0 会被前端画成贴地直线）
		const f2 = join(dir, "allzero.db");
		const db2 = new DatabaseSync(f2);
		openDbs.push(db2);
		db2.exec(SCHEMA);
		db2.exec(
			`INSERT INTO usage_events(timestamp,timestamp_ms,latency_ms,ttft_ms,output_tokens)
			 VALUES ('2026-01-01T00:00:00+08:00',1,0,0,100)`,
		);
		const z = aggregateSummary(openDb(f2), { window: ALL, client: "all" });
		expect(z.latencyAvg).toBeNull();
		expect(z.latencyMax).toBeNull();
		expect(z.tokPerSec).toBeNull();
	});

	it("空窗口：所有指标为 0/null，不出现 NaN", () => {
		const dir = tempDir();
		const file = makeDb(dir, [], { file: "empty.db" });
		const s = aggregateSummary(openDb(file), { window: { fromMs: Date.now() }, client: "all" });
		expect(s).toMatchObject({ calls: 0, failed: 0, canceled: 0, bad: 0, success: 0 });
		expect(s.successRate).toBeNull();
		expect(s.ttft.p50).toBeNull();
		expect(s.tokens.total).toBe(0);
		expect(aggregateSeries(openDb(file), { window: { fromMs: 0 }, client: "all" })).toEqual([]);
		expect(aggregateModels(openDb(file), { window: { fromMs: 0 }, client: "all" })).toEqual([]);
		expect(listEvents(openDb(file), { window: { fromMs: 0 }, client: "all", limit: 5 })).toEqual([]);
	});

	it("token 求和超 2^53：服务层必须降级，而不是整块看板打空", async () => {
		const dir = tempDir();
		const big = 4_500_000_000_000_000; // 4.5e15，三行合计 1.35e16 > 2^53
		const file = makeDb(
			dir,
			[
				{ tsMs: Date.now(), total: big, ttft: 1, latency: 2 },
				{ tsMs: Date.now(), total: big, ttft: 1, latency: 2 },
				{ tsMs: Date.now(), total: big, ttft: 1, latency: 2 },
			],
			{ file: "overflow.db" },
		);
		// 行为契约：超安全整数的 token 合计必须能正确返回（readBigInts 或转 REAL），
		// 不得抛错、不得降级、不得静默丢数字
		const svc = createStatsService({ getSettings: () => ({ dbPath: file }) });
		const r = await svc.summary({ window: "30d" });
		expect(r.ok, `实测 ${JSON.stringify(r).slice(0, 200)}`).toBe(true);
		expect(r.summary.tokens.total).toBe(big * 3);
		expect(() => JSON.stringify(r)).not.toThrow(); // BigInt泄到路由负载会在 res.json 里抛 TypeError
		svc.dispose();
	});

	it("真库量级（6 万行）的单次聚合必须远低于 1 秒（同步 SQL 会阻塞事件循环）", () => {
		const dir = tempDir();
		const rows: Row[] = [];
		const base = Date.now();
		for (let i = 0; i < 60_000; i++) {
			rows.push({
				tsMs: base - i * 1000,
				ttft: (i % 900) + 500,
				latency: (i % 900) + 1500,
				model: `m-${i % 7}`,
				output: 100,
				total: 300,
			});
		}
		const file = makeDb(dir, rows, { file: "bulk.db" });
		const db = openDb(file);
		const t = Date.now();
		aggregateSummary(db, { window: { fromMs: 0 }, client: "all" });
		const summaryMs = Date.now() - t;
		const t2 = Date.now();
		const models = aggregateModels(db, { window: { fromMs: 0 }, client: "all" });
		const modelsMs = Date.now() - t2;
		const t3 = Date.now();
		const hours = aggregateSeries(db, { window: { fromMs: 0 }, client: "all" });
		const seriesMs = Date.now() - t3;
		expect(models.length).toBe(7);
		expect(hours.length > 0).toBe(true);
		expect(summaryMs < 1000, `summary ${summaryMs}ms 必须 <1s（同步 SQL 会阻塞事件循环）`).toBe(true);
		expect(modelsMs < 1000, `models ${modelsMs}ms 必须 <1s`).toBe(true);
		expect(seriesMs < 1000, `series ${seriesMs}ms 必须 <1s`).toBe(true);
	}, 120_000);
});

// ────────────────────────────────────────────────────────── C 安全

describe("C 安全：路径校验与参数白名单", () => {
	it("dbPath 攻击表：只接受绝对路径 + .db + 存在的普通文件", () => {
		const dir = tempDir();
		const good = makeDb(dir, [{ tsMs: 1, ttft: 1, latency: 2 }], { file: "usage.db" });
		const upper = join(dir, "UPPER.DB");
		seedDb(upper);
		const dbDir = join(dir, "is-a-dir.db");
		mkdirSync(dbDir, { recursive: true });
		const cases: Array<[unknown, boolean, string]> = [
			[good, true, "合法路径"],
			[upper, true, "扩展名大小写不敏感"],
			[`  ${good}  `, true, "首尾空格容忍"],
			["usage.db", false, "相对路径"],
			["./usage.db", false, "点斜杠"],
			["", false, "空串"],
			[null, false, "null"],
			[{ toString: () => good }, false, "非字符串"],
			[`${dir}${sep}usage.sqlite`, false, "错扩展名"],
			[`${good}-journal`, false, ".db-journal"],
			[`${dir}${sep}..${sep}usage.db`, false, "含 .. 段"],
			[`${good}\u0000.db`, false, "含 NUL"],
			[dbDir, false, "后缀 .db 的目录"],
			[dir, false, "目录本身"],
		];
		for (const [input, wantOk, label] of cases) {
			const r = validateDbPath(input);
			expect(r.ok, `${label} → ${JSON.stringify(String(input))}`).toBe(wantOk);
			if (!r.ok) expect(typeof r.reason).toBe("string");
		}
		// 目录穿越：即便 normalize 后能落在允许目录内，也必须先拒绝 .. 段
		expect(validateDbPath(`${dir}${sep}a${sep}..${sep}usage.db`).ok).toBe(false);
	});

	it("route 参数注入：非法 window/client/limit 全被白名单拦下，表与数据完好", async () => {
		const dir = tempDir();
		const file = makeDb(
			dir,
			Array.from({ length: 5 }, () => ({ tsMs: Date.now(), ttft: 100, latency: 200, output: 10 })),
			{ file: "usage.db" },
		);
		const svc = createStatsService({ getSettings: () => ({ dbPath: file }) });
		const hostile = [
			"0; DROP TABLE usage_events; --",
			"' OR 1=1 --",
			"1=1",
			"../../etc/passwd",
			"__proto__",
			"constructor",
			"9".repeat(30),
		];
		for (const h of hostile) {
			const a = await svc.summary({ window: h, client: h });
			expect(a.ok, `hostile window/client: ${h}`).toBe(true);
			expect(a.meta.window).toBe("today");
			expect(a.meta.client).toBe("all");
			const e = await svc.events({ window: "today", client: "all", limit: h });
			expect(e.ok).toBe(true);
			expect(e.events.length <= 20, `limit 未夹取：${e.events.length}`).toBe(true);
		}
		expect(svc.summary()).toBeDefined();
		const rows = new DatabaseSync(file, { readOnly: true }).prepare("select count(*) c from usage_events").get() as {
			c: number;
		};
		expect(rows.c).toBe(5);
		svc.dispose();
	});

	it("路由查询参数不能覆盖 dbPath：注入其他库路径必须被忽略", async () => {
		const dir = tempDir();
		const configured = makeDb(dir, [{ tsMs: Date.now(), ttft: 100, latency: 200, model: "own" }], {
			file: "usage.db",
		});
		const other = tempDir();
		const injected = makeDb(other, [{ tsMs: Date.now(), ttft: 100, latency: 200, model: "victim" }], {
			file: "usage.db",
		});
		const host = createMockHost({ settings: { dbPath: configured } });
		const dispose = activate(host);
		const route = host.mock.routes.find((r) => r.path.endsWith("/api/summary"))!;
		expect(route, "必须注册 /api/summary").toBeTruthy();
		let payload: Record<string, unknown> = {};
		await route.handler(
			{ query: { dbPath: injected, window: "30d", client: "pi" } },
			{ status() {}, json: (o: Record<string, unknown>) => (payload = o) },
		);
		expect(payload.ok).toBe(true);
		expect((payload.meta as { dbPath: string }).dbPath).toBe(configured);
		expect((payload.meta as { dbPath: string }).dbPath).not.toBe(injected);
		const models = (payload.models as Array<{ model: string }>).map((m) => m.model);
		expect(models).toEqual(["own"]);
		dispose();
	});

	it("事件明细绝不下发敏感列（邮箱 / api_key / IP / failure_body / request_id）", async () => {
		const dir = tempDir();
		const file = makeDb(dir, [{ tsMs: Date.now(), ttft: 100, latency: 200 }], { file: "usage.db" });
		const svc = createStatsService({ getSettings: () => ({ dbPath: file }) });
		const res = await svc.events({ window: "30d", limit: 5 });
		expect(res.ok).toBe(true);
		const blob = JSON.stringify(res);
		for (const leak of [
			"upstream-account@example.com",
			"deadbeefcafe0001",
			"sk-asdf1234",
			"198.51.100.7",
			"203.0.113.9",
			"secret upstream failure body",
			"req-0001",
		]) {
			expect(blob, `明细不得包含 ${leak}`).not.toContain(leak);
		}
		const keys = Object.keys(res.events[0]).sort();
		expect(keys.some((k) => /source|apikey|apikeyhash|ip|forward|body|email/i.test(k))).toBe(false);
		svc.dispose();
	});

	it("聚合结果与 meta 里也不得出现上游账号邮箱", async () => {
		const dir = tempDir();
		const file = makeDb(dir, [{ tsMs: Date.now(), ttft: 100, latency: 200 }], { file: "usage.db" });
		const svc = createStatsService({ getSettings: () => ({ dbPath: file }) });
		const blob =
			JSON.stringify(await svc.summary({ window: "30d" })) + JSON.stringify(await svc.series({ window: "30d" }));
		expect(blob).not.toContain("example.com");
		expect(blob).not.toContain("deadbeef");
		svc.dispose();
	});

	it("client=pi 只按 UA 前缀归族：真库出现的 5 种 UA 逐一核对", () => {
		const dir = tempDir();
		const uas = [
			"pi (win32 10.0.26200; x64)",
			"pi/1.4.0 (win32; node/v24.19.0; x64)",
			"ZCode/3.11.2 ai-sdk",
			"Bun/1.3.14",
			"claude-cli/2.1.257 (claude-code)",
		];
		const file = makeDb(
			dir,
			uas.map((ua, i) => ({ tsMs: Date.now() - i, ua, ttft: 100, latency: 200 })),
			{ file: "usage.db" },
		);
		const all = aggregateSummary(openDb(file), { window: { fromMs: 0 }, client: "all" });
		const pi = aggregateSummary(openDb(file), { window: { fromMs: 0 }, client: "pi" });
		expect(all.calls).toBe(5);
		expect(pi.calls, "pi 家族 = 前两条").toBe(2);
		expect(clientFamily(uas[0])).toBe("pi");
		expect(clientFamily(uas[1])).toBe("pi");
		expect(clientFamily(uas[2])).toBe("zcode");
		expect(clientFamily(uas[3])).toBe("bun");
		expect(clientFamily(uas[4])).toBe("claude-cli");
		expect(clientFamily("WeirdBot/1.0")).toBe("other");
		expect(clientFamily("")).toBe("other"); // R5：未识别一律 other
		expect(CLIENT_KEYS).toEqual(["all", "pi"]);
		expect(WINDOW_KEYS).toEqual(["today", "7d", "30d"]);
	});
});

// ───────────────────────────────────────────────────────── B 健壮性

describe("B 健壮性：缺库 / 缺表 / 锁库 / 句柄释放", () => {
	it("库文件不存在：ok:false + 明确原因，不抛错", async () => {
		const dir = tempDir();
		const svc = createStatsService({ getSettings: () => ({ dbPath: join(dir, "nope.db") }) });
		const r = await svc.summary({});
		expect(r.ok).toBe(false);
		expect(r.reasonEn).toBeTruthy();
		expect(svc.state().open).toBe(false);
		svc.dispose();
	});

	it("空库（有效 SQLite 文件但没有 usage_events 表）：降级为 schema 而非崩溃", async () => {
		const dir = tempDir();
		const file = join(dir, "usage.db");
		const seed = new DatabaseSync(file);
		openDbs.push(seed);
		seed.exec("create table unrelated(x int)");
		seed.close();
		const svc = createStatsService({ getSettings: () => ({ dbPath: file }) });
		const r = await svc.summary({ window: "30d" });
		expect(r.ok).toBe(false);
		expect(r.code, `code=${r.code}`).toBe("schema");
		expect(String(r.reason)).toContain("usage_events");
		svc.dispose();
	});

	it("后缀 .db 但不是 SQLite 文件（文本）：降级并给出可读原因，不抛错", async () => {
		const dir = tempDir();
		const file = join(dir, "usage.db");
		writeFileSync(file, "this is definitely not a sqlite database\n".repeat(50));
		const svc = createStatsService({ getSettings: () => ({ dbPath: file }) });
		const r = await svc.events({ window: "30d", limit: 3 });
		expect(r.ok).toBe(false);
		expect(typeof r.reason).toBe("string");
		expect(r.reason.length <= 400, `原因文案过长：${r.reason}`).toBe(true);
		svc.dispose();
	});

	it("库被另一进程写事务锁住：只读查询必须降级为 busy 并退避，不抛错", async () => {
		const dir = tempDir();
		const file = makeDb(dir, [{ tsMs: Date.now(), ttft: 100, latency: 200 }], {
			file: "usage.db",
			journal: "delete", // 回滚日志模式：排除 WAL 并发读不互斥的干扰
		});
		// 真·另一进程：同进程内两个句柄的锁不互斥（实测读会成功，测不出 BUSY）
		const blocker = spawn(
			process.execPath,
			[
				"-e",
				`const {DatabaseSync}=require("node:sqlite");
				 const db=new DatabaseSync(${JSON.stringify(file)});
				 db.exec("BEGIN EXCLUSIVE");
				 db.exec("INSERT INTO usage_events(timestamp,timestamp_ms,latency_ms,ttft_ms) VALUES ('2026-01-01T00:00:00+08:00',9,9,9)");
				 console.log("LOCKED");
				 setTimeout(()=>process.exit(0), 20000);`,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		await new Promise<void>((res, rej) => {
			const to = setTimeout(() => rej(new Error("blocker 未就绪")), 20_000);
			blocker.stdout?.on("data", (b: Buffer) => {
				if (String(b).includes("LOCKED")) {
					clearTimeout(to);
					res();
				}
			});
			blocker.on("exit", (c) => {
				clearTimeout(to);
				if (c) rej(new Error(`blocker 异常退出 ${String(String)}`));
			});
		});
		try {
			const svc = createStatsService({ getSettings: () => ({ dbPath: file }) });
			const t = Date.now();
			const r = await svc.summary({ window: "30d" });
			const ms = Date.now() - t;
			expect(r.ok, `被锁时不能报成功：${JSON.stringify(r).slice(0, 200)}`).toBe(false);
			expect(r.code, `应归为 busy，实测 ${String(r.code)}`).toBe("busy");
			expect(ms > 1000, `busy_timeout=2000 应产生等待（实测 ${ms}ms）`).toBe(true);
			expect(svc.state().cooldownUntil > Date.now(), "失败后必须进入冷却").toBe(true);
			svc.dispose();
		} finally {
			blocker.kill();
			await new Promise((r2) => blocker.once("exit", () => r2(undefined)));
		}
		// 解锁后必须能恢复
		const svc2 = createStatsService({ getSettings: () => ({ dbPath: file }) });
		const after = await svc2.summary({ window: "30d" });
		expect(after.ok, `解锁后应恢复：${JSON.stringify(after).slice(0, 200)}`).toBe(true);
		expect(after.summary.calls).toBe(1); // 子进程未提交，事务已回滚
		svc2.dispose();
	}, 90_000);

	it("dispose 后必须释放文件句柄（Windows 下不释放就删不掉、代理也换不了库文件）", async () => {
		const dir = tempDir();
		const file = makeDb(dir, [{ tsMs: Date.now(), ttft: 100, latency: 200 }], { file: "usage.db" });
		const svc = createStatsService({ getSettings: () => ({ dbPath: file }) });
		expect((await svc.summary({ window: "30d" })).ok).toBe(true);
		expect(svc.state().open).toBe(true);
		svc.dispose();
		expect(svc.state().open).toBe(false);
		expect(() => rmSync(file)).not.toThrow();
		expect(existsSync(file)).toBe(false);
	});

	it("连接复用：多次查询不得每次重开（stat/open 次数不增长）", async () => {
		const dir = tempDir();
		const file = makeDb(dir, [{ tsMs: Date.now(), ttft: 100, latency: 200 }], { file: "usage.db" });
		const svc = createStatsService({ getSettings: () => ({ dbPath: file, cacheTtlSec: 10 }) });
		await svc.summary({ window: "30d" });
		const opened = svc.state();
		for (let i = 0; i < 5; i++) await svc.series({ window: "7d" });
		expect(svc.state().dbPath).toBe(opened.dbPath);
		expect(svc.state().open).toBe(true);
		expect((await svc.series({ window: "7d" })).meta.cached).toBe(true);
		svc.dispose();
	});

	it("账本不可用时不刷屏：首次预热后连续 10 次预热零新增日志（冷却不被重试风暴后推）", async () => {
		// 用 bad-path（指向不存在的 .db）保证任何机器上都是「账本不可用」这一支
		const missing = join(tempDir(), "no-such-ledger.db");
		const host = createMockHost({ settings: { dbPath: missing } });
		const dispose = activate(host);
		await new Promise((r) => setTimeout(r, 30));
		const logsAfterFirst = host.logs.length;
		expect(logsAfterFirst >= 1, "账本不可用必须留一条可观测日志").toBe(true);
		expect(logsAfterFirst <= 3, `首次预热的发现日志应 ≤3 条，实测 ${logsAfterFirst}`).toBe(true);
		for (let i = 0; i < 10; i++) {
			await host.mock.fireSchedules();
			await new Promise((r) => setTimeout(r, 1));
		}
		expect(host.logs.length, "冷却期内重复预热不得追加日志").toBe(logsAfterFirst);
		dispose();
	});

	it("db-not-found 是结构化空态：不抛错、带已试候选与 hint，且不静默回退到 0 数据", async () => {
		const emptyRoot = tempDir("cps-empty-root-");
		const svc = createStatsService({
			getSettings: () => ({ searchRoots: emptyRoot }),
			discovery: sandboxDeps(emptyRoot),
		});
		const res = (await svc.summary({ window: "today" })) as {
			ok: boolean;
			code?: string;
			hint?: string;
			candidates?: string[];
			meta: { dbPath: string; pathSource?: string };
		};
		expect(res.ok).toBe(false);
		expect(res.code).toBe("db-not-found");
		expect(Array.isArray(res.candidates), "空态必须带已试候选列表").toBe(true);
		expect((res.candidates ?? []).length > 0, "候选列表不得为空").toBe(true);
		expect(String(res.hint)).toContain("usage.db");
		expect(res.meta.dbPath, "空态不得伪造账本路径").toBe("");
		// 底栏文案也要点名原因，不能显示成 0 请求
		const badge = svc.badge(await svc.warm());
		expect(badge.badge).toBe("--");
		expect(badge.hint).toContain("账本");
		svc.dispose();
	});

	it("自动发现：取版本号最新目录；无 usage.db 的跳过；无版本号的排最后", () => {
		const root = tempDir("cpx-root-");
		mkdirSync(join(root, "EasyCLIProxyAPI-v0.2.25-Windows-amd64", "usage-records"), { recursive: true });
		mkdirSync(join(root, "EasyCLIProxyAPI-v0.3.50-Linux-amd64", "usage-records"), { recursive: true });
		mkdirSync(join(root, "EasyCLIProxyAPI-backup", "usage-records"), { recursive: true });
		mkdirSync(join(root, "EasyCLIProxyAPI-v9.9.9-empty", "usage-records"), { recursive: true });
		const older = join(root, "EasyCLIProxyAPI-v0.2.25-Windows-amd64", "usage-records", "usage.db");
		const newer = join(root, "EasyCLIProxyAPI-v0.3.50-Linux-amd64", "usage-records", "usage.db");
		const backup = join(root, "EasyCLIProxyAPI-backup", "usage-records", "usage.db");
		for (const f of [older, newer, backup]) seedDb(f);
		const deps = sandboxDeps(root);
		expect(discoverDbPath([root], deps)).toBe(newer);
		// 最新版本目录里库文件消失 → 回落到次新（无版本号的 backup 排最后）
		rmSync(newer);
		expect(discoverDbPath([root], deps)).toBe(older);
		void backup;
	});

	it("自动发现在不存在的根 / 根是文件 / 含 .. 的根下都不抛错", () => {
		const dir = tempDir();
		const aFile = join(dir, "i-am-a-file");
		writeFileSync(aFile, "x");
		const deps = sandboxDeps(dir);
		expect(discoverDbPath([join(dir, "does-not-exist")], deps)).toBe(null);
		expect(discoverDbPath([aFile], deps)).toBe(null);
		expect(discoverDbPath([dir], deps)).toBe(null); // 根存在但没有 *CLIProxyAPI* 目录
		expect(defaultSearchRoots(deps).length).toBeGreaterThan(0);
		const r = resolveDbPath({ searchRoots: `${aFile};${join(dir, "nope")}` }, deps);
		expect(r.ok).toBe(false);
		expect((r as { code?: string }).code).toBe("db-not-found");
	});
});

// ───────────────────────────────────────────────────────── D/E 一致性与装配

describe("D 一致性与插件装配", () => {
	it("activate 注册 4 条 GET + 1 条 POST 路由 + 1 个预热任务；disposer 释放连接", async () => {
		const dir = tempDir();
		const file = makeDb(dir, [{ tsMs: Date.now(), ttft: 1200, latency: 3400, output: 40 }], {
			file: "usage.db",
		});
		const host = createMockHost({ settings: { dbPath: file, cacheTtlSec: 60 } });
		const dispose = activate(host);
		// R2/R3 新增：GET /api/prices 与 POST /api/prices/refresh（人类 R5 裁定按新能力断言）
		expect(host.mock.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
			["GET /api/events", "GET /api/prices", "GET /api/series", "GET /api/summary", "POST /api/prices/refresh"].sort(),
		);
		expect(host.mock.schedules.length).toBe(1);
		expect(host.mock.schedules[0].spec).toBe(60_000);
		await new Promise((r) => setTimeout(r, 50));
		const updates = host.calls.filter((c) => c.method === "ui.update");
		expect(updates.length >= 1, `底标未更新`).toBe(true);
		const patch = updates[0].args[1] as { badge: string };
		expect(String(patch.badge)).toMatch(/^[\d.]+k?\/.+/);
		dispose();
		expect(() => rmSync(file)).not.toThrow();
	});

	it("预热间隔跟随设置项并被夹在 10–3600 秒", () => {
		expect(resolveTtlMs(60)).toBe(60_000);
		expect(resolveTtlMs(1)).toBe(10_000);
		expect(resolveTtlMs(99_999)).toBe(3_600_000);
		expect(resolveTtlMs(0)).toBe(60_000);
		expect(resolveTtlMs(-5)).toBe(60_000);
		expect(resolveTtlMs("abc")).toBe(60_000);
		expect(resolveTtlMs(undefined)).toBe(60_000);
	});

	it("clampLimit 白名单化", () => {
		expect(clampLimit(5)).toBe(5);
		expect(clampLimit(1e9)).toBe(100);
		expect(clampLimit(-3)).toBe(1);
		expect(clampLimit("abc")).toBe(20);
		expect(clampLimit(undefined)).toBe(20);
		expect(clampLimit(Number.NaN)).toBe(20);
	});

	it("manifest 硬约束：版本 1.0.0 / 权限四能力含 net + netAllowlist 只三域 / 底栏 order 17 align start / view:false + preload:true", () => {
		const m = readManifest();
		expect(m.id).toBe("usage-ledger");
		expect(m.name).toBe("用量账本");
		expect(m.nameEn).toBe("Usage Ledger");
		expect(m.version).toBe("1.0.0"); // 首个对外版本；版本号随功能改动同提交递升
		expect(compareSemver(m.version, "0.1.0") >= 0, `版本不得低于 0.1.0，实为 ${m.version}`).toBe(true);
		expect(m.apiVersion).toBe(2);
		expect(m.icon).toBe("📊");
		expect(m.icon).not.toBe("⚡");
		// 硬约束 3 原定 [ui,http,storage]；R2#5 明确授权加 net（拉三源价目表）
		expect(m.permissions).toEqual(["ui", "http", "net", "storage"]);
		expect(m.permissions.includes("net"), "R2#5 拉价目表必需 net 能力").toBe(true);
		// net 的授权范围只能三源：多一个域就是越权
		expect([...(m.netAllowlist ?? [])].sort()).toEqual(["models.dev", "openrouter.ai", "raw.githubusercontent.com"]);
		expect(m.preload).toBe(true);
		expect(m.view).toBe(false);
		const bb = m.ui.bottombar[0];
		expect(bb.order).toBe(17);
		expect(bb.align).toBe("start");
		expect(m.ui["topbar.primary"][0].id).toBe("__view");
		expect(m.ui["topbar.primary"][0].kind).toBe("view");
	});

	it("底栏只有一条 bottombar 项，且 order 17 由本插件独占", () => {
		// 独立仓库看不到其它插件，跨插件冲突面只能在 registry 仓库校；
		// 本仓库只校：我们的 bottombar 只占一个 (slot, align, order) 坐标，且它就是 17。
		const rows = allManifests();
		const seen = new Map<string, string>();
		for (const r of rows) {
			for (const item of r.items) {
				if (item.slot !== "bottombar" || typeof item.order !== "number") continue;
				const key = `${item.slot}|${item.align ?? "start"}|${item.order}`;
				const prev = seen.get(key);
				if (prev) expect(prev, `底标 order 冲突 ${key}`).toBe(r.id);
				seen.set(key, r.id);
			}
		}
		expect(seen.get("bottombar|start|17"), "order 17 必须归本插件").toBe("usage-ledger");
		expect([...seen.keys()], `bottombar 只应占一个坐标，实为 ${[...seen.keys()].join(" / ")}`).toHaveLength(1);
	});

	it("交付闸门：registry/plugin.json 必须与本仓库 manifest 对齐（id / source 指向本仓）", () => {
		// 宿主仓库的 catalog.json 交付闸门在独立仓库里由 registry PR 代替；
		// 这里改校「给 registry 用的元数据卡」与 manifest 不得脱节。
		type RegistryEntry = { id?: string; source?: string; author?: string; name?: string; description?: string };
		const entry = JSON.parse(readRepo("registry/plugin.json")) as RegistryEntry;
		const m = readManifest();
		expect(entry.id).toBe(m.id);
		expect(entry.name).toBe(m.name);
		expect(typeof entry.source, "registry 条目缺 source").toBe("string");
		expect(String(entry.source)).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
		expect(String(entry.source).split("/")[1], "source 仓库名必须与插件 id 一致（安装目录名 = id）").toBe(m.id);
		expect(entry.author, "author 必须是真实 GitHub 用户名").toMatch(/^[A-Za-z0-9_.-]+$/);
		expect(String(entry.source).split("/")[0], "source 的 owner 必须与 author 一致").toBe(entry.author);
		expect(typeof entry.description).toBe("string");
		expect((entry.description ?? "").length).toBeGreaterThanOrEqual(5);
		expect((entry.description ?? "").length).toBeLessThanOrEqual(300);
	});

	it("交付闸门：LICENSE 与 CHANGELOG 必须在仓库根", () => {
		expect(existsSync(resolveRepo("LICENSE")), "缺 LICENSE（registry 审计会告警）").toBe(true);
		const lic = readRepo("LICENSE");
		expect(lic).toMatch(/MIT License/);
		expect(lic).toContain("JSJ189");
		expect(existsSync(resolveRepo("CHANGELOG.md")), "缺 CHANGELOG.md").toBe(true);
	});

	it("交付闸门：README.md 必须写清 ttft 口径差异与「只报 token 不报金额」", () => {
		const p = "README.md";
		expect(existsSync(resolveRepo(p)), "缺 README.md").toBe(true);
		const txt = readRepo(p);
		expect(txt).toContain("response-speed");
		expect(txt.match(/首包|first byte|TTFT/i)).toBeTruthy();
		expect(txt.match(/价目|估算|不.*金额|price|cost/i)).toBeTruthy();
	});

	it("交付闸门：客户端只能在插件自己的容器内建 DOM，不触碰宿主节点", () => {
		const p = resolveRepo("client/entry.mjs");
		expect(existsSync(p), "缺 client/entry.mjs").toBe(true);
		const src = readFileSync(p, "utf8");
		// 禁止宿主选择器 / 宿主节点改写
		expect(src).not.toMatch(/querySelector\(\s*["'`]\.?(footer|topbar|app|messages|composer|sidebar)/i);
		expect(src).not.toMatch(/document\.body\.appendChild/);
		expect(src).not.toMatch(/host:cost/);
		expect(src).not.toMatch(/\bclassList\b/);
		expect(src).not.toMatch(/getElements?ByTagName/);
		// 注入自有 <style> 是仓库现有惯例（response-speed / sol-savings / run-trace / pm2-manager 同构），
		// 这里只要求：样式类名全部 .cps- 前缀隰离 + 必须有定时器卸载路径
		const css = src.match(/textContent\s*=\s*`([\s\S]*?)`;/)?.[1] ?? "";
		expect(css.length > 500, "未找到插件自有样式块（结构变了请同步本断言）").toBe(true);
		const rules = css
			.split("}")
			.map((b) => b.split("{")[0].trim())
			.filter((s) => s.length > 0 && !s.startsWith("@") && !s.includes("${"));
		const foreign = rules.filter((s) => !/\.cps-[\w-]+/.test(s));
		expect(foreign, `未用 .cps- 作作用域的规则：${foreign.join(" | ")}`).toEqual([]);
		expect(src).not.toMatch(/\.(footer|topbar|messages|composer|sidebar|msg-actions|chead|view-pane)\s*[,{:]/);
		expect(src).toMatch(/clearInterval/);
		expect(src).toMatch(/stopTimer\(\)/);
	});
});

// ────────────────────────────────────────────────────────── 辅助

describe("R3 拍板项：不内置快照 / 不写 E 盘 / 未知价不冒充 0", () => {
	it("(a) 仓库里不得提交大体量价格原始 JSON（单文件 >32KB 即红）", () => {
		// 独立仓库：插件根 = 仓库根，价格 fixture 在 tests/fixtures 下
		const roots = [repoRoot, resolveRepo("tests/fixtures/cliproxy-prices")];
		const big: string[] = [];
		const SKIP_DIRS = new Set(["node_modules", ".git", "coverage"]);
		// 锁文件不是价格快照，体积天然 >32KB，不进红线口径
		const SKIP_FILES = new Set(["package-lock.json"]);
		for (const root of roots) {
			if (!existsSync(root)) continue;
			const walk = (dir: string): void => {
				for (const e of readdirSync(dir, { withFileTypes: true })) {
					const p = join(dir, e.name);
					if (e.isDirectory()) {
						if (SKIP_DIRS.has(e.name)) continue;
						walk(p);
						continue;
					}
					if (SKIP_FILES.has(e.name)) continue;
					if (/\.(json|jsonl|csv)$/i.test(e.name) && byteSize(p) > 32 * 1024) big.push(`${p} (${byteSize(p)}B)`);
				}
			};
			walk(root);
		}
		expect(big, `价格原始快照禁止入库：${big.join(", ")}`).toEqual([]);
	});

	it("(a2) 价格原始快照不得留在工作树（含 scratch 目录），否则 git add -A 会把它提交", () => {
		const scratch = resolveRepo(".cps-tmp");
		const offenders: string[] = [];
		if (existsSync(scratch)) {
			for (const e of readdirSync(scratch)) {
				const p = join(scratch, e);
				if (/\.(json|jsonl|csv)$/i.test(e) && byteSize(p) > 32 * 1024) offenders.push(`${e} (${byteSize(p)}B)`);
			}
		}
		const gi = readFileSync(resolveRepo(".gitignore"), "utf8");
		if (offenders.length) {
			expect(gi, `工作树残留 ${offenders.join(" / ")}，必须删除或写进 .gitignore`).toMatch(/\.?cps-tmp\/?/);
		}
		expect(offenders.length === 0 || /cps-tmp/.test(gi)).toBe(true);
	});

	it("(b) 插件全量代码不得出现任何写盘 / 写事务入口", () => {
		const files = ["index.mjs", "client/entry.mjs", "scripts/verify-real-db.mjs"];
		const raw = files
			.filter((p) => existsSync(resolveRepo(p)))
			.map((p) => readFileSync(resolveRepo(p), "utf8"))
			.join("\n");
		// 先剔注释：否则「绝不执行 VACUUM」这类声明会被当成写入口
		const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		const forbidden: Array<[RegExp, string]> = [
			[/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|openSync)\s*\(/, "fs 写入类"],
			[/\b(renameSync|rename|unlinkSync|unlink|rmSync|rmdir)\s*\(/, "fs 改名/删除"],
			[/\b(VACUUM|REINDEX)\b/i, "维护类 SQL"],
			[/\b(INSERT INTO|DELETE FROM|REPLACE INTO)\b|\bUPDATE\s+\w+\s+SET\b/i, "写事务 SQL"],
			[/\bCREATE TABLE\b/i, "建表 SQL"],
			[/journal_mode\s*=\s*(wal|delete|truncate|persist|memory)/i, "修改 journal_mode"],
			[/\bBEGIN\s+(IMMEDIATE|EXCLUSIVE|DEFERRED)\b/i, "显式写事务"],
		];
		const hits = forbidden.filter(([re]) => re.test(src)).map(([, name]) => name);
		expect(hits, `发现写盘入口：${hits.join(" / ")}（E 盘绝对只读 + R3#3）`).toEqual([]);
	});

	it("(c) 客户端必须区分「未知价」与 0，并给出估算与占比", () => {
		const entry = resolveRepo("client/entry.mjs");
		if (!existsSync(entry)) return; // 未交付：前面的闸门用例已报红
		const src = readFileSync(entry, "utf8");
		if (!/price|计价|cost/i.test(src)) return; // 尚未实现计价：不卡此条，由 REVIEW 跟进
		expect(/未知价|unknown-price|noPrice/i.test(src), "必须显式区分未知价").toBe(true);
		expect(/估算|estimat/i.test(src), "金额必须标注估算").toBe(true);
		expect(/占比|share|ratio/i.test(src), "必须给未知价请求占比").toBe(true);
	});
});

// ───────────────────────────────────────────────────────── T3 反向攻击

/**
 * 同一模型、同一真实价（低档 2/6/0.2，高档 >200k 4/12/1）在三源的原生表达。
 * models.dev 已是 per-1M；LiteLLM / OpenRouter 是 per-token（OpenRouter 还是字符串），必须 ×1e6。
 */
const TRI_MODEL = "m-x";
const TRI_MD = {
	google: {
		models: {
			[TRI_MODEL]: {
				cost: {
					input: 2,
					output: 6,
					cache_read: 0.2,
					tiers: [{ input: 4, output: 12, cache_read: 1, tier: { type: "context", size: 200000 } }],
				},
			},
		},
	},
};
const TRI_LITELLM = {
	"google/m-x": {
		litellm_provider: "google",
		input_cost_per_token: 2e-6,
		output_cost_per_token: 6e-6,
		cache_read_input_token_cost: 0.2e-6,
		input_cost_per_token_above_200k_tokens: 4e-6,
		output_cost_per_token_above_200k_tokens: 12e-6,
		cache_read_input_token_cost_above_200k_tokens: 1e-6,
	},
};
const TRI_OPENROUTER = {
	data: [
		{
			id: "google/m-x",
			pricing: {
				prompt: "0.000002",
				completion: "0.000006",
				input_cache_read: "0.0000002",
				overrides: [
					{
						min_prompt_tokens: 200000,
						prompt: "0.000004",
						completion: "0.000012",
						input_cache_read: "0.000001",
					},
				],
			},
		},
	],
};

function triIndex(sourceId: string) {
	const raw: Record<string, unknown> = { modelsdev: TRI_MD, litellm: TRI_LITELLM, openrouter: TRI_OPENROUTER };
	return buildPriceIndex(normalizeSource(sourceId, raw[sourceId]));
}

describe("T3 三源换算 / 分段价 / 断网降级", () => {
	const SOURCES = ["modelsdev", "litellm", "openrouter"];

	for (const id of SOURCES) {
		it(`${id}: 归一后低档 2/6/0.2、高档 4/12/1（per-token 必须 ×1e6）`, () => {
			const hit = must(matchPrice(triIndex(id), { model: TRI_MODEL, provider: "google" }), `${id} 命中价`);
			const low = pickTier(hit.prices, hit.tiers, 100_000).prices;
			const high = pickTier(hit.prices, hit.tiers, 250_000).prices;
			expect([low.input, low.output, low.cacheRead].map((n) => Number(n.toFixed(6)))).toEqual([2, 6, 0.2]);
			expect([high.input, high.output, high.cacheRead].map((n) => Number(n.toFixed(6)))).toEqual([4, 12, 1]);
			expect(hit.tiers.length, `${id} 只能解析出一个 200k 档`).toBe(1);
		});
	}

	it("三源同模型同用_量：金额必须逐分一致（手算 0.862）", () => {
		const usage = { input: 250_000, cacheRead: 50_000, cacheWrite: 0, output: 1_000, reasoning: 0, total: 301_000 };
		const amounts = SOURCES.map((id) => {
			const hit = must(matchPrice(triIndex(id), { model: TRI_MODEL, provider: "google" }), `${id} 命中价`);
			return must(computeRowCost(hit, usage), `${id} 行金额`);
		});
		// 高档：(250000-50000)×4 + 50000×1 + 1000×12 = 862_000 → 0.862
		for (const a of amounts) {
			expect(a.amount).toBeCloseTo(0.862, 9);
			expect(a.tierSize).toBe(200_000);
		}
		expect(new Set(amounts.map((a) => a.amount.toFixed(6))).size, "三家换算后量级不一致").toBe(1);
	});

	it("多源价不一致：priority 优先（F-11 已修，R7 人类裁决）—— 1 票 models.dev 胜 2 票贵价，multiSource 留痕", () => {
		const md = normalizeSource("modelsdev", { p1: { models: { "amb-m": { cost: { input: 1, output: 3 } } } } });
		const ll = normalizeSource("litellm", {
			"x/amb-m": { litellm_provider: "xai2", input_cost_per_token: 100e-6, output_cost_per_token: 400e-6 },
		});
		const or = normalizeSource("openrouter", {
			data: [{ id: "z/amb-m", pricing: { prompt: "0.0001", completion: "0.0004" } }],
		});
		const idx = buildPriceIndex([...md, ...ll, ...or]);
		const usage = { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 1_000, reasoning: 0, total: 2_000 };
		// provider 未映射 → 走 wildcard：跨源分歧按 (priority 升序, count 降序)，models.dev 1 票胜 2 票贵价
		const hit = must(matchPrice(idx, { model: "amb-m", provider: "no-such-provider" }), "wildcard 命中");
		expect(hit.via).toBe("wildcard");
		expect(hit.source).toBe("modelsdev"); // F-11 旧行为（错误）：被 2 票 litellm 多数价静默压掉
		expect(hit.multiSource, "跨源价格分歧必须带标记（客户端「多源不一致」）").toBe(true);
		const amount = must(computeRowCost(hit, usage), "wildcard 金额").amount;
		expect(Number(amount.toFixed(6))).toBe(0.004); // 与优先源精确命中同价；旧 bug 行为是 0.5（125× 高估）
	});

	it("grok-4.7：>200k 真走高档（cache_read 1 而非低档），-4.7 不被当成 effort 后缀", () => {
		expect(stripEffort("grok-4.7")).toBe("grok-4.7"); // 数字版本不得被剥
		expect(stripEffort("grok-4.7-high")).toBe("grok-4.7"); // 真 effort 后缀必须剥
		const hit = must(
			matchPrice(buildPriceIndex(normalizeModelsDev(PRICE_FIXTURE)), { model: "grok-4.7", provider: "xai" }),
			"grok 命中价",
		);
		const low = pickTier(hit.prices, hit.tiers, 200_000); // 阈值不含：正好 200k 仍走低档
		expect(low.prices.input).toBe(2);
		const hi = pickTier(hit.prices, hit.tiers, 200_001);
		expect([hi.prices.input, hi.prices.output]).toEqual([4, 12]);
		// input_tokens=250000 的 fixture：必须按 4/12 计费，不混档
		const row = must(
			computeRowCost(hit, { input: 250_000, cacheRead: 0, cacheWrite: 0, output: 1_000, reasoning: 0, total: 251_000 }),
			"grok 行金额",
		);
		expect(row.amount).toBeCloseTo(1.012, 10);
		expect(row.tierSize).toBe(200_000);
	});

	it("三源全失败：旧快照保留、金额不变 0、日志不刷、并发只起一次刷新", async () => {
		const good = {
			v: 1,
			fetchedAt: Date.now() - 1_000,
			ttlMs: 10_000,
			entries: normalizeModelsDev(TRI_MD),
			models: [TRI_MODEL],
			sources: [],
		};
		const store = new Map<string, unknown>([[PRICE_STORAGE_KEY, good]]);
		const logs: string[] = [];
		const down = async () => {
			throw new Error("proxy down");
		};
		const book = createPriceBook({
			storage: {
				get: (k: string, d: unknown) => store.get(k) ?? d,
				set: (k: string, v: unknown) => void store.set(k, v),
			},
			fetchImpl: down,
			log: (lvl: string, msg: unknown) => void logs.push(`${lvl} ${String(msg)}`),
			ttlMs: 10_000,
		});
		book.load();
		expect(matchPrice(book.getIndex(), { model: TRI_MODEL, provider: "google" }), "load 后应命中旧快照").toBeTruthy();
		const st = await book.refresh({ models: [TRI_MODEL] });
		expect(st.available, "失败后旧快照仍可用").toBe(true);
		expect(st.entryCount).toBe(good.entries.length);
		expect(String(st.lastError)).toBeTruthy();
		expect(st.refreshFailedAt).toBeTruthy();
		// 金额不能因断网变 0：(1000×2 + 1000×6)/1e6 = 0.008
		const hit = must(matchPrice(book.getIndex(), { model: TRI_MODEL, provider: "google" }), "失败后仍可计价");
		const cost = must(
			computeRowCost(hit, { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 1_000, reasoning: 0, total: 2_000 }),
		);
		expect(cost.amount).toBeCloseTo(0.008, 12);
		expect(logs.length, `日志必须只 1 条，实为 ${logs.length}：${logs.join(" | ")}`).toBe(1);
		// 首屏不卡：ensureFresh 不 await 也必须 single-flight，20 次只起 1 次抓取
		let started = 0;
		const logs2: string[] = [];
		const book2 = createPriceBook({
			storage: {
				get: (k: string, d: unknown) => store.get(k) ?? d,
				set: (k: string, v: unknown) => void store.set(k, v),
			},
			fetchImpl: async () => {
				started += 1;
				throw new Error("proxy down");
			},
			log: (lvl: string, msg: unknown) => void logs2.push(`${lvl} ${String(msg)}`),
			ttlMs: 0, // 永远过期，驱动反复刷新
		});
		book2.load();
		for (let i = 0; i < 20; i++) {
			const fresh = book2.ensureFresh({ models: [TRI_MODEL] }) as { status: { available?: boolean } };
			expect(fresh.status.available).toBe(true);
		}
		expect(started, "刷新必须 single-flight").toBe(1);
		await new Promise((r) => setTimeout(r, 20));
		expect(logs2.length, "失败日志不得刷屏").toBeLessThanOrEqual(1);
	});

	it("代理坏但不返回（挂起）：首屏不被网络阻塞，无快照时金额 null 而非 0", async () => {
		const hang = (): Promise<Response> => new Promise(() => {});
		const logs: string[] = [];
		const book = createPriceBook({
			storage: { get: (_k: string, d: unknown) => d, set: () => {} },
			fetchImpl: hang as unknown as (u: string) => Promise<Response>,
			log: (lvl: string, msg: unknown) => void logs.push(`${lvl} ${String(msg)}`),
			ttlMs: 0,
		});
		book.load(); // 无快照可用
		const file = makeDb(
			tempDir(),
			[{ tsMs: Date.now(), model: "m-x", provider: "google", input: 1_000, output: 100, total: 1_100 }],
			{ file: "usage.db" },
		);
		const svc = createStatsService({ getSettings: () => ({ dbPath: file, cacheTtlSec: 10 }), priceBook: book });
		const t0 = Date.now();
		const res = await svc.summary({ window: "today" });
		const ms = Date.now() - t0;
		svc.dispose();
		expect(res.ok).toBe(true);
		expect(ms, `首屏被网络抓取阻塞 ${ms}ms（ensureFresh 必须不阻塞查询）`).toBeLessThan(1_500);
		const cost = must(res.summary.cost, "cost 必须下发");
		expect(cost.amount).toBe(null); // 无价目：绝不把金额当 0
		expect(cost.amount !== 0).toBe(true);
		expect(cost.unknownCalls).toBe(1);
		expect(res.meta.price.available).toBe(false);
		expect(logs.length, "挂起不应刷错误日志").toBe(0);
	});
});

/** 计价函数对「无价 / 无桶」返回 null：断言前显式取出，实为 null 即测试失败。 */
function must<T>(v: T | null | undefined, what = "计价结果"): T {
	if (v === null || v === undefined) throw new Error(`期望${what}非空，实为 ${String(v)}`);
	return v;
}

describe("T3 写盘红线（全量源码 + 结构白名单）", () => {
	/** 剔注释与模板串：否则「继不执行 VACUUM」这类声明会被当成写入口。 */
	const strip = (s: string): string =>
		s
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/`[\s\S]*?`/g, "``");

	function pluginSources(): string[] {
		// 独立仓库：插件根 = 仓库根。只枚举交付目录，不跟 node_modules / tests。
		const out: string[] = [];
		for (const rel of ["index.mjs"]) {
			const p = resolveRepo(rel);
			if (existsSync(p)) out.push(p);
		}
		for (const dir of ["lib", "client", "scripts"]) {
			const root = resolveRepo(dir);
			if (!existsSync(root)) continue;
			const walk = (d: string): void => {
				for (const e of readdirSync(d, { withFileTypes: true })) {
					const p = join(d, e.name);
					if (e.isDirectory()) walk(p);
					else if (/\.m?js$/.test(e.name)) out.push(p);
				}
			};
			walk(root);
		}
		return out;
	}

	it("全量 .mjs（含 lib/prices.mjs，旧版闸门漏扫）零写盘 / 零写事务 / 零子进程", () => {
		const files = pluginSources();
		expect(files.length >= 4, `插件源码未找全：${files.join(", ")}`).toBe(true);
		const forbidden: Array<[RegExp, string]> = [
			[
				/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|openSync|writeSync|truncateSync|chmod|chown|mkdir|copyFile|symlink|link)\w*\s*\(/,
				"fs 写入类",
			],
			[/\b(renameSync|rename|unlinkSync|unlink|rmSync|rm|rimraf|rmdir)\s*\(/, "fs 改名/删除"],
			[/\b(VACUUM|REINDEX|ATTACH|DETACH)\b/i, "维护/挂载类 SQL"],
			[/\b(INSERT INTO|DELETE FROM|REPLACE INTO)\b|\bUPDATE\s+\w+\s+SET\b/i, "写事务 SQL"],
			[/\bCREATE\s+(TABLE|INDEX)\b|\b(DROP|ALTER)\s+TABLE\b/i, "DDL"],
			[/journal_mode\s*=\s*(wal|delete|truncate|persist|memory)/i, "修改 journal_mode"],
			[/\bBEGIN\s+(IMMEDIATE|EXCLUSIVE|DEFERRED)\b/i, "显式写事务"],
			[/\b(child_process|execSync|spawnSync|execFile)\b/, "起子进程"],
		];
		const hits: string[] = [];
		for (const p of files) {
			const src = strip(readFileSync(p, "utf8"));
			for (const [re, name] of forbidden) if (re.test(src)) hits.push(`${p}: ${name}`);
		}
		expect(hits, `发现写盘入口（E 盘绝对只读 + R3#3）：${hits.join(" / ")}`).toEqual([]);
	});

	it("node:fs 只能导入只读 API；开库必须 readOnly（结构性红线）", () => {
		const RO = /^(existsSync|readdirSync|statSync|lstatSync|readFileSync|realpathSync|opendirSync|globSync)$/;
		const hits: string[] = [];
		for (const p of pluginSources()) {
			const src = strip(readFileSync(p, "utf8"));
			for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:fs["']/g)) {
				for (const raw of m[1].split(",")) {
					const name = raw.trim().split(/\s+as\s+/)[0];
					if (name && !RO.test(name)) hits.push(`${p}: 越权导入 ${name}`);
				}
			}
			if (/new DatabaseSync\s*\(/.test(src) && !/readOnly\s*:\s*true/.test(src)) hits.push(`${p}: 开库未声明 readOnly`);
		}
		expect(hits, `越权文件操作：${hits.join(" / ")}`).toEqual([]);
	});

	it("价目 fixture 与任何上游原文都不得 >32KB 入库", () => {
		const dirs = [resolveRepo("tests/fixtures/cliproxy-prices")];
		const big: string[] = [];
		for (const d of dirs) {
			if (!existsSync(d)) continue;
			for (const e of readdirSync(d)) {
				const p = join(d, e);
				if (/\.(json|jsonl|csv)$/i.test(e) && byteSize(p) > 32 * 1024) big.push(`${p} (${byteSize(p)}B)`);
			}
		}
		expect(big, `价目 fixture 超限：${big.join(", ")}`).toEqual([]);
	});
});

function byteSize(p: string): number {
	try {
		return readFileSync(p).length;
	} catch {
		return 0;
	}
}
// ────────────────────────────────────────────────────────── R5 未知价与分段价

const PRICE_FIXTURE = {
	google: {
		models: {
			"gemini-3.8-flash": { cost: { input: 0.75, output: 3.75, cache_read: 0.075, cache_write: 0.6 } },
			"grok-4.7": {
				cost: {
					input: 2,
					output: 6,
					cache_read: 1,
					tiers: [{ input: 4, output: 12, cache_read: 1, tier: { type: "context", size: 200000 } }],
				},
			},
			"no-price-model": { cost: null },
		},
	},
	azure: { models: { "grok-4.7": { cost: null } } },
};

describe("R5 未知价一律 -- / 不进金额分子 / 分段价", () => {
	const index = buildPriceIndex(normalizeModelsDev(PRICE_FIXTURE));

	it("models.dev 的 cost:null 条目被丢弃，不产生 0 价", () => {
		const models = index.exact ? [...index.exact.keys()] : [];
		expect(models.some((k) => k.includes("no-price-model"))).toBe(false);
		expect(matchPrice(index, { model: "no-price-model", provider: "google" })).toBe(null);
		expect(matchPrice(index, { model: "mystery-9", provider: "antigravity" })).toBe(null);
	});

	it("effort 后缀剥离：gemini-3.8-flash-high → 基名；grok-4.7 的数字不得被剥", () => {
		expect(stripEffort("gemini-3.8-flash-high")).toBe("gemini-3.8-flash");
		expect(stripEffort("gemini-3.7-flash-high")).toBe("gemini-3.7-flash");
		expect(stripEffort("grok-4.7")).toBe("grok-4.7");
		expect(stripEffort("grok-4.6-non-reasoning")).toBe("grok-4.6");
		const hit = matchPrice(index, { model: "gemini-3.8-flash-high", provider: "antigravity" });
		expect(hit?.matchedModel).toBe("gemini-3.8-flash");
		expect(hit?.matchedProvider).toBe("google"); // antigravity → google 只作用于计价
		expect(hit?.prices).toMatchObject({ input: 0.75, output: 3.75, cacheRead: 0.075 });
	});

	it("tiers：context>200000 走 4/12 档，不到阈值走 2/6 档", () => {
		const g = matchPrice(index, { model: "grok-4.7", provider: "xai" });
		expect(JSON.stringify(pickTier(g.prices, g.tiers, 250_000).prices)).toContain('"input":4');
		expect(pickTier(g.prices, g.tiers, 100_000).prices.input).toBe(2);
		const big = must(
			computeRowCost(g, { input: 250_000, cacheRead: 0, cacheWrite: 0, output: 1000, reasoning: 0, total: 251_000 }),
		);
		// 手算：250000×4 + 1000×12 = 1_012_000 → /1e6 = 1.012
		expect(big.amount).toBeCloseTo(1.012, 10);
		expect(big.tierSize).toBe(200_000);
		const small = must(
			computeRowCost(g, { input: 100_000, cacheRead: 0, cacheWrite: 0, output: 1000, reasoning: 0, total: 101_000 }),
		);
		expect(small.amount).toBeCloseTo(0.206, 10);
	});

	it("cache_read 已含在 input 内：不双算（手算核对）", () => {
		const hit = matchPrice(index, { model: "gemini-3.8-flash-high", provider: "antigravity" });
		const c = must(
			computeRowCost(must(hit, "命中价"), {
				input: 10_000,
				cacheRead: 8_000,
				cacheWrite: 0,
				output: 500,
				reasoning: 0,
				total: 10_500,
			}),
			"行金额",
		);
		// 手算：(10000-8000)×0.75 + 8000×0.075 + 500×3.75 = 1500 + 600 + 1875 = 3975 → 0.003975
		expect(c.amount).toBeCloseTo(0.003975, 12);
	});

	it("输出侧口径按账本 total 形状判定，不再用 reasoning>output 启发式", () => {
		expect(billableOutput({ input: 100, output: 50, reasoning: 30, cacheRead: 0, total: 150 })).toEqual({
			tokens: 50,
			basis: "in+out",
		});
		expect(billableOutput({ input: 100, output: 50, reasoning: 30, cacheRead: 0, total: 180 })).toEqual({
			tokens: 80,
			basis: "in+out+reasoning",
		});
	});

	it("costOf：0 请求 → 占比 null；全未知价 → 金额 null；混合 → 金额只含有价行", () => {
		expect(costOf(null)).toBe(null);
		const empty = must(costOf({ amount: 0, pricedCalls: 0, unknownCalls: 0, unknownBasisCalls: 0 }), "空窗口桶");
		expect(empty.amount).toBe(null);
		expect(empty.unknownRate).toBe(null); // 不是 0
		const allUnknown = must(costOf({ amount: 0, pricedCalls: 0, unknownCalls: 7, unknownBasisCalls: 0 }), "全未知价桶");
		expect(allUnknown.amount).toBe(null); // 不用 0 冒充免费
		expect(allUnknown.unknownRate).toBe(1);
		const mixed = must(costOf({ amount: 0.5, pricedCalls: 2, unknownCalls: 1, unknownBasisCalls: 0 }), "混合桶");
		expect(mixed.unknownRate).toBeCloseTo(1 / 3, 10);
	});

	it("端到端：未知价行不进金额分子，逐维度也单独计数", () => {
		const dir = tempDir();
		const now = Date.now();
		const file = makeDb(
			dir,
			[
				{
					tsMs: now,
					model: "gemini-3.8-flash-high",
					provider: "antigravity",
					input: 10_000,
					cacheRead: 8_000,
					output: 500,
					total: 10_500,
				},
				{
					tsMs: now - 1,
					model: "gemini-3.8-flash-high",
					provider: "antigravity",
					input: 1_000,
					cacheRead: 0,
					output: 100,
					total: 1_100,
				},
				{
					tsMs: now - 2,
					model: "mystery-9",
					provider: "antigravity",
					input: 9_000,
					cacheRead: 0,
					output: 900,
					total: 9_900,
				},
			],
			{ file: "usage.db" },
		);
		const db = openDb(file);
		const buckets = aggregateCostBuckets(db, { window: { fromMs: 0 }, client: "all" }, index);
		const total = must(costOf(buckets.total), "total 桶");
		expect(total.pricedCalls).toBe(2);
		expect(total.unknownCalls).toBe(1);
		// 手算：0.003975 + (1000×0.75 + 100×3.75)/1e6 = 0.003975 + 0.001125
		expect(total.amount).toBeCloseTo(0.0051, 12);
		expect(total.unknownRate).toBeCloseTo(1 / 3, 10);
		// 逐维度：未知价必须单独可见，不能静默进总量
		expect(must(costOf(must(buckets.model.get("mystery-9"), "model 桶")), "mystery-9 金额").amount).toBe(null);
		expect(buckets.model.get("mystery-9").unknownCalls).toBe(1);
		expect(buckets.model.get("gemini-3.8-flash-high").unknownCalls).toBe(0);
		expect(buckets.provider.get("antigravity").unknownCalls).toBe(1);
		// 全未知价库：金额为 null 且占比 1
		const dir2 = tempDir();
		const f2 = makeDb(
			dir2,
			[{ tsMs: now, model: "zzz-1", provider: "antigravity", input: 10, output: 10, total: 20 }],
			{
				file: "usage.db",
			},
		);
		const t2 = must(
			costOf(
				must(
					aggregateCostBuckets(openDb(f2), { window: { fromMs: 0 }, client: "all" }, index).total,
					"全未知价库 total 桶",
				),
			),
			"全未知价金额",
		);
		expect(t2.amount).toBe(null);
		expect(t2.unknownRate).toBe(1);
		// groupBy 维度可用（R2 三）
		const groups = aggregateGroups(openDb(file), { window: { fromMs: 0 }, client: "all", groupBy: "endpoint" });
		expect(groups.length >= 1).toBe(true);
		// 客户端（client/entry.mjs:549）读的是 g.key：字段改名必须两端同步
		expect(groups[0]).toHaveProperty("key");
		expect(groups[0]).toHaveProperty("calls");
	});

	// ── F-10 复核：未知价占比（unknownCalls / unknownRatio / totalCalls）
	it("F-10① 一半有价一半无价 → 金额恰等于有价部分（未知价绝不进分子）", () => {
		const now = Date.now();
		const priced = [0, 1, 2, 3].map((i) => ({
			tsMs: now - i,
			model: "gemini-3.8-flash",
			provider: "google",
			input: 10_000,
			output: 1_000,
			total: 11_000,
		}));
		const unknown = [0, 1, 2, 3, 4].map((i) => ({
			tsMs: now - 10 - i,
			model: `mystery-${i}`,
			provider: "antigravity",
			input: 500_000,
			output: 500_000,
			total: 1_000_000,
		}));
		const file = makeDb(tempDir(), [...priced, ...unknown], { file: "usage.db" });
		const total = must(
			costOf(aggregateCostBuckets(openDb(file), { window: { fromMs: 0 }, client: "all" }, index).total),
			"F-10 混合库 total 桶",
		);
		// 手算：单条有价 = (10000×0.75 + 1000×3.75)/1e6 = 0.01125；四条 = 0.045（未知价那 5M token 一分不计）
		expect(total.amount).toBeCloseTo(0.045, 12);
		expect(total.pricedCalls).toBe(4);
		expect(total.unknownCalls).toBe(5);
		expect(total.totalCalls).toBe(9);
		expect(total.unknownRatio).toBeCloseTo(5 / 9, 12);
		// 只留一条有价：金额必须线性变化（证明逐行累加，不是按均值估算）
		const one = makeDb(tempDir(), [priced[0], unknown[0]], { file: "usage.db" });
		const c1 = must(
			costOf(aggregateCostBuckets(openDb(one), { window: { fromMs: 0 }, client: "all" }, index).total),
			"单条有价桶",
		);
		expect(c1.amount).toBeCloseTo(0.01125, 12);
	});

	it("F-10② 窗口 0 请求 → unknownRatio 为 null（不是 0）", () => {
		const file = makeDb(
			tempDir(),
			[{ tsMs: Date.now() - 7_200_000, model: "gemini-3.8-flash", input: 10, total: 10 }],
			{
				file: "usage.db",
			},
		);
		const buckets = aggregateCostBuckets(
			openDb(file),
			{ window: { fromMs: Date.now() + 3_600_000 }, client: "all" },
			index,
		);
		const c = must(costOf(buckets.total), "空窗口桶");
		expect(c.amount).toBe(null);
		expect(c.unknownRatio).toBe(null);
		expect(c.unknownRatio !== 0).toBe(true);
		expect(c.totalCalls).toBe(0);
	});

	it("F-10③ 全部未知价 → 金额 null 且显式 !== 0，占比 1", () => {
		const now = Date.now();
		const file = makeDb(
			tempDir(),
			[0, 1, 2].map((i) => ({
				tsMs: now - i,
				model: `zzz-${i}`,
				provider: "xai",
				input: 100_000,
				output: 10_000,
				total: 110_000,
			})),
			{ file: "usage.db" },
		);
		const c = must(
			costOf(aggregateCostBuckets(openDb(file), { window: { fromMs: 0 }, client: "all" }, index).total),
			"全未知价桶",
		);
		expect(c.amount).toBe(null);
		expect(c.amount !== 0).toBe(true); // 严禁用 0 冒充「免费」
		expect(c.pricedCalls).toBe(0);
		expect(c.unknownCalls).toBe(3);
		expect(c.unknownRatio).toBe(1);
	});

	it("F-10④ 占比分母以 totalCalls 为准，不取采样数", () => {
		const c = must(costOf({ amount: 1, pricedCalls: 2, unknownCalls: 1, unknownBasisCalls: 0 }, 10), "显式分母");
		expect(c.totalCalls).toBe(10);
		expect(c.unknownRatio).toBeCloseTo(0.1, 12);
		expect(c.unknownRate).toBe(c.unknownRatio); // 旧字段名必须同值
		// 声明值小于采样数（采样与计数不同源）时分母不得改小，否则占比假高
		const d = must(costOf({ amount: 1, pricedCalls: 8, unknownCalls: 2, unknownBasisCalls: 0 }, 1), "分母下限");
		expect(d.totalCalls).toBe(10);
		expect(d.unknownRatio).toBeCloseTo(0.2, 12);
	});

	it("F-10⑤ 服务层下发 unknownRatio/totalCalls，逐组金额独立", async () => {
		const now = Date.now();
		const file = makeDb(
			tempDir(),
			[
				{ tsMs: now, model: "gemini-3.8-flash", provider: "google", input: 10_000, output: 1_000, total: 11_000 },
				{ tsMs: now - 1, model: "mystery-1", provider: "antigravity", input: 9_000, output: 900, total: 9_900 },
			],
			{ file: "usage.db" },
		);
		const priceBook = {
			getIndex: () => index,
			status: () => ({ ok: true, fetchedAt: 0 }),
			ensureFresh: () => {},
			load: () => {},
		};
		const svc = createStatsService({ getSettings: () => ({ dbPath: file, cacheTtlSec: 10 }), priceBook });
		const res = await svc.summary({ window: "today" });
		svc.dispose();
		expect(res.ok).toBe(true);
		const s = res.summary;
		expect(s.calls).toBe(2);
		const cost = must(s.cost, "服务层 cost");
		expect(cost.amount).toBeCloseTo(0.01125, 12);
		expect(cost.unknownCalls).toBe(1);
		expect(cost.totalCalls).toBe(2);
		expect(cost.unknownRatio).toBeCloseTo(0.5, 12);
		expect(res.meta.price?.ok).toBe(true); // 价目表状态跟元信息一起下发
		const g = must(
			res.groups.find((x: { key: string }) => x.key === "mystery-1"),
			"未知价分组",
		);
		expect(must(g.cost, "未知价分组金额").amount).toBe(null);
		expect(g.cost.unknownRatio).toBe(1);
	});
});

function compareSemver(a: string | number, b: string | number): number {
	const pa = String(a)
		.split(".")
		.map((n) => Number(n) || 0);
	const pb = String(b)
		.split(".")
		.map((n) => Number(n) || 0);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	}
	return 0;
}

// ────────────────────────────────────────────────────────── 辅助

function resolveRepo(rel: string): string {
	return resolvePath(repoRoot, rel);
}

function readRepo(rel: string): string {
	return readFileSync(resolveRepo(rel), "utf8");
}

function readManifest(): {
	id: string;
	name: string;
	nameEn: string;
	version: string;
	apiVersion: number;
	icon: string;
	permissions: string[];
	netAllowlist?: string[];
	preload: boolean;
	view: boolean;
	ui: Record<string, Array<{ id: string; order?: number; align?: string; kind?: string }>>;
} {
	return JSON.parse(readRepo("manifest.json"));
}

function allManifests(): Array<{ id: string; items: Array<{ slot: string; align?: string; order?: number }> }> {
	// 独立仓库只有一份 manifest（仓库根）。跨插件冲突面在 registry 仓库校。
	const m = JSON.parse(readFileSync(resolveRepo("manifest.json"), "utf8")) as {
		id?: string;
		ui?: Record<string, unknown> | Array<{ slot?: string }>;
	};
	const items: Array<{ slot: string; align?: string; order?: number }> = [];
	const ui = m.ui ?? {};
	const push = (slot: string, list: unknown) => {
		if (!Array.isArray(list)) return;
		for (const it of list) {
			if (it && typeof it === "object")
				items.push({ slot, align: (it as { align?: string }).align, order: (it as { order?: number }).order });
		}
	};
	if (Array.isArray(ui)) for (const it of ui) push(String((it as { slot?: string }).slot ?? ""), [it]);
	else for (const [slot, list] of Object.entries(ui)) push(slot, list);
	return [{ id: m.id ?? "usage-ledger", items }];
}
