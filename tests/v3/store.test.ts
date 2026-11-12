/**
 * v3 存储层（`lib/v3/store.mjs`，`node:sqlite`）：幂等、分页、只读三条硬约束。
 *
 * 全部在系统临时目录里跑（`mkdtempSync`），跑完 `rmSync` 清理；
 * **绝不碰 `~/.pi-web/`**（真实账本只读，不参与测试）。
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openStore } from "../../lib/v3/store.mjs";
import { DB_FILENAME } from "../../lib/v3/paths.mjs";
import { dayKeyOf, hourStart } from "../../lib/v3/metrics.mjs";
import { HOUR, T0, detailRow, rollupRow } from "./support/rows";

const dirs: string[] = [];

/** 新建一个临时状态目录（用例结束统一删）。 */
function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ul-v3-store-"));
	dirs.push(dir);
	return dir;
}

/** 120 条明细（按 ts 倒序错开，跨 2 个小时桶、1 个天桶）。 */
function seedRows() {
	return Array.from({ length: 120 }, (_, i) => detailRow({ id: i, ts: T0 - i * 1000 }));
}

afterAll(() => {
	for (const dir of dirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 临时目录删不掉不影响结论 */
		}
	}
});

describe("store：entryKey 幂等", () => {
	it("同一批 120 行写两次：行数不变、第二次全 skipped、rollup 也不翻倍", () => {
		const store = openStore({ dir: tmpDir() });
		try {
			const rows = seedRows();
			const first = store.insertBatch(rows);
			expect(first.inserted).toBe(120);
			expect(first.updated).toBe(0);
			expect(first.skipped).toBe(0);
			expect(store.stats().calls).toBe(120);

			const again = store.insertBatch(rows);
			expect(again.inserted).toBe(0);
			expect(again.skipped).toBe(120);
			expect(again.delta.length).toBe(0); // 没有新行就没有 rollup 增量
			expect(store.stats().calls).toBe(120);

			const hourRows = store.rollupRows({ fromMs: T0 - 24 * HOUR, toMs: T0, gran: "hour" });
			expect(hourRows.length).toBe(2);
			expect(hourRows.reduce((sum, row) => sum + row.calls, 0)).toBe(120);
			expect(hourRows.reduce((sum, row) => sum + row.outTok, 0)).toBe(120 * 50);
		} finally {
			store.close();
		}
	});

	it("同 entryKey 改内容 → updated=1、行数不变、rollup 换成新值（不是相加）", () => {
		const store = openStore({ dir: tmpDir() });
		try {
			const rows = seedRows();
			store.insertBatch(rows);
			const changed = { ...rows[0], outTok: 80, totalTok: 190 };
			const result = store.insertBatch([changed]);
			expect(result.updated).toBe(1);
			expect(result.inserted).toBe(0);
			expect(store.stats().calls).toBe(120);

			const hourRows = store.rollupRows({ fromMs: T0 - 24 * HOUR, toMs: T0, gran: "hour" });
			expect(hourRows.reduce((sum, row) => sum + row.calls, 0)).toBe(120);
			// 只有那一行从 50 变 80；若 rollup 只是相加，这里会是 120*50+80
			expect(hourRows.reduce((sum, row) => sum + row.outTok, 0)).toBe(119 * 50 + 80);
		} finally {
			store.close();
		}
	});

	it("天桶与小时桶的 calls 一致（两级 rollup 同源）", () => {
		const store = openStore({ dir: tmpDir() });
		try {
			store.insertBatch(seedRows());
			const dayRows = store.rollupRows({ fromMs: T0 - 24 * HOUR, toMs: T0, gran: "day" });
			expect(dayRows.length).toBe(1);
			expect(dayRows[0].bucket).toBe(dayKeyOf(T0));
			expect(dayRows[0].calls).toBe(120);
		} finally {
			store.close();
		}
	});
});

