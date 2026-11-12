# 用量账本 · usage-ledger

[![CI](https://github.com/JSJ189/usage-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/JSJ189/usage-ledger/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![manifest](https://img.shields.io/badge/manifest-3.0.0-informational)
![permissions](https://img.shields.io/badge/permissions-ui%20%7C%20http%20%7C%20fs%3Aread-brightgreen)

pi-web-ui 界面插件：记录 **pi-web-ui 自己发出的每一次模型调用**，按模型 / 供应商 / 项目统计调用数、成功率、TTFT 与总耗时分位、加权吞吐（`tok·s⁻¹`）、缓存命中率、token 用量与**成本**。成本优先用 SDK 记录的 `usage.cost.total`；网关不回填时按公开价格表估算，并把「SDK 成本 / 估算 / 缺价」分开展示。底栏常驻「今日调用数 / TTFT p50」，点击打开看板。

3.0 的关键差别：**范围切换是毫秒级的**。历史数据在后台线程导入进 SQLite，读路径只查预聚合 rollup，导入期间看板照常可用。

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| TTFT | `host.onRunEvent` 的 `turn_first_token.durationMs` | **只能实时采集**；历史导入的条目没有 TTFT（看板显示覆盖率） |
| token（输入/输出/缓存读/缓存写/推理） | 会话 JSONL 的 `message.usage` | 可导入历史 |
| SDK 成本 USD | 会话 JSONL 的 `message.usage.cost.total` | 与宿主显示的数字同源。**实测本机网关 150,714 行里 92.5% 是 `0`**，所以 `0` 按「网关未回填」处理，走价格表估算；只有 `> 0` 才记为 `sdk` |
| 估算成本 USD | 公开价格表（models.dev / LiteLLM / OpenRouter） | 仅当 SDK 未回填（`0`/缺失）时生效，缓存 7 天，带 `price_version` |
| 单次耗时 | `turn_start → turn_end`（实时）或 `message.durationMs`（历史） | `gen_ms = e2e − ttft` |
| 模型 / provider / 项目 / 停止原因 | 会话 JSONL + `message` 事件 | 两路按「确定性身份」合并，不靠时间窗猜 |

## 安装

市场一键安装（pi-web-ui「添加插件」里搜「用量账本」），或命令行：

```bash
pi-web-ui install JSJ189/usage-ledger
```

安装后重扫插件（或重启 pi-web-ui），底栏出现 📊「用量账本」，点击打开看板。

要求：pi-web-ui（插件 `apiVersion: 2`）+ **Node ≥ 22.5**（用内置 `node:sqlite`，不需要任何第三方数据库或代理软件）。Node 版本不够时插件不崩，看板会明确显示「统计不可用（no-sqlite）」。

## 权限说明（重要）

`manifest.permissions = ["ui", "http", "fs:read"]`。

- `fs:read`：读 `~/.pi/agent/sessions/**/*.jsonl`，这是**唯一**能拿到逐轮 token 与真实成本的地方（宿主的 `UiMessage` 不带 token）。它会让 registry 风险等级从 LOW 升到 **MEDIUM，安装时需人工确认**——这是拿到 token 数据的必要代价。
  插件对该目录**只读**（`createReadStream` 增量读，绝不写入）；路径可用设置项 `sessionsDir` 覆盖。3.0 起不再需要目录授权弹窗（插件与宿主同进程，直接用 `node:fs` 读），`POST /api/v3/grant` 仅作兼容入口保留。
- `http`：看板数据路由（`host.route("/api/v3/…")`）+ 价格表抓取（`host.fetch`，只有三个固定 HTTPS 主机）。**不访问任何用户数据主机**，不上传任何内容。
- `ui`：底栏徽标与看板视图。

## 账本存在哪

```
<dataDir>/plugin-data/usage-ledger/          # dataDir 默认 ~/.pi-web
├── ledger.sqlite        # 主库（WAL）：明细 calls + 预聚合 rollup_hour / rollup_day
├── ledger.sqlite-wal
├── import-state.json    # 导入游标与进度（≤200KB）
├── prices.json          # 价格表快照（7 天 TTL）
└── backups/             # 迁移/压实前快照
<dataDir>/ledger.jsonl   # 2.x 遗留账本：**只读保留**，首次启动自动迁移进 SQLite，不删
```

- 账本**只在本机**，没有任何上传。
- 卸载插件会删除 `plugin-data/usage-ledger/`（宿主行为），**卸载前请先用看板的「导出 CSV」备份**。
- 需要备份时直接拷 `ledger.sqlite`（先让 pi-web-ui 空闲几秒，或同时拷 `-wal`）。

## 导入（历史会话）

- 激活后在 **worker 线程**里增量导入，主线程不被占用（实测导入期间主线程单次阻塞 ≤16ms）。
- 只导入「修改时间在最近 N 天」的会话（设置项 `backfillDays`，默认 30）。
- 看板顶部有进度（已导入/总数、预计剩余）与 **暂停 / 继续 / 取消**；接口全部立即返回，停止粒度到「批」。
- 幂等：同一会话重复导入不会重复计账（`entry_key` 唯一索引）。
- 活跃会话不断增长不会让导入「永远跑不完」：只看本批有没有净新增，无进展就指数退避（100ms → 2s → 10s → 60s → 300s）。

## 看板

- 范围：今日 / 24h / 7 天 / 30 天 / 90 天 / 全部 / 自定义；粒度 `自动 | 5m | 1h | 1d`（自动保证 ≤720 点）。
- KPI：调用数、成功率、失败/未收全、TTFT p50/p90/p99（带覆盖率）、总耗时 p50/p90、加权 tok·s⁻¹、缓存命中率、token 合计、成本（含估算占比与缺价计数）。
- 趋势图：调用/失败柱 + TTFT/耗时线，十字准星 tooltip（显示桶区间与口径）、图例可点隐藏系列、框选放大。
- 排行：按模型 / 按项目 Top-N（调用数、成本、tok/s、p95）。
- 明细表：按键分页 + 本地排序（表头会明示「仅当前页」）+ 列显隐（记住偏好），点行看 token/成本拆解。
- 导出：服务端流式 CSV（全量，不再有 5000 行上限），末行附口径脚注。
- 状态进 URL：`#ul?range=30d&gran=1h&model=all&status=all&view=chart`（刷新/分享后仍停在同一个视图）。
- 顶栏真值行：`起 → 止 · N 次 · 粒度 · 数据截至 HH:MM:SS`；时区显示在 `meta.range.timezone`。

## 口径

| 指标 | 定义 |
| --- | --- |
| `calls` | 有应答的调用数，**不含** `aborted`（用户取消）与 `incomplete`（没收到 usage 块） |
| 成功率 | `ok / calls`（分母排除 aborted / incomplete） |
| 状态六态 | `ok` `client_error(4xx)` `rate_limited(429)` `provider_error(5xx/超时)` `aborted` `incomplete` |
| TTFT | `turn_start → 第一个流式包`；只有实时采集有，**看板必须显示覆盖率**，不能把「样本少」伪装成「很快」 |
| 分位 | 直方图近似（136 桶，1ms–4h 对数等距 + 桶内插值），典型误差 <2%、最坏单桶 6.3%，UI 标 `≈` |
| 吞吐 | `Σ output / Σ gen_ms`（加权，主值）；另给「每次中位」 |
| 缓存命中率 | `Σ cache_read / Σ(cache_read + cache_write + 非缓存 input)`；没有缓存字段的记录**排除出样本**，不按 0% 计 |
| 成本 | 四态：`sdk`（网关报的 `> 0`）/ `estimate`（价格表估算）/ `unpriced`（缺价，金额里排除并标「≥ 下限」）/ 未采集（四项 token 全缺）。`cost.total = 0` 归入未回填走估算——实测网关 92.5% 的行都是 0，把 0 当真值会让成本全变 0。改价不改历史（`price_id + price_version`） |
| 时区 | 存 UTC 毫秒，展示与分桶按本地时区；看板显示实际时区 |

## HTTP 接口（v3）

全部 `200 + {ok:boolean}`，失败带 `code`（`no-sqlite` / `no-fs-read` / `importing` / `internal` / `request-failed`），不抛 500。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/v3/overview` | KPI + 趋势 + TopN + 覆盖度 + 价格状态（一次查询驱动整个看板） |
| GET | `/api/v3/records` | 明细（keyset 游标分页，`limit ≤ 200`） |
| GET | `/api/v3/record/:id` | 单条详情 |
| GET | `/api/v3/meta` | schema/rollup 版本、状态目录、降级原因、导入器与价格状态 |
| GET | `/api/v3/import/status` · `import/errors` | 导入进度 / 分类失败清单 |
| POST | `/api/v3/import/start` · `pause` · `resume` · `cancel` · `recalc?day=` | 全部立即返回，后台推进 |
| GET | `/api/v3/export?format=csv\|json` | 流式导出（带口径脚注） |
| POST | `/api/v3/prices/refresh` | 强制刷新价格表 |
| POST | `/api/v3/grant` | 兼容入口（3.0 起不再需要目录授权） |

2.x 的 `/api/summary|series|records|meta` 已移除，前端接口与看板同版本一起替换。

## 设置项

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `sessionsDir` | text | 空 | 会话 JSONL 目录；空 = `$PI_CODING_AGENT_DIR/sessions` → `~/.pi/agent/sessions` |
| `backfillDays` | text | `30` | 只导入最近 N 天有变动的会话（1–3650） |
| `autoImport` | boolean | `true` | 是否在后台线程自动增量导入 |
| `backfillOnStart` | boolean | `true` | 激活时立刻跑一轮导入 |
| `priceOverrides` | text | 空 | 价格覆盖（USD / 1M token），JSON |

## 与 2.x 的关系

- 3.0 是**架构重写**：存储（JSONL → SQLite）、读路径（全量扫 → 预聚合 rollup）、导入（主线程同步 → worker 线程）、客户端（整页重绘 → 差分渲染 + URL 状态）。
- 数据不丢：`~/.pi-web/ledger.jsonl` 首次启动自动迁移，原文件保留；迁移幂等，可重复跑。
- 完整的修复清单与实测数字见 [CHANGELOG](CHANGELOG.md)。

## 开发

```bash
npx vitest run                 # 单测（v2 数据层 + v3 全部模块）
npm run bench                  # v3 端到端基准：15 万条入库 / 各窗口聚合 / 一致性校验
npm run check                  # manifest + 交付文件 + 依赖自检
```

接口契约（改动前必读）：[`docs/V3-CONTRACT.md`](docs/V3-CONTRACT.md)。

## 隐私

账本、价格快照、导入状态全部写在 `<dataDir>/plugin-data/usage-ledger/`，不上传任何数据；联网只用于抓取三个公开价格表（models.dev / LiteLLM 原始 JSON / OpenRouter），请求里不含任何本地信息。

## License

MIT
