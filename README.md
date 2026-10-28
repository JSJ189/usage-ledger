# 用量账本 · usage-ledger

[![CI](https://github.com/JSJ189/usage-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/JSJ189/usage-ledger/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![manifest](https://img.shields.io/badge/manifest-2.0.0-informational)
![permissions](https://img.shields.io/badge/permissions-ui%20%7C%20storage%20%7C%20http%20%7C%20fs%3Aread-brightgreen)

pi-web-ui 界面插件：记录 **pi-web-ui 自己发出的每一次模型调用**，按模型统计调用数、成功率、TTFT 分位、单次耗时、输出速率、token 用量与**真实成本**（SDK 的 `usage.cost.total`，不估算）。底栏常驻「今日调用数 / TTFT p50」，点击打开看板。

数据全部来自本机 pi-web-ui 自己的运行：

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| TTFT | `host.onRunEvent` 的 `turn_first_token.durationMs` | **只能实时采集**；历史回填的条目没有 TTFT |
| token（输入/输出/缓存读/缓存写/推理） | 会话 JSONL 的 `message.usage` | 可回填历史 |
| 真实成本 USD | 会话 JSONL 的 `message.usage.cost.total` | 与宿主显示的数字同源 |
| 单次调用耗时 | 会话 JSONL 的 `message.durationMs`；无则用 turn 时长 | 可回填历史 |
| 模型 / provider / 停止原因 | 会话 JSONL + `message` 运行事件 | 两路合并去重 |

## 安装

市场一键安装（pi-web-ui「添加插件」里搜「用量账本」），或命令行：

```bash
pi-web-ui install JSJ189/usage-ledger
```

安装后重启/重扫插件，底栏出现 📊「用量账本」，点击打开看板。

要求：pi-web-ui（插件 `apiVersion: 2`）+ Node ≥ 22.13。**不需要**任何第三方代理软件或数据库。

## 权限说明（重要）

`manifest.permissions = ["ui", "storage", "http", "fs:read"]`。

- `fs:read`：读 `~/.pi/agent/sessions/**/*.jsonl`，这是**唯一**能拿到逐轮 token 与真实成本的地方（宿主的 `UiMessage` 不带 token）。它会让 registry 风险等级从 LOW 升到 **MEDIUM，安装时需人工确认**——这是拿到 token 数据的必要代价。插件对该目录**只读**，绝不写入；路径可用设置项 `sessionsDir` 覆盖，首次访问由宿主弹窗授权（`host.fs.requestAccess`）。
- `http`：插件自己的看板数据路由（`host.route("/api/…")`）。**没有网络请求**：不抓价目表、不访问任何外部主机，`netAllowlist` 已删除。
- `storage` / `ui`：底栏徽标与看板视图。

不给 `fs:read`（或用户拒绝授权）也能用：只采实时事件，token 与成本显示 `--`，底栏写「仅实时」，看板顶部给「授权并导入历史」按钮。

## 账本存在哪

`<host.dataDir>/ledger.jsonl`（一行一条记录，append-only，崩溃最多丢最后一行）。

- 每条记录：`ts | conversationId | projectDir | provider | model | thinkingLevel | inputTokens | outputTokens | cacheReadTokens | cacheWriteTokens | reasoningTokens | totalTokens | costUsd | durationMs | ttftMs | stopReason | status | source(live|backfill) | sources[]`。
- 去重：`sessionId + entryId`（回填天然唯一）或 `ts + model + provider`（实时与回填的交集，会话里 `message.timestamp` 与 `UiMessage.timestamp` 是同一个 SDK 值）。同一调用两边各来一次会**合并成一条**，不会翻倍。
- 回填进度存在 `<host.dataDir>/backfill-state.json`：每个文件的 `{mtime, size, offset, unit, ctx}`，下次只读新增字节。

## 回填（导入历史）

- 位置：设置项 `sessionsDir` → `$PI_CODING_AGENT_DIR/sessions` → `~/.pi/agent/sessions`。
- 范围：只回填 `mtime` 在 `backfillDays`（默认 30，夹取 1–3650）内的文件；单次最多 200 个文件（按 mtime 新→旧）、单文件超过 100MB 跳过并记日志；每处理一个文件让出一次事件循环。
- 触发：激活时一次（`backfillOnStart` 可关）、每 5 分钟一次增量、看板「回填」按钮、授权成功后立刻一次。
- 只读：全程走 `host.fs` 的跨目录读接口，插件不会写这个目录。

## 看板

- 指标卡：调用数、成功率、失败/未收全、TTFT p50/p90/p99（带**样本数**与**覆盖率**）、平均延迟、平均 `tok·s⁻¹`、token 明细、真实成本。
- **按模型汇总**（用户第一诉求）：每行一个模型，调用数、成功率、TTFT p50/p90、平均延迟、`tok·s⁻¹`、token、成本、占比；点行 = 只看该模型。
- 趋势：按小时 / 按天，两张手写 SVG 图（调用数 + TTFT p90）。
- 记录明细：时间 / 模型 / provider / 思考档 / token / 缓存 / 首字 / 耗时 / `tok·s⁻¹` / 成本 / 状态；状态筛选、分页、点行展开拆分与来源。

## 口径

- **TTFT** = `turn_start` → 第一个流式包（`Date.now() - turnStartAt`）。**历史回填的条目没有 TTFT**：看板必须显示覆盖率，不能把「样本少」当成「很快」。
- **成功率** = `status === "ok"` / 全部调用。`failed` = `status === "error"`；`incomplete` = 没收到 `message` 事件或会话里没有 `usage` 块（老会话 / 中断），这类记录 token 与成本不可信。
- **平均 `tok·s⁻¹`** = 每次调用 `outputTokens / (durationMs / 1000)` 的均值，只算 `durationMs > 0 && outputTokens > 0`（除零样本排除）。
- **成本** = `usage.cost.total` 求和，不估算、不乘系数；没有成本字段的调用单独计 `unpricedCalls`，金额显示 `--` 而不是 `$0`。

## HTTP 接口

全部 `GET` 返回 `{ ok: true, meta, … }`；出错也是 200 + `ok:false`（前端只画空态，不刷红）。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/summary?window=&model=` | 指标卡 + 按模型汇总。`window` = `today` / `7d` / `30d` / `all` |
| `GET /api/series?window=&model=&bucket=` | 趋势，`bucket` = `hour` / `day` |
| `GET /api/records?window=&model=&status=&page=&pageSize=` | 记录明细（分页，最新在前） |
| `GET /api/meta` | 账本规模、会话目录、上次回填、授权状态 |
| `POST /api/backfill` | 立刻跑一次增量回填 |
| `POST /api/grant` | 申请 `sessions` 目录读取（宿主弹窗），成功后自动回填 |

## 设置项

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `sessionsDir` | text | `""` | 会话目录绝对路径，留空 = 自动解析 |
| `backfillDays` | text | `"30"` | 回填天数（1–3650） |
| `backfillOnStart` | boolean | `true` | 激活时立刻回填一次 |

## 与 1.0 的破坏性差异

2.0 不再读任何代理账本、不抓价目表、不估算成本，`dbPath` / `autoDiscover` / `searchRoots` / `cacheTtlSec` / `priceOverrides` 设置项已删除，`net` 权限已删除。详见 [CHANGELOG](CHANGELOG.md)。

## 开发

```bash
npm ci
npm test                     # vitest：账本/会话/聚合/实时/看板 单测
npm run check                # manifest 自检（字段、权限、版本、残留检查）
npm run verify:sessions      # 拿真实的 ~/.pi/agent/sessions 跑一遍只读回填，打印条数与总成本
```

单测不触碰真实会话目录：会话 fixture 与 `host.fs` 替身在 `tests/support/`。

## 隐私

所有数据都在本机：账本写在自己的 data 目录，会话目录只读，**没有任何出站网络请求**（插件不含 `net` 权限）。

## License

MIT
