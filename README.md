# 用量账本 · usage-ledger

[![CI](https://github.com/JSJ189/usage-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/JSJ189/usage-ledger/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![manifest](https://img.shields.io/badge/manifest-1.0.0-informational)
![permissions](https://img.shields.io/badge/permissions-ui%20%7C%20http%20%7C%20net%20%7C%20storage-brightgreen)

pi-web-ui 界面插件：**只读**聚合本机代理的 SQLite 用量账本，把请求数、成功率、TTFT 分布、时延、输出速率、token 用量、路由/模型/provider 分布与**估算成本**画成一个看板，底栏常驻「今日请求数 / TTFT p50」。

- 账本只读：`node:sqlite` 的 `readOnly: true` + `PRAGMA query_only`，不发任何写语句。
- 数据不出本机：只有聚合后的数字进浏览器；价目表从三个公开目录拉取（见「网络」）。
- 账本位置自适应：设置项 → 环境变量 → pi 代理配置端口 → 已知安装位置 → 搜索根（见下）。
- 兼容性：EasyCLIProxyAPI 默认布局直接可用；任意兼容 `usage_events` schema 的账本也能用。

## 安装

市场一键安装（pi-web-ui「添加插件」里搜「用量账本」），或命令行：

```bash
pi-web-ui install JSJ189/usage-ledger
```

安装后重启/重扫插件，底栏出现 📊「用量账本」，点击打开看板。

要求：pi-web-ui（插件 `apiVersion: 2`）+ Node ≥ 22.13（`node:sqlite`）。

## 数据源发现顺序

插件按固定顺序找 `usage.db`，**每一步都写一条 `info` 日志**（服务端日志里搜 `[usage-ledger]`）：

1. **设置项 `dbPath`**（最高优先）。必须是绝对路径、以 `.db` 结尾、不以 `..` 段穿越、不是 UNC 共享、且文件存在。填错就报错，**不会**静默回落到别的库。
2. **环境变量 `CLIPROXY_USAGE_DB`**。同样要满足上面的校验；不可用时记一条日志并继续下一步。
3. **pi 代理配置的端口**：读 `~/.pi/agent/cliproxyapi.json`（目录可用 `PI_CODING_AGENT_DIR` 覆盖）里的 `baseUrl`，取出端口（如 `http://127.0.0.1:8317` → `8317`），在候选目录里按端口找 `usage-records/usage.db`（`<候选>/8317/usage-records/usage.db` 与 `<候选>/usage-records/usage.db`）。
4. **已知安装位置**：逐个 `existsSync`，不递归。
   - Windows：`%LOCALAPPDATA%\CLIProxyAPI`、`%APPDATA%\CLIProxyAPI`、`%USERPROFILE%\CLIProxyAPI`（同时试 `EasyCLIProxyAPI` 目录名）。
   - macOS / Linux：`~/.local/share/cliproxyapi`、`~/CLIProxyAPI`、`~/.config/cliproxyapi`、`/opt/cliproxyapi`。
5. **搜索根扫描**：只 `readdir` **两层**，绝不递归整盘。
   - Windows：所有 `existsSync("<盘>:\\")` 为真的盘符根，匹配 `<盘>:\*CLIProxyAPI*\usage-records\usage.db` 与 `<盘>:\*CLIProxyAPI*\*\usage-records\usage.db`。
   - macOS / Linux：`~/.local/share`、`~`、`/opt`、`/usr/local`（`/opt`、`/usr/local` 下不要求目录名含 `CLIProxyAPI`）。
   - 单层目录条目超过 **500** 个直接跳过并记日志（防超大盘拖住事件循环）。
   - 命中多个时：路径里含代理端口者优先 → 目录名版本号高者优先 → `usage.db` mtime 新者优先。
6. **都找不到** → 结构化空态 `{ ok:false, code:"db-not-found", candidates:[...], hint:"在设置里填 usage.db 绝对路径" }`。看板展示明确文案 + **已尝试的候选路径列表**（可展开），底栏显示 `--`，**不抛错、不静默显示 0 数据**。

补充规则：

- 发现结果缓存 **10 秒**（`PATH_CACHE_MS`）；失败进入 **30 秒冷却**，期间复用上次结果，不产生重试风暴。
- 设置项 `autoDiscover`（默认 `true`）关掉第 3、4、5 步，只认 `dbPath` 与环境变量 —— 多实例或想固定账本时更可预测。
- 设置项 `searchRoots`（如 `D:\;E:\`）**整体覆盖**第 5 步的默认搜索根。

## 指标口径

| 指标 | 口径 |
| --- | --- |
| 请求数 | 窗口内 `usage_events` 行数 |
| 失败率 | `failed = 1 OR canceled = 1` 计**一次**（并集，取消通常已被标失败，不重复计数） |
| TTFT p50 / p90 | **代理侧**「收到请求 → 上游首包」。Nearest-rank 分位，只统计 `ttft_ms > 0` 的行（`NULL` 与 `0` 不参与） |
| 时延 avg | `latency_ms` 均值（全行，含失败行） |
| tok/s | `output_tokens / ((latency_ms - ttft_ms) / 1000)`，只有 `latency_ms > ttft_ms` 且 `output_tokens > 0` 的行参与 |
| 今日 | 按**进程本地时区**的当日 00:00 起（不是 UTC 日界） |
| 成本 | **按公开目录价的估算**（USD），显示价源与快照时间；未知模型价一律 `null`（界面标「未知价」），绝不冒充 0 |

### TTFT 与客户端 TTFT 不是一回事

本插件的 TTFT 是**代理侧**：代理收到请求 → 上游返回首包。`response-speed` 插件给的是**客户端** TTFT：pi-web-ui 发出请求 → 收到首个 token。两者相差本地网络与队列时间，看板上不要混用同一个基线。

### 成本是估算，不是账单

- 价目表来源三处：`models.dev`、LiteLLM（`raw.githubusercontent.com`）、OpenRouter，按「有价且更贴近账本」的优先级合并；跨源价格有分歧时优先选价并打上多源标记（`multiSource`）。
- 金额 = `可计费 input × 输入价 + cache_read × 缓存读价 + 可计费 output × 输出价 + cache_creation × 缓存写价`，单位 USD / 1M tokens。
- `cache_read` 会先 **clamp 到 `input`**（防御性：真库上从未出现 `cache_read > input`，见下）。
- 上游只给 `total_tokens` 而 `output_tokens` 不含思考 token 时，可计费输出由 `total_tokens` 的形状推断（`in+out` / `in+out+reasoning` / `in+out+reasoning+cache`），推断依据会随行返回。
- 没有价源的模型 → `costAmount = null`，同时给出「未知价请求占比」。**估算值不能当账单用**：代理侧折扣、阶梯价、批处理价都不在公开目录里。

### 真库依据（`cache_read ⊆ input`、`reasoning ⊆ output`）

以下数字来自本机真实账本（EasyCLIProxyAPI v0.2.25，49 926 行，覆盖 2026-08-18 → 2026-10-28），只读 SQL 统计，只作口径依据：

| 断言 | 实测（49 926 行） | 结论 |
| --- | --- | --- |
| `cache_read_tokens ⊆ input_tokens` | 0 行违反；`sum(cache_read)=5.41B` ≤ `sum(input)=6.02B`；41 732 行 `cache_read > 0` | **成立**。仍保留 `min(input, cache_read)` 钳制，防别的账本不守约定 |
| `reasoning_tokens ⊆ output_tokens` | **3 110 行（6.2%）违反**；这些行 `sum(output)=553 246` 而 `sum(reasoning)=2 216 518`，全部是 antigravity 的 `gemini-3.x-flash-high`（例：`output=73, reasoning=1069`） | **形态相关，不能说笼统的「不成立」**：这 3 110 行**全部**属于 `total = input + output + reasoning` 形状，且全部落在 `2026-08-18 → 2026-09-14`（最近 30 天窗口内为 0 行）。所以按下面的形状判定计费**不会漏计**；`output` 字段本身不包含思考部分，思考 token 单列 |
| `total_tokens` 的形状 | `total = input + output` 41 644 行；`= input + output + reasoning` 14 018 行；`= input + output + cache_read` 7 309 行；`= input + output + reasoning + cache_read` 5 240 行；`total = 0` 4 158 行 | ⚠️ **各形状按谓词判定、互相重叠，不是互斥划分**（前两行占比相加会超过 100%）。所以不能用 `total_tokens` 当分母，只能**按行**推断可计费输出 |
| `ttft_ms = 0` | 3 222 行（含 0 与缺失语义混用） | 0 不计入 TTFT 分位，否则 p50 会被拉成 0 |

数字会随账本增长变化，上表是撰写本 README 时的快照；复跑命令：

```bash
node scripts/verify-real-db.mjs --db "E:/EasyCLIProxyAPI-v0.2.25-Windows-amd64/usage-records/usage.db"
```

## 隐私与安全

**读了什么**：只读 `usage.db` 的 `usage_events` 表，取时间、延迟、TTFT、状态、provider/model/endpoint/executor、user_agent、各 token 计数。

**下发了什么**：只有聚合后的数字（计数、分位、均值、token 合计、成本估算）与事件明细表；明细列**不含** `api_key_hash`、`api_key_display`、`auth_index`、`client_ip`、`x_forwarded_for`、`request_id`、`failure_body`、邮箱等敏感字段（有单测锁死）。

**绝不做什么**：

- 不写账本：连接是 `readOnly: true`，并额外 `PRAGMA query_only = 1`；代码里没有任何 `INSERT/UPDATE/DELETE/DDL/VACUUM`，也没有 `writeFile` 类调用（单测扫描全量源码兜底）。
- 不写账本本体：不建临时表、不改 `journal_mode`、不发任何 DDL/DML。已传 `readOnly: true` 且置 `PRAGMA query_only=1`，写语句会被 SQLite 直接拒绝。
- **会产生的唯一副作用**：只读打开一个 WAL 模式的库时，SQLite 会在一旁创建 0 字节的 `<db>-wal` 与 `<db>-shm`（实测 32 KB），**关闭连接不会删掉它们**，等代理进程下次 checkpoint 自行回收。账本本体 `usage.db` 的 size 与 mtime 全程不变（已实测）。这不是本插件写入的数据。
- 不经过宿主 `fs` 能力：插件直接 `import("node:fs")` 做只读目录枚举与 `readFile`（不走 `host.fs.*`），因此 `manifest.permissions` 里**没有** `fs`。这也是它保持 LOW 风险、能进自动合并通道的原因。
- 不上传任何数据：没有遥测、没有回传、没有账号体系。价格表是**下载**：只从 `models.dev`、`raw.githubusercontent.com`（LiteLLM）、`openrouter.ai` 三个白名单域名拉公开价目表，不上传账本、token 或任何本地数据。
- 不改宿主 DOM：看板只在自己创建的容器内渲染，样式类名统一 `.cps-` 前缀，卸载时清定时器与监听。

**网络**：仅拉公开价目表，host 侧白名单只允许 `models.dev`、`raw.githubusercontent.com`、`openrouter.ai` 三个域；请求体里没有任何账本数据。

## 兜底与排障

| 现象 | 原因与处理 |
| --- | --- |
| 看板显示「未找到账本」+ 候选列表 | 发现链没命中。展开列表看试过哪些路径；在设置里填 `dbPath` 绝对路径，或设 `CLIPROXY_USAGE_DB` |
| 底栏一直 `--` | 同上；或账本被别的进程独占（`SQLITE_BUSY`，30 秒冷却后自动重试） |
| 「账本缺少 usage_events 表」 | 指定的 `.db` 不是用量账本，换文件 |
| 成本显示「未知价」 | 该模型不在三个公开目录里；用 `priceOverrides` 手填，或等目录更新 |
| 数字比代理面板少 | 默认只算「今日」（本地日界）；切到 7d / 30d 复核 |
| 想看发现过程 | 服务端日志搜 `[usage-ledger]`，每一步都有 `info` |

## 开发与测试

```bash
npm i          # 只装 vitest + jsdom
npm test       # vitest run（单测，离线）
npm run check  # manifest 自检（字段 / 权限白名单 / 版本一致 / 无 >32KB 价目原文）
```

- `index.mjs`：服务端（只读连接、五维聚合、4 个 GET + 1 个 POST、缓存与冷却、发现链）。
- `lib/prices.mjs`：三源价目表（归一化、effort 后缀剥离、provider 映射、tiers、多源分歧、未知价 `null` 语义）。
- `client/entry.mjs`：看板（指标卡、双 SVG 图、路由表、事件表、未知价与多源标记）。
- `tests/support/mock-host.mjs`：最小宿主替身（只对齐本插件用到的 API）。
- `tests/support/sandbox-deps.mjs`：把发现链的目录枚举锁在临时目录，单测不依赖开发机装了什么。
- `docs/DEBATE.md`、`docs/REVIEW.md`：开发史（评审意见与逐条裁定），实现口径变更的来由都在里面。

单测覆盖的硬约束：分位边界（n=1..12 / 全 NULL / 全 0）、本地日界、除零、`failed ∪ canceled` 并集、账本缺失/被锁/被换、`dbPath` 攻击表（相对路径 / `..` / UNC / 非 `.db`）、路由参数注入、明细敏感列零出现、发现链各步与结构化空态、`.cps-` 样式隔离与定时器卸载。

## 许可

MIT © 2026 JSJ189
