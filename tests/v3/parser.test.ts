/**
 * v3 会话解析（`lib/v3/parser.mjs`）：真实 JSONL 形状 → 明细行。
 *
 * 样本**内联**在用例里（3–7 行，形状照抄 pi 的真实会话文件），
 * 不读 `~/.pi/agent/sessions` 与任何真实账本。
 */
import { describe, expect, it } from "vitest";
import {
	ROW_FIELDS,
	SKIP_REASONS,
	deriveEntryKey,
	normalizeStatus,
	parseSessionLine,
	projectFromCwd,
	sessionFileToRows,
} from "../../lib/v3/parser.mjs";

/** 真实会话文件的前 7 行：session / model_change / user / assistant(ok, 带 cost) /
 *  assistant(aborted, 无 usage) / assistant(usage 全 0, cost.total=0) / 坏 JSON。 */
const SAMPLE = [
	'{"type":"session","version":3,"id":"sess-1","timestamp":"2026-10-12T03:00:10.854Z","cwd":"C:/Users/hua/Desktop/JK项目/知识库"}',
	'{"type":"model_change","id":"mc1","provider":"cliproxyapi","modelId":"grok-4.7"}',
	'{"type":"message","id":"u1","timestamp":"2026-10-12T03:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1791774060000}}',
	'{"type":"message","id":"a1","timestamp":"2026-10-12T03:01:30.947Z","message":{"role":"assistant","provider":"cliproxyapi","model":"grok-4.7","usage":{"input":7309,"output":825,"cacheRead":1152,"cacheWrite":0,"reasoning":558,"totalTokens":9286,"cost":{"input":0.014618,"output":0.00495,"cacheRead":0.000576,"cacheWrite":0,"total":0.020144}},"durationMs":4321,"stopReason":"stop","timestamp":1791774070834}}',
	'{"type":"message","id":"a2","timestamp":"2026-10-12T03:02:30.947Z","message":{"role":"assistant","provider":"cliproxyapi","model":"grok-4.7","durationMs":1200,"stopReason":"aborted","timestamp":1791774071834}}',
	'{"type":"message","id":"a3","timestamp":"2026-10-12T03:03:30.947Z","message":{"role":"assistant","provider":"cliproxyapi","model":"grok-4.7","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"total":0}},"durationMs":null,"stopReason":"stop","timestamp":1791774072834}}',
	'{"type":"message","id":"broken"',
].join("\n");

const FILE = "/sessions/--JK项目--/2026-10-12T03-00-00-000Z_x.jsonl";
const ROOT = "/sessions";
const REL = "--JK项目--/2026-10-12T03-00-00-000Z_x.jsonl";

describe("parser：真实样本 → 行字段齐全", () => {
	const { rows, stats } = sessionFileToRows(SAMPLE, { file: FILE, sessionsRoot: ROOT });

	it("3 条 assistant 入账，坏 JSON 只记一次跳过，其余非 message 行归 context", () => {
		expect(rows.length).toBe(3);
		expect(stats.rows).toBe(3);
		expect(stats.skipped["bad-json"]).toBe(1);
		expect(stats.skipped["not-assistant"]).toBe(1);
		expect(stats.skipped["context"]).toBe(2); // session + model_change
		expect(stats.convId).toBe("sess-1");
	});

	it("字段全齐（ROW_FIELDS 一个不缺），值逐项对得上", () => {
		const row = rows[0] as Record<string, unknown>;
		for (const field of ROW_FIELDS) expect(Object.hasOwn(row, field), field).toBe(true);
		expect(row.entryKey).toBe(`e:${REL}:a1`);
		expect(row.ts).toBe(1791774070834);
		expect(row.convId).toBe("sess-1");
		expect(row.model).toBe("grok-4.7");
		expect(row.provider).toBe("cliproxyapi");
		expect(row.status).toBe("ok");
		expect(row.origin).toBe("backfill");
		expect(row.inTok).toBe(7309);
		expect(row.outTok).toBe(825);
		expect(row.cacheRead).toBe(1152);
		expect(row.cacheWrite).toBe(0);
		expect(row.reasoningTok).toBe(558);
		expect(row.totalTok).toBe(9286);
		expect(row.costSdk).toBe(0.020144);
		expect(row.costSource).toBe("sdk");
		// 历史导入没有首字延迟，genMs 按非流式取 durationMs
		expect(row.ttftMs).toBeNull();
		expect(row.genMs).toBe(4321);
		expect(row.e2eMs).toBe(4321);
		expect(row.stopReason).toBe("stop");
		expect(row.src).toBe(REL);
	});

	it("project 是短标签，不含盘符/绝对路径", () => {
		const row = rows[0] as Record<string, unknown>;
		expect(String(row.project)).toBe("JK项目/知识库");
		expect(String(row.project)).not.toContain(":");
		expect(String(row.project)).not.toContain("\\");
	});
});