describe("store：keyset 分页全遍历", () => {
	it("limit=50 翻 3 页拿到 120 条不重不漏，total 与实际条数一致", () => {
		const store = openStore({ dir: tmpDir() });
		try {
			store.insertBatch(seedRows());
			const ids: number[] = [];
			const tsSeen: number[] = [];
			let cursor: string | null = null;
			let pages = 0;
			for (;;) {
				const page = store.queryRecords({ fromMs: T0 - 24 * HOUR, toMs: T0, cursor, limit: 50 });
				pages += 1;
				for (const item of page.items) {
					ids.push(item.id);
					tsSeen.push(item.ts);
				}
				if (!page.nextCursor) {
					expect(page.total).toBe(120);
					break;
				}
				cursor = page.nextCursor;
				expect(pages).toBeLessThan(10); // 出现死循环就立刻失败，不要跑到超时
			}
			expect(pages).toBe(3);
			expect(ids.length).toBe(120);
			expect(new Set(ids).size).toBe(120);
			// ts DESC 严格递减（同 ts 才由 id 兜底，这里 ts 全部不同）
			for (let i = 1; i < tsSeen.length; i++) expect(tsSeen[i]).toBeLessThan(tsSeen[i - 1]);
		} finally {
			store.close();
		}
	});

	it("筛选生效：按 status 过滤只返回命中的行", () => {
		const store = openStore({ dir: tmpDir() });
		try {
			const rows = seedRows().map((row, i) => (i % 4 === 0 ? { ...row, status: "provider_error" } : row));
			store.insertBatch(rows);
			const failed = store.queryRecords({
				fromMs: T0 - 24 * HOUR,
				toMs: T0,
				filters: { statuses: ["provider_error"] },
				limit: 200,
			});
			expect(failed.total).toBe(30);
			expect(failed.items.every((item) => item.status === "provider_error")).toBe(true);
		} finally {
			store.close();
		}
	});

	it("按 model 名过滤能滤掉其它模型", () => {
		const store = openStore({ dir: tmpDir() });
		try {
			const rows = [
				detailRow({ id: 1, ts: T0, model: "model-alpha" }),
				detailRow({ id: 2, ts: T0 - 1000, model: "model-beta" }),
				detailRow({ id: 3, ts: T0 - 2000, model: "model-alpha" }),
				detailRow({ id: 4, ts: T0 - 3000, model: "model-gamma" }),
			];
			store.insertBatch(rows);

			const onlyAlpha = store.queryRecords({
				fromMs: T0 - HOUR,
				toMs: T0 + 1000,
				filters: { models: ["model-alpha"] },
				limit: 50,
			});
			expect(onlyAlpha.ok).toBe(true);
			expect(onlyAlpha.total).toBe(2);
			expect(onlyAlpha.items.length).toBe(2);
			expect(onlyAlpha.items.every((item) => item.model === "model-alpha")).toBe(true);
			expect(onlyAlpha.items.some((item) => item.model === "model-beta" || item.model === "model-gamma")).toBe(false);
		} finally {
			store.close();
		}
	});

	it("queryRecords 带 q 且窗口 calls > 20000 时返回 code too-broad", () => {
		const store = openStore({ dir: tmpDir() });
		try {
			store.insertBatch([
				detailRow({ id: 1, ts: T0, model: "m-target" }),
				detailRow({ id: 2, ts: T0 - 1000, model: "m-other" }),
			]);
			// 在更早的小时桶写入 20,000 条 rollup，使合并窗口超过 20,000 上限
			const oldBucket = hourStart(T0 - 5 * HOUR);
			store.upsertRollupRows("hour", [rollupRow({ bucket: oldBucket, calls: 20_000 })]);

			// 仅 T0 所在小时（calls = 2 ≤ 20,000）允许带 q 搜索
			const narrow = store.queryRecords({
				fromMs: hourStart(T0),
				toMs: T0 + 1000,
				q: "target",
				limit: 50,
			});
			expect(narrow.ok).toBe(true);
			expect(narrow.total).toBe(1);
			expect(narrow.items.map((item) => item.model)).toEqual(["m-target"]);

			// 宽窗口（calls = 20,002 > 20,000）带 q 拒绝全表 LIKE
			const broad = store.queryRecords({
				fromMs: oldBucket,
				toMs: T0 + 1000,
				q: "target",
				limit: 50,
			});
			expect(broad.ok).toBe(false);
			expect(broad.code).toBe("too-broad");
			expect(broad.total).toBe(20_002);
			expect(broad.items).toEqual([]);
		} finally {
			store.close();
		}
	});
});

describe("store：只读连接不写盘", () => {
	it("readOnly 能读，写操作直接抛错，主库文件与条数都不变", () => {
		const dir = tmpDir();
		const dbPath = join(dir, DB_FILENAME);
		const writer = openStore({ dir });
		writer.insertBatch(seedRows());
		writer.close();

		expect(existsSync(dbPath)).toBe(true);
		const before = statSync(dbPath);

		const reader = openStore({ dir, readOnly: true });
		try {
			expect(reader.readOnly).toBe(true);
			expect(reader.stats().calls).toBe(120);
			expect(reader.queryRecords({ fromMs: T0 - 24 * HOUR, toMs: T0, limit: 5 }).items.length).toBe(5);
			expect(reader.rollupRows({ fromMs: T0 - 24 * HOUR, toMs: T0, gran: "hour" }).length).toBe(2);

			expect(() => reader.insertBatch([detailRow({ id: 999, ts: T0 })])).toThrow(/只读连接/);
			expect(() => reader.metaSet("x", "1")).toThrow(/只读连接/);
			expect(() => reader.upsertRollupRows("hour", [])).toThrow(/只读连接/);
			expect(() => reader.deleteRollupDay("2026-11-12")).toThrow(/只读连接/);
			expect(reader.stats().calls).toBe(120);
		} finally {
			reader.close();
		}

		const after = statSync(dbPath);
		expect(after.size).toBe(before.size);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});
});
