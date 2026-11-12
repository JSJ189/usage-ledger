/**
 * v3 v2→v3 迁移层（`lib/v3/migrate.mjs`）：slug 解析、entryKey 相对路径归一化与幂等流式迁移。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { legacyRecordToRow, migrateLegacyV2, projectFromLegacyDir } from "../../lib/v3/migrate.mjs";
import { openStore } from "../../lib/v3/store.mjs";
import { T0 } from "./support/rows";

const dirs: string[] = [];

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ul-v3-migrate-"));
	dirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of dirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 临时目录清理失败不影响断言 */
		}
	}
});

describe("migrate：legacyRecordToRow 口径", () => {
	const slug = "--C--Users-11373-Desktop-JK项目-知识库--";
	const sessionsRoot = "C:\\Users\\11373\\.pi\\agent\\sessions";
	const sessionFile = `${sessionsRoot}\\${slug}\\2026-10-12T03-00-00-000Z_abc.jsonl`;

	it("slug --C--Users-11373-Desktop-JK项目-知识库-- → project 为 JK项目/知识库", () => {
		expect(projectFromLegacyDir(slug)).toBe("JK项目/知识库");
		expect(projectFromLegacyDir(slug, "C:/Users/11373")).toBe("JK项目/知识库");

		const row = legacyRecordToRow(
			{
				ts: T0,
				projectDir: slug,
				sessionFile,
				entryId: "a1",
				model: "grok-4.7",
				provider: "cliproxyapi",
				status: "ok",
				source: "backfill",
				inputTokens: 100,
				outputTokens: 50,
				costUsd: 0.01,
				durationMs: 2000,
			},
			{ sessionsRoot },
		);

		expect(row).not.toBeNull();
		expect(row!.project).toBe("JK项目/知识库");
		expect(row!.entryKey).toBe(`e:${slug}/2026-10-12T03-00-00-000Z_abc.jsonl:a1`);
		expect(row!.entryKey).not.toContain("C:");
		expect(row!.entryKey).not.toContain("\\");
		expect(row!.costSdk).toBe(0.01);
		expect(row!.costSource).toBe("sdk");
	});

	it("costUsd=0 时不作为 SDK 真值，留空 costSource 等价格表估算", () => {
		const row = legacyRecordToRow(
			{
				ts: T0,
				projectDir: slug,
				sessionFile,
				entryId: "a2",
				model: "m1",
				status: "ok",
				costUsd: 0,
				ttftMs: 500,
				durationMs: 2500,
			},
			{ sessionsRoot },
		);
		expect(row).not.toBeNull();
		expect(row!.costSdk).toBe(0);
		expect(row!.costSource).toBeNull();
		expect(row!.genMs).toBe(2000);
		expect(row!.e2eMs).toBe(2500);
	});
});

describe("migrate：migrateLegacyV2 流式迁移与幂等", () => {
	it("流式读取临时 ledger.jsonl 写入 SQLite 并标记 migrated_at，重跑不翻倍", async () => {
		const dir = tmpDir();
		const legacyPath = join(dir, "legacy-ledger.jsonl");
		const sessionsRoot = "C:/mock/sessions";
		const lines = [
			JSON.stringify({
				ts: T0,
				conversationId: "c1",
				sessionFile: `${sessionsRoot}/--C--Users-11373-Desktop-JK项目-知识库--/s1.jsonl`,
				entryId: "m1",
				projectDir: "--C--Users-11373-Desktop-JK项目-知识库--",
				model: "grok-4.7",
				provider: "cliproxyapi",
				status: "ok",
				source: "backfill",
				inputTokens: 120,
				outputTokens: 30,
				totalTokens: 150,
				costUsd: 0.005,
				durationMs: 1200,
			}),
			JSON.stringify({
				ts: T0 + 1000,
				conversationId: "c1",
				sessionFile: `${sessionsRoot}/--C--Users-11373-Desktop-JK项目-知识库--/s1.jsonl`,
				entryId: "m2",
				projectDir: "--C--Users-11373-Desktop-JK项目-知识库--",
				model: "grok-4.7",
				provider: "cliproxyapi",
				status: "ok",
				source: "backfill",
				inputTokens: 80,
				outputTokens: 20,
				totalTokens: 100,
				costUsd: 0,
				durationMs: 800,
			}),
			"{bad-json-line",
		];
		writeFileSync(legacyPath, `${lines.join("\n")}\n`, "utf8");

		const store = openStore({ dir });
		try {
			const first = await migrateLegacyV2({ store, legacyPath, sessionsRoot });
			expect(first.ok).toBe(true);
			expect(first.rows).toBe(2);
			expect(first.bad).toBe(1);
			expect(store.stats().calls).toBe(2);
			expect(store.metaGet("migrated_at")).toBeTruthy();

			const page = store.queryRecords({ fromMs: T0 - 10_000, toMs: T0 + 10_000, limit: 10 });
			expect(page.total).toBe(2);
			expect(page.items.every((item) => item.project === "JK项目/知识库")).toBe(true);
			expect(page.items.map((item) => item.entryKey).sort()).toEqual([
				"e:--C--Users-11373-Desktop-JK项目-知识库--/s1.jsonl:m1",
				"e:--C--Users-11373-Desktop-JK项目-知识库--/s1.jsonl:m2",
			]);

			// 幂等重跑：行数不变
			const second = await migrateLegacyV2({ store, legacyPath, sessionsRoot });
			expect(second.ok).toBe(true);
			expect(second.rows).toBe(0);
			expect(second.skipped).toBe(2);
			expect(store.stats().calls).toBe(2);
		} finally {
			store.close();
		}
	});
});
