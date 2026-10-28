# CHANGELOG

## 2.1.1

- `scripts/verify-real-sessions.mjs` 判定口径修正：参考值是历史快照，滚动窗口的正偏差不再判失败；只拦「少算 / 覆盖不全 / truncated」，需要旧行为加 `--strict`

## 2.1.0 — 补价格表回退、缓存命中率、速度口径

修三个用户可见问题：内网网关（LiteLLM / cliproxyapi 这类）不回填价格导致成本全显示 `$0.0000`；缓存字段落库了但没算命中率；`tok·s⁻¹` 是「每次调用的算术均值」而不是总体吞吐。

### 新增

- **价格表回退（A）**：新建 `lib/prices.mjs`。SDK 没有回填成本（`cost.total = 0`）时，按三个公开源估算：models.dev（已是每 1M）、LiteLLM（每 token ×1e6）、OpenRouter（字符串每 token ×1e6）。三源失败互不影响，失败只记 `sources[].ok=false`。
  - 缓存：`<host.dataDir>/prices.json`，TTL 7 天；读缓存不联网；`POST /api/prices/refresh` 强制刷新；刷新失败保留旧快照。
  - 计价口径：`promptTokens = input + cacheRead + cacheWrite`，`estimateUsd = (input*pIn + output*pOut + cacheRead*pCacheRead + cacheWrite*pCacheWrite) / 1e6`。缺 `cacheRead` / `cacheWrite` 价一律按 `input` 计，并在 `priceNote` 里标 `cacheRead≈input`；**绝不把缺价当 0**。
  - 记录字段：`costUsd`（生效成本：SDK `>0` 优先，否则估算）、`costSource`（`sdk` / `estimate` / `null`）、`costEstimateUsd`（估算值永远保留）、`priceId`、`priceNote`。
  - 汇总：`summary.cost = {amount, sdkAmount, estimatedAmount, estimateShare, pricedCalls, unpricedCalls, …}`，`amount = sdkAmount + estimatedAmount`；看板同时显示「其中估算」占比。
  - 模型解析（`resolvePrice(model, hints)`，纯函数）：用户覆盖 `priceOverrides` → 官方厂商行（`qwen*`→alibaba-cn/alibaba，`gemini*`→google，`grok*`→xai，`mimo*`→xiaomi，`deepseek*`→deepseek/alibaba*；匹配前先剥 `provider/` 前缀与 `-high` / `-next` / `-1017` 这类变体后缀）→ 多来源中位数 → `null`（显示 `--`）。候选**全部可枚举**：`GET /api/prices?model=xxx`。
- **缓存命中率（B）**：记录级 `cacheReadTokens / promptTokens`（分母 0 → `null`）。汇总主口径是加权 `ΣcacheRead / ΣpromptTokens`，另给 `cacheHitRateMean` 与 `cacheHitSamples`。展示：指标卡新增「缓存命中率」（带样本数）、按模型表新增「命中率」列、记录表缓存列改成 `读/写 · 命中%`、CSV 新增「缓存命中率」列。**没有缓存字段的老会话排除出样本，不算 0%**。
- **速度口径（C）**：`lib/metrics.mjs` 新增 `throughput(records) → {weighted, mean, samples}`；指标卡与按模型表的 `tok·s⁻¹` 主值改成 `weighted`（总输出 ÷ 总耗时），算术均值（2.0 的旧口径）以 `tokPerSecMean` 保留，只放在 tooltip。记录表每行仍是「本条 output ÷ 耗时」，不变。
- **看板**：新增「价格表」面板（每个模型命中的价格行、四项价、候选数、失败源、「刷新价格表」按钮，并给出 `priceOverrides` 写法）。
- **设置项**：恢复 `priceOverrides`（JSON，USD / 每 1M token，可选）。
- **接口**：新增 `GET /api/prices?model=`、`POST /api/prices/refresh`；`/api/meta` 与 `/api/summary` 带价格表状态。

### 工程

- 单测 201 → 265 条（新增：三源归一单位、候选枚举顺序、6 个已知候选命中、中位数回退、覆盖优先、缺缓存价按 input 计、SDK 优先于估算、两者都无 → `null`、命中率分母 0 → `null`、加权 vs 均值不同值、老会话排除样本、缓存读写与 TTL、刷新失败保留旧快照、插件接线与两个新接口）。
- 测试全部离线：价格数据用 `tests/fixtures/prices/*.json`（按真实源形状裁剪），`host.fetch` 一律打桩。
- `callsChart`（含 `yGoodTop`）与 `tests/unit/usage-ledger-chart-baseline.test.ts` 未改动；权限仍为 `["ui","http","fs:read"]`（价格抓取走 `host.fetch`，不需要 `net`）。

