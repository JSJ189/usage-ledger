import { defineConfig } from "vitest/config";

// 独立仓库：只有纯函数单测 + 一个 jsdom 客户端测试，不需要任何宿主别名。
export default defineConfig({
	test: {
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		silent: true,
		onConsoleLog: () => false,
	},
});
