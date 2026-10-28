# CHANGELOG

## 2.0.0 — 记录 pi-web-ui 自己的模型调用（破坏性）

### 破坏性变更

- **数据源换了**：不再读本机代理的 SQLite 用量账本，改为记录 **pi-web-ui 自己的每次模型调用**。
  - 实时：`host.onRunEvent` 的运行轨迹事件（`turn_start` / `turn_first_token` / `message` / `turn_end` / `run_end`），TTFT 只从这里来。
  - 历史：`~/.pi/agent/sessions/**/*.jsonl` 的 assistant 行（token、真实成本、单次耗时），增量回填。
  - 两路按 `sessionId+entryId` / `ts+model+provider` 合并，同一次调用不会翻倍。
- **删除**：`usage.db` 发现链（设置项 / 环境变量 / 端口 / 已知位置 / 搜索根）、`node:sqlite` 只读连接、五维分组、事件明细里的代理字段。
- **删除**：三源价目表（models.dev / LiteLLM / OpenRouter）、全部 `net` 抓取代码与 `netAllowlist`；成本改用 SDK 记录的 `usage.cost.total`，**不再估算**。
- **权限变化**：`["ui", "http", "net", "storage"]` → `["ui", "storage", "http", "fs:read"]`。
  - 去掉 `net`：插件不再联网。
  - 加 `fs:read`：读会话 JSONL 拿 token 与真实成本（`UiMessage` 不带 token）。registry 风险等级由 LOW 升为 **MEDIUM，安装时需人工确认**；插件对该目录只读。
  - 保留 `http`：看板自己的数据路由（`host.route`）需要它。
- **设置项**：删 `dbPath` / `autoDiscover` / `searchRoots` / `cacheTtlSec` / `priceOverrides`；加 `sessionsDir` / `backfillDays` / `backfillOnStart`。
- **HTTP 接口**：`/api/events` → `/api/records`（分页 + 模型/状态筛选）；新增 `/api/meta`、`POST /api/backfill`、`POST /api/grant`；删除 `/api/prices`、`/api/prices/refresh`。

### 新能力

- **按模型汇总表**：每个模型一行（调用数、成功率、TTFT p50/p90、平均延迟、`tok·s⁻¹`、token 明细、成本、占比），点行 = 只看该模型。
- **实时 TTFT**：`turn_first_token.durationMs`，并与回填记录合并；看板显示 TTFT 样本数与覆盖率，明确「历史条目没有 TTFT」。
- **增量回填**：按文件 `{mtime, size, offset}` 只读新增字节；`backfillDays` 默认 30；单次 ≤200 文件、单文件 >100MB 跳过、逐文件让出事件循环；崩溃遗留半行不消费。
- **降级路径**：没有 `fs:read` 或用户拒绝授权 → 只采实时（token/成本显示 `--`），底栏写「仅实时」，看板给「授权并导入历史」按钮（`host.fs.requestAccess` 成功后自动回填）。
- **自维护账本**：`<host.dataDir>/ledger.jsonl`，append-only + 自动压实，崩溃最多丢最后一行。

### 工程

- 新增模块：`lib/ledger.mjs`（存储与去重）、`lib/sessions.mjs`（会话回填）、`lib/metrics.mjs`（聚合）、`lib/live.mjs`（实时采集）。
- 删除：`lib/prices.mjs`、`scripts/verify-real-db.mjs`、`tests/fixtures/cliproxy-prices/*`。
- 测试：单测从 162 条增至 166 条，全部离线（会话 fixture + `host.fs` 替身，不碰真实会话目录）。
- `scripts/check-manifest.mjs` 加严：不再允许残留代理账本 / 价目表代码，必需文件与权限再核对。

## 1.0.0 — 首个对外版本

从 pi-web-ui 内置插件（0.2.2）抽成独立开源仓库，对外发布。

### 新能力

- **跨平台账本发现链**：设置项 `dbPath` → 环境变量 `CLIPROXY_USAGE_DB` → pi 代理配置 `baseUrl` 端口 → 已知安装位置 → 搜索根（只 readdir 两层）。每一步都写 `info` 日志。
- **结构化空态**：都找不到时返回 `{ ok:false, code:"db-not-found", candidates:[...], hint }`；看板展示已尝试的候选路径，底栏显示 `--`，不抛错、不静默显示 0 数据。
- **设置项 `autoDiscover`**：可关闭自动发现（只认 `dbPath` 与环境变量）。

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