## 2.0.3

- 权限收敛：去掉未使用的 `storage`（账本与状态都写在插件自己的数据目录），现为 `["ui","http","fs:read"]`
- 升级提示：`fs:read` 是新权限，首次启用需在设置里授权一次，未授权时插件以「仅实时」降级运行

## 2.0.2

- 记录明细支持「导出筛选结果 CSV」（纯前端生成，带 BOM，上限 5000 行，超限提示缩小范围）
- 新增「显示设置」列开关（本地记忆）、每页 20/50/100/200 条切换
- 表格列可隐藏，至少保留一列；明细行 colspan 跟随可见列

## 2.0.1 — 修复回填去重把几万次真实调用合并掉（P0）

### 修复

- **P0｜回填去重键改成唯一身份 `sessionFile + entry.id`**。2.0.0 用 `ts + model + provider` 给回填记录去重，同一毫秒内的多次调用（并行 / 子代理）被折叠成一条：实测 7 天窗口里 43,470 次真实调用（48,867 行 assistant，entry id 全唯一）被合并成 10,607 条，最严重的一毫秒有 16 次调用共用同一个键，token 与成本只有真值的 1/3——调用数 10,633 vs 43,470，金额 $187.81 vs $349.78。现在回填记录只认 `sessionFile + entry.id`；没有 `id` 的老行按出现顺序合成稳定序号，**绝不**退化成内容键。
- **P0｜live ↔ 回填改成严格 1:1 贪心配对**。候选条件：同 `model` + 同 `provider` + `|Δts| ≤ 3000ms`，取 ts 最接近的一条；每条 live 最多认领一条回填，每条回填也最多被认领一次（`paired` 标记），**严禁 1→N 合并**。配不上就各自保留（live 标只算实时、回填 TTFT 为 `null`），不互相吞掉。合并口径：token / 成本 / 停止原因取回填，`ttftMs` 与 `durationMs` 取 live（live 没有耗时才用 SDK 的 `message.durationMs`）。
- **P1｜覆盖率显式暴露**。回填 summary 新增 `coverage{imported, eligible, remaining}`：底栏 tooltip 与看板顶部写「已导入 X/M 个会话文件」，`truncated`（批次没扫完）时用 `host.schedule` 隔 2 秒自动续批，UI 标「导入中…」并给「停止导入」按钮（`POST /api/backfill/stop`）。`truncated` 现在看**进度**而不是只看批次数，扫完就自动转 false。
- **P1｜数字自证**。`scripts/verify-real-sessions.mjs` 内置人工独立复算参考值（7 天：43,470 次 / 5,454,922,553 tokens / $349.7777 / grok-4.7 4,240 次），跑完打印各项偏差（%），偏差 > 2% 以非 0 退出，并区分「文件覆盖不足」与「去重误合并」。

### 升级须知（需重建账本）

- **2.0.0 的历史账本已被污染**（回填记录被错误合并，token / 成本不可信，无法就地修复）。2.0.1 首次激活时**自动重建一次**：丢弃 `source: backfill` 的记录、把「回填 + live」混合记录退回纯 live、清空 `backfill-state.json` 里的文件 offset，然后重新回填会话（会话目录只读，原始数据不丢）。
- **不需要**手动删 `ledger.jsonl`；迁移只在 `backfill-state.json` 里没有 `ledgerSchema: 2` 时跑一次。重建期间底栏与看板会显示「导入中… X/M」，扫完即恢复正常。
- 旧 live 记录的 TTFT 保留；它们会与重新回填的记录按 1:1 配对重新补齐 token 与成本。

### 工程

- 单测 167 → 196 条（新增：同毫秒 16 次调用不合并、`sessionFile` 进身份键、1 条回填 vs 3 条同毫秒 live、3 条回填 vs 1 条 live、配对窗口与贪心取最近、配对后重启仍一条、账本重建、覆盖率与续批、客户端覆盖率渲染）。
- `callsChart`（含 `yGoodTop`）与 `tests/unit/usage-ledger-chart-baseline.test.ts` 未改动；权限仍为 `["ui", "storage", "http", "fs:read"]`。

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
