# 用量账本 · usage-ledger

[![CI](https://github.com/JSJ189/usage-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/JSJ189/usage-ledger/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![manifest](https://img.shields.io/badge/manifest-2.1.0-informational)
![permissions](https://img.shields.io/badge/permissions-ui%20%7C%20http%20%7C%20fs%3Aread-brightgreen)

pi-web-ui 界面插件：记录 **pi-web-ui 自己发出的每一次模型调用**，按模型统计调用数、成功率、TTFT 分位、单次耗时、吞吐（`tok·s⁻¹`）、缓存命中率、token 用量与**成本**。成本优先用 SDK 记录的 `usage.cost.total`；网关不回填（`cost.total = 0`）时按公开价格表估算，并把「SDK 成本 / 其中估算」分开展示。底栏常驻「今日调用数 / TTFT p50」，点击打开看板。

数据来源：

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| TTFT | `host.onRunEvent` 的 `turn_first_token.durationMs` | **只能实时采集**；历史回填的条目没有 TTFT |
| token（输入/输出/缓存读/缓存写/推理） | 会话 JSONL 的 `message.usage` | 可回填历史 |
| SDK 成本 USD | 会话 JSONL 的 `message.usage.cost.total` | 与宿主显示的数字同源 |
| 估算成本 USD | 公开价格表（models.dev / LiteLLM / OpenRouter） | 仅当 SDK 成本为 0 / 缺失时生效，缓存 7 天 |
| 单次调用耗时 | 会话 JSONL 的 `message.durationMs`；无则用 turn 时长 | 可回填历史 |
| 模型 / provider / 停止原因 | 会话 JSONL + `message` 运行事件 | 两路按「同一次调用」1:1 配对 |

## 安装

市场一键安装（pi-web-ui「添加插件」里搜「用量账本」），或命令行：

```bash
pi-web-ui install JSJ189/usage-ledger
```

安装后重启/重扫插件，底栏出现 📊「用量账本」，点击打开看板。

要求：pi-web-ui（插件 `apiVersion: 2`）+ Node ≥ 22.13。**不需要**任何第三方代理软件或数据库。

## 权限说明（重要）

`manifest.permissions = ["ui", "http", "fs:read"]`。

- `fs:read`：读 `~/.pi/agent/sessions/**/*.jsonl`，这是**唯一**能拿到逐轮 token 与真实成本的地方（宿主的 `UiMessage` 不带 token）。它会让 registry 风险等级从 LOW 升到 **MEDIUM，安装时需人工确认**——这是拿到 token 数据的必要代价。插件对该目录**只读**，绝不写入；路径可用设置项 `sessionsDir` 覆盖，首次访问由宿主弹窗授权（`host.fs.requestAccess`）。
- `http`：插件自己的看板数据路由（`host.route("/api/…")`）+ **价格表抓取**（`host.fetch`，只有三个固定 HTTPS 主机）。**不访问任何用户数据主机**，不上传任何内容。
- `ui`：底栏徽标与看板视图。

不给 `fs:read`（或用户拒绝授权）也能用：只采实时事件，token 与成本显示 `--`，底栏写「仅实时」，看板顶部给「授权并导入历史」按钮。

价格表只用三个固定地址：

| 源 | 地址 | 单位 |
| --- | --- | --- |
| models.dev | `https://models.dev/api.json` | USD / 1M（原样） |
| LiteLLM | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | USD / token（×1e6） |
| OpenRouter | `https://openrouter.ai/api/v1/models` | USD / token 字符串（×1e6）|

抓取结果只缓存在插件自己的数据目录（`<host.dataDir>/prices.json`，TTL 7 天），不写任何外部文件；三个源失败互不影响，失败只在看板标出，不影响统计。

## 账本存在哪

`<host.dataDir>/ledger.jsonl`（一行一条记录，append-only，崩溃最多丢最后一行）。

- 每条记录：`ts | conversationId | projectDir | provider | model | thinkingLevel | inputTokens | outputTokens | cacheReadTokens | cacheWriteTokens | reasoningTokens | totalTokens | costUsd | durationMs | ttftMs | stopReason | status | source(live|backfill) | sources[] | sessionFile | entryId | paired`。
- **身份键与配对是两件事**（2.0.1 修复）：
  - 回填记录的身份键**只有** `sessionFile + entry.id`（会话里每个 assistant 行的 `id` 唯一，一次调用一行）。**不用** `ts + model + provider` 去重：同一毫秒内多次调用（并行 / 子代理）真实存在，那样会把几十次真实调用合并成一条。
  - live 记录的身份键是 `conversationId + turnStartAt`（一个对话同一时刻只有一个 turn）。
  - live（有 TTFT、没 token）与回填（有 token、没 TTFT）是同一调用的两半，靠 **1:1 贪心配对**合并：同 `model` + 同 `provider` + `|Δts| ≤ 3000ms`，取 ts 最接近的一条；每条 live 最多认领一条回填，反过来也一样（认领过就带 `paired` 标记）。配不上就各自保留（live 只算实时那次、回填 TTFT 为 `null`），**绝不互相吞掉**。
  - 配对口径：token / 成本 / 停止原因取回填；`ttftMs` 只取 live；`durationMs` 取 live（`turn_start`→`turn_end` 实测耗时），live 没有才用回填的 `message.durationMs`；状态以「非 incomplete 的真实结局」为准。
- 回填进度存在 `<host.dataDir>/backfill-state.json`：每个文件的 `{mtime, size, offset, unit, ctx}`，下次只读新增字节。
- **升级到 2.0.1 会重建一次账本**：2.0.0 用 `ts + model + provider` 去重，历史回填记录的 token / 成本已被错误合并、无法就地修复。激活时自动丢弃 `source: backfill` 的记录、清空回填 offset、把「回填 + live」混合记录退回纯 live，然后重新回填（会话目录只读，数据不丢，只是重算一遍）。**不需要**手动删 `ledger.jsonl`。

## 回填（导入历史）

- 位置：设置项 `sessionsDir` → `$PI_CODING_AGENT_DIR/sessions` → `~/.pi/agent/sessions`。
- 范围：只回填 `mtime` 在 `backfillDays`（默认 30，夹取 1–3650）内的文件；单次最多 200 个文件（按 mtime 新→旧）、单文件超过 100MB 跳过并记日志；每处理一个文件让出一次事件循环。
- **覆盖率显式暴露**：批次没扫完（`truncated`）时自动隔 2 秒续批，直到扫完或用户在看板点「停止导入」；底栏 tooltip 与看板顶部始终写「已导入 X/M 个会话文件」，导入中额外标「导入中…」。不允许「看起来已完成，其实只导了 1/4」。
- 触发：激活时一次（`backfillOnStart` 可关）、每 5 分钟一次增量、看板「回填」按钮、授权成功后立刻一次。
- 只读：全程走 `host.fs` 的跨目录读接口，插件不会写这个目录。

## 看板

- 指标卡：调用数、成功率、失败/未收全、TTFT p50/p90/p99（带**样本数**与**覆盖率**）、平均延迟、`tok·s⁻¹`（**总输出 ÷ 总耗时**）、**缓存命中率**（加权，带 `n=` 样本数）、token 明细、成本（SDK 合计 + **其中估算**占比）。
- **按模型汇总**（用户第一诉求）：每行一个模型，调用数、成功率、TTFT p50/p90、平均延迟、`tok·s⁻¹`、token、**命中率**、成本、占比；点行 = 只看该模型。`tok·s⁻¹` 与命中率的算术均值放在 tooltip 里（`均值 xx`）。
- **价格表**面板：每个模型命中的价格行（`source:provider/model`）、四项价（USD / 1M）、候选数、失败源，以及 `priceOverrides` 写法。
- 趋势：按小时 / 按天，两张手写 SVG 图（调用数 + TTFT p90）。
- 记录明细：时间 / 模型 / provider / 思考档 / token / 缓存（`读/写 · 命中%`）/ 首字 / 耗时 / `tok·s⁻¹` / 成本（估算显示 `≈`）/ 状态；状态筛选、分页、点行展开拆分与来源、导出 CSV（含「缓存命中率」列）。

## 口径

- **TTFT** = `turn_start` → 第一个流式包（`Date.now() - turnStartAt`）。**历史回填的条目没有 TTFT**：看板必须显示覆盖率，不能把「样本少」当成「很快」。
- **成功率** = `status === "ok"` / 全部调用。`failed` = `status === "error"`；`incomplete` = 没收到 `message` 事件或会话里没有 `usage` 块（老会话 / 中断），这类记录 token 与成本不可信。
- **`tok·s⁻¹`（主值）= 总体吞吐** = `ΣoutputTokens / (ΣdurationMs / 1000)`，只算 `durationMs > 0 && outputTokens > 0` 的调用。它回答「这段时间整体多快」。
  - 另一个数 `tokPerSecMean` = 每次 `outputTokens / (durationMs / 1000)` 的**算术均值**（2.0 的旧口径），回答「单次调用平均多快」。长尾慢调用在总体吞吐里按耗时占比加权，所以两个数通常不相等；看板主值用总体吞吐，均值只放 tooltip。
  - 记录表每行仍是「本条 `outputTokens / (durationMs / 1000)`」，不参与总体口径。
- **缓存命中率** = `cacheReadTokens / promptTokens`，其中 `promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens`。
  - 汇总/按模型的主口径是**加权** `ΣcacheRead / ΣpromptTokens`；另给算术均值 `cacheHitRateMean` 与样本数 `cacheHitSamples`。
  - 分母为 0，或该记录**根本没有缓存字段**（老会话 / live 只采到 message）→ `null`（显示 `--`），这类记录**排除出样本**，绝不算成 0%。
- **成本**：`costUsd` 是**生效成本**——SDK `usage.cost.total > 0` 就用 SDK（`costSource: "sdk"`）；否则按价格表估算（`costSource: "estimate"`，看板显示 `≈`）；两者都无 → `null`（显示 `--`，不是 `$0`）。
  - 每条记录都保留 `costEstimateUsd`（估算值，供对照）与 `priceId`（命中的价格行）。
  - 汇总 `summary.cost = {amount, sdkAmount, estimatedAmount, estimateShare, pricedCalls, unpricedCalls}`，`amount = sdkAmount + estimatedAmount`，看板显示「其中估算 X%」。
  - 估算公式：`(input*pIn + output*pOut + cacheRead*pCacheRead + cacheWrite*pCacheWrite) / 1e6`（价都是 USD / 1M token）。缺 `cacheRead` / `cacheWrite` 价 → 按 `pIn` 计，并在 `priceNote` 标 `cacheRead≈input` / `cacheWrite≈input`；**绝不把缺价当 0**。
  - 价格行选择：`priceOverrides`（用户覆盖）→ 官方厂商行（`qwen*`→alibaba-cn/alibaba，`gemini*`→google，`grok*`→xai，`mimo*`→xiaomi，`deepseek*`→deepseek/alibaba*；匹配先剥 `provider/` 前缀与 `-high` / `-next` / `-1017` 这类变体后缀，层内按 models.dev > LiteLLM > OpenRouter 取）→ 多来源中位数 → `null`。所有候选可用 `GET /api/prices?model=` 枚举。

## HTTP 接口

全部 `GET` 返回 `{ ok: true, meta, … }`；出错也是 200 + `ok:false`（前端只画空态，不刷红）。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/summary?window=&model=` | 指标卡 + 按模型汇总。`window` = `today` / `7d` / `30d` / `all` |
| `GET /api/series?window=&model=&bucket=` | 趋势，`bucket` = `hour` / `day` |
| `GET /api/records?window=&model=&status=&page=&pageSize=` | 记录明细（分页，最新在前） |
| `GET /api/meta` | 账本规模、会话目录、上次回填（含 `coverage{imported,eligible,remaining}` 与 `importing`）、授权状态、价格表状态 |
| `GET /api/prices?model=` | 价格候选：全部候选行（来源 / 供应商 / 四项价）+ 选中的那行；不带 `model` 时列账本里出现过的模型 |
| `POST /api/prices/refresh` | 强制刷新价格表（失败保留旧快照，恒 200）|
| `POST /api/backfill` | 立刻跑一次增量回填（会清掉「停止导入」标记） |
| `POST /api/backfill/stop` | 停止自动续批导入 |
| `POST /api/grant` | 申请 `sessions` 目录读取（宿主弹窗），成功后自动回填 |

## 设置项

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `sessionsDir` | text | `""` | 会话目录绝对路径，留空 = 自动解析 |
| `backfillDays` | text | `"30"` | 回填天数（1–3650） |
| `backfillOnStart` | boolean | `true` | 激活时立刻回填一次 |
| `priceOverrides` | text | `""` | JSON，USD / 每 1M token，例如 `{"DeepSeek-V4-Flash-0731":{"input":0.44,"output":1.32,"cacheRead":0.088}}`；优先于一切来源 |

## 与 1.0 / 2.0 的关系

2.0 不读任何代理账本（`dbPath` / `autoDiscover` / `searchRoots` 设置项与 `net` 权限已删）。2.1 把「公开价格表估算」加回来，但**只用来补 SDK 没给的成本**，且只用 `host.fetch`（不需要 `net` 权限）：SDK 给了非 0 成本时永远用 SDK。详见 [CHANGELOG](CHANGELOG.md)。

## 开发

```bash
npm ci
npm test                     # vitest：账本/会话/聚合/实时/价格表/看板 单测（全部离线）
npm run check                # manifest 自检（字段、权限、版本、价格源白名单、残留检查）
npm run verify:sessions -- 7 # 拿真实的 ~/.pi/agent/sessions 跑一遍只读回填，并与独立复算对照
```

`verify-real-sessions.mjs` 的价格来源（估算成本用）：

- `--prices <目录>`（默认 `.cps-tmp`）：读该目录下已下载的 `modelsdev.json` / `litellm.json` / `openrouter.json`（形状同三个公开源），**不联网**；
- `--fetch`：现场抓三个源（慢，需要网络）；
- 都没有：只报 SDK 成本，估算那几栏显示 `--`。

脚本会打印调用数 / token / **SDK 成本 / 估算成本 / 估算占比** / 各模型**缓存命中率**。其中与参考值的偏差：**SDK 成本**做硬判定（> 2% 非 0 退出），调用数与 token 只做记录——参考值是固定的历史快照，滚动窗口会随新数据增长。

脚本里的参考值来自人工独立复算（Python 直扫会话 JSONL，不经过本插件代码）：它会区分「文件覆盖不足」「批次没扫完」「去重误合并」三种归因。参考值只在 7 天窗口有效，且是**历史快照**。

单测不触碰真实会话目录，也不联网：会话 fixture 与 `host.fs` 替身在 `tests/support/`，价格 fixture 在 `tests/fixtures/prices/`，`host.fetch` 一律打桩。

## 隐私

- 账本与价格缓存都在本机插件数据目录；会话目录只读。
- 出站请求只有价格表的三个固定 HTTPS 地址（`models.dev` / `raw.githubusercontent.com` / `openrouter.ai`），不携带任何用量数据，不上传任何内容。价格结果缓存 7 天，期间不再联网。

## License

MIT
