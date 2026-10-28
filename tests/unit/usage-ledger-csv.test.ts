/**
 * CSV 导出与列开关（对标界面的「导出筛选结果 CSV」+「显示设置」）。
 * 纯函数断言，不写盘、不联网。
 */
import { describe, expect, it } from "vitest";
import { buildCsv } from "../../client/entry.mjs";

const DICT = {
	thTime: "时间",
	thModel: "模型",
	thProvider: "来源",
	thThinking: "思考",
	thTokens: "Token",
	thCache: "缓存",
	thTtft: "首字",
	thDuration: "耗时",
	thTokps: "速度",
	thCost: "成本",
	thStatus: "结果",
	statusOk: "成功",
	statusFailed: "失败",
	statusIncomplete: "未收全",
};

const row = {
	id: "a1",
	ts: 1792493011970,
	model: "grok-4.7",
	provider: "xai",
	thinkingLevel: "high",
	totalTokens: 9286,
	cacheReadTokens: 1152,
	cacheWriteTokens: 0,
	ttftMs: 5120,
	durationMs: 8330,
	outputTokens: 825,
	costUsd: 0.020144,
	status: "ok",
};

describe("buildCsv", () => {
	it("带 BOM、CRLF、中文表头", () => {
		const csv = buildCsv([row], DICT);
		expect(csv.startsWith("\uFEFF")).toBe(true);
		expect(csv).toContain("\r\n");
		expect(csv.split("\r\n")[0]).toContain("模型");
	});

	it("逐字段落列，速度按 output/耗时 计算", () => {
		const lines = buildCsv([row], DICT).split("\r\n");
		expect(lines.length).toBe(3); // 头 + 1 行 + 结尾空
		expect(lines[1]).toContain("grok-4.7");
		expect(lines[1]).toContain("xai");
		expect(lines[1]).toContain("9286");
		expect(lines[1]).toContain("1152/0");
		expect(lines[1]).toContain("5120"); // ttft 毫秒原值
		expect(lines[1]).toContain("99.04"); // 825 / 8.33s
		expect(lines[1]).toContain("0.020144");
		expect(lines[1]).toContain("成功");
	});

	it("null TTFT / 成本不写成 0（留空）", () => {
		const csv = buildCsv([{ ...row, ttftMs: null, costUsd: null, outputTokens: 0 }], DICT);
		const cells = csv.split("\r\n")[1].split(",");
		expect(cells[6]).toBe("");
		expect(cells[8]).toBe("");
		expect(cells[9]).toBe("");
	});

	it("含逗号/引号/换行的值必须转义", () => {
		const csv = buildCsv([{ ...row, model: 'weird,"model"\nline' }], DICT);
		const line = csv.split("\r\n").slice(1, 3).join("\r\n");
		expect(line).toContain('"weird,""model""');
	});

	it("空列表只输出表头", () => {
		const lines = buildCsv([], DICT).split("\r\n").filter(Boolean);
		expect(lines.length).toBe(1);
	});
});
