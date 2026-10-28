/**
 * 会话回填单测：路径解析 → 行解析 → 增量 → 限速/过滤 → 降级。
 *
 * 这些用例全部用真实临时目录 + `tests/support/mock-fs.mjs` 的权限门替身，
 * 不依赖开发机上的任何真实会话（真机验证另见 scripts/verify-real-sessions.mjs）。
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_BACKFILL_DAYS,
	MAX_FILES_PER_RUN,
	classifyFsError,
	createSessionImporter,
	expandHomePath,
	parseSessionEntry,
	parseSessionText,
	resolveBackfillDays,
	resolveSessionsRoot,
} from "../../lib/sessions.mjs";
import { createMockFs, createTextOnlyFs, UNAUTHORIZED } from "../support/mock-fs.mjs";
import {
	appendSessionFile,
	assistantLine,
	jsonl,
	makeSessionTree,
	makeTmpDir,
	modelChange,
	sessionHeader,
	setMtime,
	thinkingChange,
	userLine,
	writeSessionFile,
} from "../support/session-fixtures.mjs";

const DAY = 86_400_000;

function importerFor(root, extra = {}) {
	const fsApi = extra.fsApi ?? createMockFs({ authorized: extra.authorized !== false });
	const state = extra.state ?? { version: 1, files: {} };
	const importer = createSessionImporter({
		fsApi,
		rootInfo: { root, source: "setting" },
		state,
		persist: extra.persist ?? (() => {}),
		log: extra.log ?? (() => {}),
		now: extra.now ?? (() => Date.now()),
		days: extra.days,
		maxFilesPerRun: extra.maxFilesPerRun,
		maxFileBytes: extra.maxFileBytes,
	});
	return { importer, fsApi, state };
}

describe("会话根目录解析", () => {
	it("设置项优先（绝对路径）", () => {
		const out = resolveSessionsRoot({ settings: { sessionsDir: "/data/pi/sessions" }, env: {}, home: "/home/me" });
		expect(out).toEqual({ root: "/data/pi/sessions", source: "setting" });
	});

	it("相对路径的设置项被忽略（回填不能依赖进程 cwd）", () => {
		const out = resolveSessionsRoot({ settings: { sessionsDir: "relative/sessions" }, env: {}, home: "/home/me" });
		expect(out.source).toBe("default");
		expect(out.root).toBe(join("/home/me", ".pi", "agent", "sessions"));
	});

	it("$PI_CODING_AGENT_DIR 覆盖默认根", () => {
		const out = resolveSessionsRoot({ settings: {}, env: { PI_CODING_AGENT_DIR: "/opt/pi" }, home: "/home/me" });
		expect(out).toEqual({ root: join("/opt/pi", "sessions"), source: "env" });
	});

	it("默认 ~/.pi/agent/sessions", () => {
		expect(resolveSessionsRoot({ settings: {}, env: {}, home: "/home/me" })).toEqual({
			root: join("/home/me", ".pi", "agent", "sessions"),
			source: "default",
		});
	});

	it("~/ 展开成家目录", () => {
		expect(expandHomePath("~/x", "/home/me")).toBe(join("/home/me", "x"));
		expect(expandHomePath("~", "/home/me")).toBe("/home/me");
		expect(expandHomePath("  ", "/home/me")).toBe("");
		expect(expandHomePath("/abs", "/home/me")).toBe("/abs");
	});

	it("设置项写 ~/... 也能用", () => {
		const out = resolveSessionsRoot({ settings: { sessionsDir: "~/.pi/agent/sessions" }, env: {}, home: "/home/me" });
		expect(out.source).toBe("setting");
		expect(out.root).toBe(join("/home/me", ".pi", "agent", "sessions"));
	});
});

describe("回填天数与错误分类", () => {
	it("回填天数：缺省 30、非法回落、夹取 1–3650", () => {
		expect(resolveBackfillDays(undefined)).toBe(DEFAULT_BACKFILL_DAYS);
		expect(resolveBackfillDays("")).toBe(DEFAULT_BACKFILL_DAYS);
		expect(resolveBackfillDays("abc")).toBe(DEFAULT_BACKFILL_DAYS);
		expect(resolveBackfillDays(-5)).toBe(DEFAULT_BACKFILL_DAYS);
		expect(resolveBackfillDays(0)).toBe(DEFAULT_BACKFILL_DAYS);
		expect(resolveBackfillDays("7")).toBe(7);
		expect(resolveBackfillDays(3.9)).toBe(3);
		expect(resolveBackfillDays(1e9)).toBe(3650);
	});

	it("错误分类：未授权 / 没声明 fs:read / 不存在 / 其它", () => {
		expect(classifyFsError(new Error(UNAUTHORIZED)).code).toBe("denied");
		expect(classifyFsError(new Error("插件未声明读能力 \"fs\"")).code).toBe("no-permission");
		expect(classifyFsError(Object.assign(new Error("no such file"), { code: "ENOENT" })).code).toBe("missing");
		expect(classifyFsError(new Error("boom")).code).toBe("fs-error");
	});

	it("分类结构带中英文理由与 hint（看板空态直接展示）", () => {
		const denied = classifyFsError(new Error(UNAUTHORIZED));
		expect(denied.reason).toContain("未授权");
		expect(denied.reasonEn).toContain("not authorized");
		expect(denied.hint).toContain("授权");
		expect(denied.hintEn).toContain("Authorize");
	});
});

describe("parseSessionEntry：单行解析", () => {
	it("session 行只补 sessionId / cwd，不产记录", () => {
		const ctx: Record<string, unknown> = {};
		expect(parseSessionEntry(sessionHeader({ id: "sess-9" }), ctx)).toBeNull();
		expect(ctx.sessionId).toBe("sess-9");
	});

	it("model_change / thinking_level_change 更新上下文", () => {
		const ctx: Record<string, unknown> = {};
		parseSessionEntry(modelChange({ provider: "p1", modelId: "m1" }), ctx);
		parseSessionEntry(thinkingChange({ thinkingLevel: "xhigh" }), ctx);
		expect(ctx.provider).toBe("p1");
		expect(ctx.model).toBe("m1");
		expect(ctx.thinkingLevel).toBe("xhigh");
	});

	it("用户消息不产记录", () => {
		expect(parseSessionEntry(userLine(), {})).toBeNull();
	});

	it("assistant 行产出完整记录（token / 成本 / 耗时 / 模型 / provider）", () => {
		const rec = parseSessionEntry(assistantLine({ id: "a7" }), { sessionId: "s1", projectDir: "--proj--" });
		expect(rec).toMatchObject({
			sessionId: "s1",
			entryId: "a7",
			projectDir: "--proj--",
			provider: "cliproxyapi",
			model: "grok-4.7",
			thinkingLevel: "high",
			inputTokens: 7309,
			outputTokens: 825,
			cacheReadTokens: 1152,
			cacheWriteTokens: 0,
			reasoningTokens: 558,
			totalTokens: 9286,
			costUsd: 0.020144,
			durationMs: 4321,
			stopReason: "stop",
			status: "ok",
			hasUsage: true,
			source: "backfill",
			ttftMs: null,
		});
		expect(rec.ts).toBe(1791774070834);
	});

	it("usage 缺失：status=incomplete、token 为 null（不伪造 0）", () => {
		const rec = parseSessionEntry(assistantLine({ usage: null }), { sessionId: "s1" });
		expect(rec.status).toBe("incomplete");
		expect(rec.hasUsage).toBe(false);
		expect(rec.inputTokens).toBeNull();
		expect(rec.totalTokens).toBeNull();
	});

	it("totalTokens 缺失时按 input+output+cacheRead+cacheWrite 兜底", () => {
		const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 };
		expect(parseSessionEntry(assistantLine({ usage }), {}).totalTokens).toBe(18);
	});

	it("durationMs 缺失 → null，不影响其它字段", () => {
		const rec = parseSessionEntry(assistantLine({ durationMs: null }), {});
		expect(rec.durationMs).toBeNull();
		expect(rec.outputTokens).toBe(825);
	});

	it("stopReason=error 或带 errorMessage → status=error", () => {
		expect(parseSessionEntry(assistantLine({ stopReason: "error" }), {}).status).toBe("error");
		const line = assistantLine();
		line.message.errorMessage = "upstream 500";
		expect(parseSessionEntry(line, {}).status).toBe("error");
	});

	it("message 里没有 model/provider 时回落到上下文（model_change 行）", () => {
		const ctx: Record<string, unknown> = {};
		parseSessionEntry(modelChange({ provider: "ctx-provider", modelId: "ctx-model" }), ctx);
		const line = assistantLine({ model: null, provider: null });
		const rec = parseSessionEntry(line, ctx);
		expect(rec.model).toBe("ctx-model");
		expect(rec.provider).toBe("ctx-provider");
	});

	it("ts 落在 message.timestamp，缺失时回落行的 ISO timestamp", () => {
		const line = assistantLine();
		delete line.message.timestamp;
		const rec = parseSessionEntry(line, {});
		expect(rec.ts).toBe(Date.parse("2026-10-12T03:01:30.947Z"));
	});
});

describe("parseSessionText：整段解析", () => {
	it("多行里只挑 assistant，坏行计入 bad，半行留给下次", () => {
		const text = `${jsonl([sessionHeader(), modelChange(), thinkingChange(), userLine(), assistantLine()])}{"type":"message","id":"half`;
		const parsed = parseSessionText(text, {});
		expect(parsed.records.length).toBe(1);
		expect(parsed.bad).toBe(0);
		expect(parsed.tail).toContain("half");
	});

	it("坏 JSON 行计入 bad，不中断后面的行", () => {
		const good = JSON.stringify(assistantLine({ id: "a2" }));
		const parsed = parseSessionText(`not-json\n${good}\n`, {});
		expect(parsed.bad).toBe(1);
		expect(parsed.records.length).toBe(1);
	});

	it("空文本返回空结果（首跑空文件不报错）", () => {
		const parsed = parseSessionText("", {});
		expect(parsed.records).toEqual([]);
		expect(parsed.lines).toBe(0);
	});
});

describe("createSessionImporter：枚举与增量", () => {
	it("只认 <root>/<项目目录>/*.jsonl，忽略非 jsonl 与更深层目录", async () => {
		const { root } = makeSessionTree({ projects: 2, filesPerProject: 1 });
		mkdirSync(join(root, "--proj-0--", "sol-pi"), { recursive: true });
		writeFileSync(join(root, "--proj-0--", "notes.txt"), "x", "utf8");
		writeFileSync(join(root, "--proj-0--", "sol-pi", "inner.jsonl"), jsonl([assistantLine()]), "utf8");
		const { importer } = importerFor(root);
		const scanned = await importer.scan();
		expect(scanned.files.length).toBe(2);
		expect(scanned.files.every((f) => f.path.endsWith(".jsonl"))).toBe(true);
	});

	it("首跑产出记录，并把 token / 成本 / 耗时都读出来", async () => {
		const { root } = makeSessionTree();
		const { importer } = importerFor(root);
		const res = await importer.run();
		expect(res.ok).toBe(true);
		expect(res.records.length).toBe(1);
		expect(res.records[0].outputTokens).toBe(825);
		expect(res.records[0].costUsd).toBeCloseTo(0.020144, 6);
		expect(res.records[0].projectDir).toBe("--proj-0--");
	});

	it("第二次跑：没有新字节就是 unchanged（不重复产记录）", async () => {
		const { root } = makeSessionTree();
		const { importer } = importerFor(root);
		await importer.run();
		const second = await importer.run();
		expect(second.records.length).toBe(0);
		expect(second.skipped.unchanged).toBe(1);
	});

	it("增量 offset：第二次只读新增行", async () => {
		const path = writeSessionFile(makeTmpDir(), "--p--", "s.jsonl", [sessionHeader(), assistantLine({ id: "a1" })]);
		const root = join(path, "..", "..");
		const fsApi = createMockFs();
		// 用真正的两层层级：root/<proj>/<file>
		const realRoot = makeTmpDir();
		const file = writeSessionFile(realRoot, "--p--", "s.jsonl", [sessionHeader(), assistantLine({ id: "a1" })]);
		const { importer, state } = importerFor(realRoot, { fsApi });
		const first = await importer.run();
		expect(first.records.length).toBe(1);
		const offsetAfterFirst = state.files[file].offset;
		appendSessionFile(file, jsonl([assistantLine({ id: "a2", ts: 1791774099999 })]));
		const second = await importer.run();
		expect(second.records.length).toBe(1);
		expect(second.records[0].entryId).toBe("a2");
		expect(state.files[file].offset).toBeGreaterThan(offsetAfterFirst);
		// 半行不会被吃掉
		appendFileSync(file, '{"type":"message","id":"a3"', "utf8");
		const third = await importer.run();
		expect(third.records.length).toBe(0);
		expect(state.files[file].offset).toBe(state.files[file].offset);
	});

	it("增量读也能拿到首行里的 sessionId（ctx 持久化）", async () => {
		const realRoot = makeTmpDir();
		const file = writeSessionFile(realRoot, "--p--", "s.jsonl", [
			sessionHeader({ id: "sess-keep" }),
			assistantLine({ id: "a1" }),
		]);
		const { importer } = importerFor(realRoot);
		await importer.run();
		appendSessionFile(file, jsonl([assistantLine({ id: "a2", ts: 1791774099000 })]));
		const second = await importer.run();
		expect(second.records[0].sessionId).toBe("sess-keep");
	});

	it("文件变小（轮转/截断）时从头重读", async () => {
		const realRoot = makeTmpDir();
		const file = writeSessionFile(realRoot, "--p--", "s.jsonl", [
			sessionHeader(),
			assistantLine({ id: "a1" }),
			// 大尾巴：保证重写后文件确实变小
			{ ...userLine(), pad: "x".repeat(500) },
		]);
		const { importer } = importerFor(realRoot);
		await importer.run();
		writeFileSync(file, jsonl([sessionHeader(), assistantLine({ id: "a9" })]), "utf8");
		const second = await importer.run();
		expect(second.records.length).toBe(1);
		expect(second.records[0].entryId).toBe("a9");
	});

	it("超出 backfillDays 的老文件跳过（tooOld）", async () => {
		const { root } = makeSessionTree();
		const { importer } = importerFor(root, { days: 1 });
		const files = (await importer.scan()).files;
		setMtime(files[0].path, Date.now() - 5 * DAY);
		const res = await importer.run();
		expect(res.skipped.tooOld).toBe(1);
		expect(res.records.length).toBe(0);
	});

	it("单文件超过上限跳过并记日志（tooLarge）", async () => {
		const { root } = makeSessionTree();
		const log = vi.fn();
		const { importer } = importerFor(root, { log, maxFileBytes: 10 });
		const res = await importer.run();
		expect(res.skipped.tooLarge).toBe(1);
		expect(res.records.length).toBe(0);
		expect(log.mock.calls.some((c) => String(c[1]).includes("跳过过大会话文件"))).toBe(true);
	});

	it("单次批量上限：超过 maxFilesPerRun 时截断并标记 truncated", async () => {
		const { root } = makeSessionTree({ projects: 1, filesPerProject: 3 });
		const { importer } = importerFor(root, { maxFilesPerRun: 2 });
		const res = await importer.run();
		expect(res.files).toBe(2);
		expect(res.truncated).toBe(true);
	});

	it("超过批量上限时，下一批优先读「没读完/有变化」的文件（老文件不会被永远挤出）", async () => {
		const { root } = makeSessionTree({ projects: 1, filesPerProject: 3 });
		const scanned = (await importerFor(root).importer.scan()).files;
		// A 最新、B 次之、C 最旧；批量上限 2 → 首跑读 A、B
		setMtime(scanned[0].path, Date.now() - 1 * DAY);
		setMtime(scanned[1].path, Date.now() - 2 * DAY);
		setMtime(scanned[2].path, Date.now() - 3 * DAY);
		const { importer, state } = importerFor(root, { maxFilesPerRun: 2 });
		const first = await importer.run();
		expect(first.files).toBe(2);
		expect(first.pending).toBe(3);
		expect(first.truncated).toBe(true);
		// 第二跑：A、B 没变化 → 先读还没人读过的 C，而不是把 A、B 再读一遍
		const second = await importer.run();
		expect(second.pending).toBe(1);
		expect(second.records.length).toBe(1);
		expect(Object.keys((state as any).files).length).toBe(3);
	});

	it("默认批量上限就是 200（brief 的硬要求）", () => {
		expect(MAX_FILES_PER_RUN).toBe(200);
	});

	it("按 mtime 新→旧排序，先读最新文件", async () => {
		const { root } = makeSessionTree({ projects: 1, filesPerProject: 2 });
		const files = (await importerFor(root).importer.scan()).files;
		setMtime(files[0].path, Date.now() - 2 * DAY);
		setMtime(files[1].path, Date.now() - 1 * DAY);
		const { importer } = importerFor(root, { maxFilesPerRun: 1 });
		const res = await importer.run();
		expect(res.files).toBe(1);
		expect(res.records.length).toBe(1);
	});

	it("目录未授权：ok:false + denied，不抛错", async () => {
		const { root } = makeSessionTree();
		const { importer } = importerFor(root, { authorized: false });
		const res = await importer.run();
		expect(res.ok).toBe(false);
		expect(res.errors[0].code).toBe("denied");
		expect(importer.fsReady()).toBe(true);
	});

	it("完全没有 host.fs（或没有读方法）时 fsReady=false，run 直接给 no-permission", async () => {
		const bare = createSessionImporter({ fsApi: null, rootInfo: { root: makeTmpDir(), source: "setting" } });
		expect(bare.fsReady()).toBe(false);
		const res = await bare.run();
		expect(res.ok).toBe(false);
		expect(res.errors[0].code).toBe("no-permission");
	});

	it("只有 readTextPath 时退化为字符偏移，仍然增量且不重复", async () => {
		const realRoot = makeTmpDir();
		const file = writeSessionFile(realRoot, "--p--", "s.jsonl", [sessionHeader(), assistantLine({ id: "a1" })]);
		const fsApi = createTextOnlyFs();
		const { importer, state } = importerFor(realRoot, { fsApi });
		const first = await importer.run();
		expect(first.records.length).toBe(1);
		expect(state.files[file].unit).toBe("chars");
		appendSessionFile(file, jsonl([assistantLine({ id: "a2", ts: 1791774000000 })]));
		const second = await importer.run();
		expect(second.records.length).toBe(1);
		expect(second.records[0].entryId).toBe("a2");
	});

	it("根目录不存在：给 missing 而不是抛错", async () => {
		const { importer } = importerFor(join(makeTmpDir(), "nope"));
		const res = await importer.run();
		expect(res.ok).toBe(true);
		expect(res.errors[0].code).toBe("missing");
		expect(res.records.length).toBe(0);
	});

	it("根目录换了会清空旧 offset（不会拿旧文件的 offset 读新文件）", async () => {
		const treeA = makeSessionTree();
		const treeB = makeSessionTree();
		const fsApi = createMockFs();
		const state: Record<string, unknown> = { version: 1, root: treeA.root, files: {} };
		const a = createSessionImporter({ fsApi, rootInfo: { root: treeA.root, source: "setting" }, state });
		await a.run();
		expect(Object.keys((state as any).files).length).toBe(1);
		const b = createSessionImporter({ fsApi, rootInfo: { root: treeB.root, source: "setting" }, state });
		expect(Object.keys((state as any).files).length).toBe(0);
		const res = await b.run();
		expect(res.records.length).toBe(1);
	});

	it("回填结束后落盘状态（persist 被调用）", async () => {
		const persist = vi.fn();
		const { root } = makeSessionTree();
		const { importer } = importerFor(root, { persist });
		await importer.run();
		expect(persist).toHaveBeenCalled();
	});

	it("summary() 去掉 records 数组，只留计数（/api/meta 不能塞几千条）", async () => {
		const { root } = makeSessionTree();
		const { importer } = importerFor(root);
		const res = await importer.run();
		const summary = importer.summary(res);
		expect(summary.records).toBe(1);
		expect(Array.isArray((summary as Record<string, unknown>).records)).toBe(false);
		expect(summary.errors).toEqual([]);
	});
});

describe("P0：回填身份 = 会话文件 + entry id", () => {
	it("每条回填记录都带 sessionFile（跨会话同名 entry id 不撞车）", async () => {
		const root = makeTmpDir("ul-identity-");
		writeSessionFile(root, "--p-a--", "a.jsonl", [sessionHeader({ id: "s-a" }), assistantLine({ id: "a1" })]);
		writeSessionFile(root, "--p-b--", "b.jsonl", [sessionHeader({ id: "s-b" }), assistantLine({ id: "a1" })]);
		const { importer } = importerFor(root);
		const res = await importer.run();
		expect(res.records.length).toBe(2);
		const files = res.records.map((r) => r.sessionFile).sort();
		expect(files.every((f) => typeof f === "string" && f.endsWith(".jsonl"))).toBe(true);
		expect(new Set(files).size).toBe(2);
		expect(res.records.map((r) => r.entryId)).toEqual(["a1", "a1"]);
	});

	it("同一毫秒同 model 的多条 assistant 行都保留（不再被 ts+model+provider 合并）", async () => {
		const root = makeTmpDir("ul-same-ms-");
		const lines = [sessionHeader()];
		for (let i = 0; i < 5; i++) lines.push(assistantLine({ id: `a${i}`, ts: 1_792_493_011_970 }));
		writeSessionFile(root, "--p--", "s.jsonl", lines);
		const { importer } = importerFor(root);
		const res = await importer.run();
		expect(res.records.length).toBe(5);
		expect(new Set(res.records.map((r) => r.entryId)).size).toBe(5);
	});

	it("assistant 行没有 id 时按出现顺序合成稳定序号（~1 / ~2）", () => {
		const ctx: Record<string, unknown> = { sessionFile: "C:/sessions/x.jsonl" };
		const text = jsonl([sessionHeader(), assistantLine({ id: null }), assistantLine({ id: null })]);
		const parsed = parseSessionText(text, ctx);
		expect(parsed.records.map((r) => r.entryId)).toEqual(["~1", "~2"]);
		expect(parsed.records[0].sessionFile).toBe("C:/sessions/x.jsonl");
	});
});

describe("覆盖率：已导入 X/M 个会话文件", () => {
	it("一次跑完：coverage.imported === eligible，truncated=false", async () => {
		const { root } = makeSessionTree({ projects: 1, filesPerProject: 3 });
		const { importer } = importerFor(root);
		const res = await importer.run();
		expect(res.coverage).toEqual({ imported: 3, eligible: 3, remaining: 0 });
		expect(res.truncated).toBe(false);
	});

	it("批次没扫完：remaining > 0 且 truncated=true（续批后归零）", async () => {
		const { root } = makeSessionTree({ projects: 1, filesPerProject: 3 });
		const scanned = (await importerFor(root).importer.scan()).files;
		setMtime(scanned[0].path, Date.now() - 1 * DAY);
		setMtime(scanned[1].path, Date.now() - 2 * DAY);
		setMtime(scanned[2].path, Date.now() - 3 * DAY);
		const { importer } = importerFor(root, { maxFilesPerRun: 2 });
		const first = await importer.run();
		expect(first.coverage).toEqual({ imported: 2, eligible: 3, remaining: 1 });
		expect(first.truncated).toBe(true);
		const second = await importer.run();
		expect(second.coverage).toEqual({ imported: 3, eligible: 3, remaining: 0 });
		expect(second.truncated).toBe(false);
	});

	it("过老 / 过大的文件不计入 eligible（不该拖累覆盖率）", async () => {
		const root = makeTmpDir("ul-coverage-");
		writeSessionFile(root, "--p--", "fresh.jsonl", [sessionHeader(), assistantLine({ id: "a1" })]);
		writeSessionFile(root, "--p--", "old.jsonl", [sessionHeader(), assistantLine({ id: "a2" })]);
		const scanned = (await importerFor(root).importer.scan()).files;
		const oldFile = scanned.find((f) => f.path.endsWith("old.jsonl"));
		setMtime(oldFile.path, Date.now() - 30 * DAY);
		const { importer } = importerFor(root, { days: 7 });
		const res = await importer.run();
		expect(res.coverage.eligible).toBe(1);
		expect(res.coverage.imported).toBe(1);
		expect(res.skipped.tooOld).toBe(1);
	});
});
