# CHANGELOG

## 1.0.0 — 首个对外版本

从 pi-web-ui 内置插件（0.2.2）抽成独立开源仓库，对外发布。

### 新能力

- **跨平台账本发现链**：设置项 `dbPath` → 环境变量 `CLIPROXY_USAGE_DB` → pi 代理配置 `baseUrl` 端口 → 已知安装位置 → 搜索根（只 readdir 两层）。每一步都写 `info` 日志。
- **结构化空态**：都找不到时返回 `{ ok:false, code:"db-not-found", candidates:[...], hint }`；看板展示已尝试的候选路径，底栏显示 `--`，不抛错、不静默显示 0 数据。
- **设置项 `autoDiscover`**：可关闭自动发现（只认 `dbPath` 与环境变量）。
- **不再写死 `E:\EasyCLIProxyAPI-*`**：任意盘符、任意常见安装位置、任意兼容 `usage_events` schema 的账本都能用。

### 保留能力

- 只读 `node:sqlite`（`readOnly` + `PRAGMA query_only`），绝不写账本。
- 五维分组（model / provider / executor / endpoint / client），窗口 today / 7d / 30d。
- 指标：请求数、失败率（`failed ∪ canceled`）、TTFT p50/p90（仅 `ttft_ms > 0`）、时延、tok/s、token 用量。
- 三源价目表（models.dev / LiteLLM / OpenRouter）：effort 后缀剥离、provider 映射、tiers、多源分歧标记、未知价 `null` 语义、`priceOverrides` 手工覆盖。
- 4 个 GET 路由 + 1 个 POST（`/api/prices/refresh`）、缓存 TTL 与 30 秒失败冷却、底栏预热、后台任务心跳。
- 事件明细不下发敏感列（api_key / IP / request_id / failure_body / 邮箱）。

### 工程

- 独立仓库：`vitest` + `jsdom` 单测（不依赖宿主仓库）；`tests/support/mock-host.mjs` 是最小宿主替身。
- `scripts/check-manifest.mjs`：manifest 字段、权限白名单、图标、版本一致性、价格原文体积自检。
- `registry/plugin.json`：提交到 `xing-shuyin/pi-web-ui-plugins` 的元数据卡。
- 权限仍为 `["ui", "http", "net", "storage"]`（无 `fs`、无 `dom`），按 registry 规则属于 LOW 风险，可自动合并。