describe("parser：状态六态归一", () => {
	const { rows } = sessionFileToRows(SAMPLE, { file: FILE, sessionsRoot: ROOT });

	it("aborted 单独一态；没有 usage 又不能当成功 → aborted 优先", () => {
		const aborted = rows.find((row: Record<string, unknown>) => row.msgId === "a2") as Record<string, unknown>;
		expect(aborted.status).toBe("aborted");
		expect(aborted.inTok).toBeNull();
		expect(aborted.totalTok).toBeNull();
	});

	it("cost.total=0 不被当成 SDK 真值（costSource 留空，等价格表估算）", () => {
		const zero = rows.find((row: Record<string, unknown>) => row.msgId === "a3") as Record<string, unknown>;
		expect(zero.costSdk).toBe(0);
		expect(zero.costSource).toBeNull();
		expect(zero.totalTok).toBe(0);
	});

	it("normalizeStatus 的判定表逐条成立", () => {
		expect(normalizeStatus({ usage: {}, stopReason: "aborted" })).toBe("aborted");
		expect(normalizeStatus({ usage: null, stopReason: "stop" })).toBe("incomplete");
		expect(normalizeStatus({ usage: undefined, stopReason: undefined })).toBe("incomplete");
		expect(normalizeStatus({ usage: {}, stopReason: "error" })).toBe("provider_error");
		expect(normalizeStatus({ usage: {}, stopReason: "refusal" })).toBe("provider_error");
		expect(normalizeStatus({ usage: {}, stopReason: "maxTokens" })).toBe("ok");
		expect(normalizeStatus({ usage: {}, stopReason: "length" })).toBe("ok");
		expect(normalizeStatus({ usage: {}, stopReason: null, errorMessage: "boom" })).toBe("provider_error");
		expect(normalizeStatus({ usage: {}, stopReason: "stop" })).toBe("ok");
	});
});

describe("parser：坏行不影响整文件", () => {
	it("中间插一行坏 JSON，前后行照常入账；跳过原因键固定", () => {
		const lines = SAMPLE.split("\n");
		const withBad = [...lines.slice(0, 4), "{not json at all", ...lines.slice(4)];
		const { rows, stats } = sessionFileToRows(withBad, { file: FILE, sessionsRoot: ROOT });
		expect(rows.length).toBe(3);
		expect(stats.skipped["bad-json"]).toBe(2); // 中间一行 + 尾部截断行
		expect(Object.keys(stats.skipped).sort()).toEqual([...SKIP_REASONS].sort());
	});

	it("没有 timestamp 的 assistant 行记 no-timestamp，不猜时间", () => {
		const line = '{"type":"message","id":"a9","message":{"role":"assistant","usage":{"input":1}}}';
		const parsed = parseSessionLine(line, { rel: REL, lineIndex: 0 });
		expect(parsed.row).toBeNull();
		expect(parsed.reason).toBe("no-timestamp");
	});

	it("没有 msgId 时用行号定位身份（绝不退化成 ts+model）", () => {
		expect(deriveEntryKey(REL, null, 7)).toBe(`e:${REL}:7`);
		expect(deriveEntryKey(REL, "a1", 7)).toBe(`e:${REL}:a1`);
		expect(deriveEntryKey(REL, null, 7)).not.toBe(deriveEntryKey(REL, null, 8));
	});

	it("同一文件重复 msgId 只算第一条（duplicate 计数）", () => {
		const lines = [
			'{"type":"message","id":"dup","message":{"role":"assistant","usage":{"input":10},"timestamp":1791774070834}}',
			'{"type":"message","id":"dup","message":{"role":"assistant","usage":{"input":10},"timestamp":1791774070834}}',
		];
		const { rows, stats } = sessionFileToRows(lines, { file: FILE, sessionsRoot: ROOT });
		expect(rows.length).toBe(1);
		expect(stats.skipped.duplicate).toBe(1);
	});
});

describe("parser：cwd → 项目标签", () => {
	it("家目录之下去掉盘符，取最后两段", () => {
		expect(projectFromCwd("C:/Users/hua/Desktop/JK项目/知识库", "C:/Users/hua")).toBe("JK项目/知识库");
		expect(projectFromCwd("C:\\Users\\hua\\Desktop\\demo", "C:/Users/hua")).toBe("Desktop/demo");
		expect(projectFromCwd("C:/Users/hua", "C:/Users/hua")).toBe("Users/hua");
		expect(projectFromCwd("", "C:/Users/hua")).toBeNull();
		expect(projectFromCwd(null)).toBeNull();
	});
});
