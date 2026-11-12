# usage-ledger v3 实施合同（唯一接口真相源）

> 状态：活文档 | 最后核实 2026-11-12
> 本文件是 v3 重构的**唯一接口约定**。任何子代理实现都必须与本文一致；发现本文有问题先改本文再改代码。
> 方案与量化依据：`C:/Users/11373/Desktop/omp_optimize/用量账本重构/报告/用量账本v3重构方案.md`

<!-- TOC -->
## 目录

- 一、硬约束（违反即返工）
- 二、目录与文件归属
- 三、数据模型（schema）
- 四、模块导出契约
- 五、HTTP API v3（服务端 ↔ 客户端）
- 六、客户端契约
- 七、验收与自检命令
- 八、相关

---

## 一、硬约束（违反即返工）

1. **主线程禁止重活**：任何单个同步操作 ≤16ms。禁止在主线程 `readFileSync` 大文件、禁止遍历 1 万条以上记录做聚合、禁止 `JSON.parse` >2MB 文本。
2. **热路径禁止 `host.getSettings()`**：设置只在 `activate()` 与 `onSettingsChanged` 时读取，之后用内存快照。理由：宿主实现每次 2 次 `readFileSync`（42µs），乘记录数就是 15 秒。
3. **禁止对无界数组用展开/apply**：`Math.max(...arr)`、`push(...arr)`、`fn(...arr)` 一律改循环（>12 万元素必抛 RangeError）。
4. **写路径批量 + 单写者**：全部明细写与 rollup upsert 都在 worker 内、单事务 ≤2000 行；主线程只读。
5. **读路径只读 rollup**（内存）+ 明细分页（SQLite 索引 + keyset）。禁止为了回答 KPI 去扫明细表。
6. **分位不许存算好的 p95**：只存对数直方图，读取时合并求值。
7. **零新增运行时依赖**：只用 Node 内建（`node:sqlite`、`node:fs`、`node:worker_threads`、`node:path`、`node:os`）。URL 抓取用 `host.fetch`。
8. **客户端所有模块必须住在 `client/` 内**（宿主只服务该子树，越界 import 会让整个 bundle 不执行）。
9. **状态目录**：`<host.dataDir>/plugin-data/usage-ledger/`（`host.dataDir` 是 `~/.pi-web`，不是插件目录）。用 `node:fs` 直写，不用 `host.fs.writePath`（会触发目录授权弹窗）。
10. **`lib/v2` 兼容**：旧的 `lib/ledger.mjs` / `lib/sessions.mjs` / `lib/live.mjs` / `lib/metrics.mjs` **保留不删**（迁移器要用 `lib/sessions.mjs` 的解析语义做对照），但 `index.mjs` 不再调用它们。

---

## 二、目录与文件归属

| 文件 | 归属 | 说明 |
|---|---|---|
| `lib/v3/paths.mjs` | A | 目录解析 |
| `lib/v3/schema.mjs` | A | DDL + schema 版本 |
| `lib/v3/store.mjs` | A | SQLite 读写（读=主线程，写=worker） |
| `lib/v3/hist.mjs` | A | 对数直方图 |
| `lib/v3/metrics.mjs` | A | 纯口径函数（成功率/吞吐/缓存/成本/分位） |
| `lib/v3/rollup.mjs` | A | 内存 rollup 索引 + 聚合（KPI/series/topN） |
| `lib/v3/parser.mjs` | A | 会话 JSONL 行解析（纯函数） |
| `lib/v3/ingest.mjs` | A | 导入核心（在 worker 内跑） |
| `lib/v3/ingest-worker.mjs` | A | worker 入口（线程） |
| `lib/v3/importer.mjs` | A | 主线程侧控制器（起 worker / 收增量 / 进度 / 暂停取消） |
| `lib/v3/migrate.mjs` | A | v2 `ledger.jsonl` → SQLite 一次性迁移 |
| `lib/v3/prices.mjs` | A | 价格表（沿用 v2 逻辑 + 设置快照，**热路径零文件读**） |
| `index.mjs` | 主对话 | 路由 + 徽标 + 生命周期 + 降级 |
| `client/*.mjs` | B | 新看板（可多文件，全在 `client/` 内） |
| `tests/v3/**`、`tests/fixtures/v3/**` | C | 黄金数据 + 单测 |
| `docs/V3-CONTRACT.md`、`manifest.json`、`package.json`、`README.md`、`CHANGELOG.md` | 主对话 | 文档与元数据 |

**禁止**修改不属于自己归属的文件。需要别人改，写在汇报里。

---

## 三、数据模型（schema）

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);           -- schema_version / rollup_version / tz / migrated_at

CREATE TABLE IF NOT EXISTS refs (                                       -- 模型/供应商/项目/会话文件 统一字典
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  UNIQUE (kind, name)
);

CREATE TABLE IF NOT EXISTS calls (
  id          INTEGER PRIMARY KEY,          -- rowid，稳定、可用于 keyset 去重
  ts          INTEGER NOT NULL,             -- UTC 毫秒
  entry_key   TEXT,                         -- 'src:<refId>|entry:<entryId>'，回填幂等键；live 记录为 NULL
  conv_id     TEXT,
  src_id      INTEGER, model_id INTEGER, provider_id INTEGER, project_id INTEGER,
  status      TEXT NOT NULL,                -- ok|client_error|rate_limited|provider_error|aborted|incomplete
  origin      TEXT NOT NULL,                -- live|backfill|both
  in_tok INTEGER, out_tok INTEGER, cache_read INTEGER, cache_write INTEGER,
  reasoning_tok INTEGER, total_tok INTEGER,
  cost_sdk REAL, cost_est REAL, cost_source TEXT,   -- sdk|estimate|unpriced
  price_id TEXT, price_version INTEGER,
  ttft_ms INTEGER, gen_ms INTEGER, e2e_ms INTEGER,
  stop_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_calls_entry ON calls(entry_key) WHERE entry_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_calls_ts ON calls(ts DESC);
CREATE INDEX IF NOT EXISTS ix_calls_model_ts ON calls(model_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_calls_status_ts ON calls(status, ts DESC);

CREATE TABLE IF NOT EXISTS rollup_hour (     -- 只存可合并量
  bucket INTEGER NOT NULL,                   -- 本地时区对齐到小时起点（UTC 毫秒值）
  model_id INTEGER NOT NULL DEFAULT 0, provider_id INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  calls INTEGER NOT NULL, in_tok INTEGER, out_tok INTEGER, cache_read INTEGER, cache_write INTEGER,
  reasoning_tok INTEGER, total_tok INTEGER,
  cost_sdk REAL, cost_est REAL, unpriced INTEGER,
  e2e_sum INTEGER, e2e_n INTEGER, gen_sum INTEGER, gen_n INTEGER,
  out_tok_tput INTEGER,     -- Σ out_tok（加权吞吐的分子，便于按维度重算）
  rate_sum REAL, rate_n INTEGER,   -- 每次 tok/s 的算术和与样本数（tokPerSecMean）
  cache_n INTEGER,          -- 有缓存字段的记录数（cacheHitRate 的样本口径，不能按 0 计）
  ttft_hist BLOB NOT NULL, e2e_hist BLOB NOT NULL,   -- uint32 × 136 = 544B/个
  PRIMARY KEY (bucket, model_id, provider_id, project_id, status)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS rollup_day (      -- 同结构，day 用 'YYYY-MM-DD'（本地）
  day TEXT NOT NULL,
  model_id INTEGER NOT NULL DEFAULT 0, provider_id INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  calls INTEGER NOT NULL, in_tok INTEGER, out_tok INTEGER, cache_read INTEGER, cache_write INTEGER,
  reasoning_tok INTEGER, total_tok INTEGER,
  cost_sdk REAL, cost_est REAL, unpriced INTEGER,
  e2e_sum INTEGER, e2e_n INTEGER, gen_sum INTEGER, gen_n INTEGER,
  out_tok_tput INTEGER, rate_sum REAL, rate_n INTEGER, cache_n INTEGER,
  ttft_hist BLOB NOT NULL, e2e_hist BLOB NOT NULL,
  PRIMARY KEY (day, model_id, provider_id, project_id, status)
) WITHOUT ROWID;
```

**口径约定（写死，不许各处自行解释）**

| 字段 | 定义 |
|---|---|
| `calls` | 窗口内的**全部明细行数**（六态都算），等于 `Σseries.calls`；`answered = calls − aborted − incomplete` 单独给，成功率用 `answered` 做分母 |
| `cost_sdk` | 网关/SDK 报的值；**`> 0` 才记为 `cost_source='sdk'`**。`= 0` 一律按「网关未回填」处理（实测本机 `~/.pi-web/ledger.jsonl` 150,714 行里 92.5% 是 0，把 0 当真值会让成本整体显示 $0），改走价格表估算 → `cost_source='estimate'`；无价则 `'unpriced'` |
| `cost_est` | 价格表估算；仅当 `cost_sdk` 缺失或为 0 时填写 |
| `unpriced` | 有调用但无任何价格 → `cost_source='unpriced'`，金额里排除，UI 标「≥ 下限」 |
| `in_tok` | **非缓存输入**（缓存命中单列在 `cache_read`） |
| `promptTok` | `in_tok + cache_read + cache_write` |
| `cacheHitRate` | `Σ cache_read / Σ promptTok`（加权） |
| `gen_ms` | 流式：`e2e_ms - ttft_ms`；非流式：`= e2e_ms` |
| `tokPerSec` | `Σ out_tok / (Σ gen_ms/1000)`（加权）；另给每次的算术均值 `tokPerSecMean = rate_sum / rate_n` |
| `out_tok_tput` | rollup 里的 `Σ out_tok`（加权吞吐分子，按维度重算用；与 `out_tok` 同值但语义独立，别混用） |
| `rate_n` / `cache_n` | 分别是「有 gen_ms 的样本数」与「有缓存字段的样本数」；`cacheHitRate` 分母只能用 `cache_n`，缺失字段的记录不能按 0% 计 |
| `successRate` | `ok / (ok + client_error + rate_limited + provider_error)`，**排除 aborted / incomplete** |
| 分位 | 直方图近似，返回带 `approx: true`；136 桶在 1ms–4h 上对数等距（比值 1.1288），桶内对数插值。单桶最坏量化误差 6.3%，实测 p50/p90 与精确值差 <2% |

---

## 四、模块导出契约

> 全部 CommonJS 无关，纯 ESM。所有导出必须是**具名导出**（`default` 只允许给 worker 入口）。

### 4.1 `lib/v3/paths.mjs`

```js
export const LEDGER_DIRNAME = "usage-ledger";
export function resolveStateDir(hostDataDir, opts = {}) // → <hostDataDir>/plugin-data/usage-ledger
export function statePath(dir, name)                    // → join
export function resolveLegacyLedgerPath(hostDataDir)    // → <hostDataDir>/ledger.jsonl（v2 遗留）
export function resolveSessionsRoot({ settings, env, home }) // → {root, source:"setting"|"env"|"default"}
export function expandHomePath(input, home)
```

### 4.2 `lib/v3/hist.mjs`

```js
// 桶空间：136 个桶在 [1ms, 4h] 上**对数等距**（间隔比值 1.1288 ≈ 5.68 桶/octave）。
// （合同早期写的「17 octaves × 8 桶 = 136」在数学上覆盖不到 4h；实测端点优先，见 impl 汇报）
export const BINS = 136;            // binOf(1) === 0，binOf(4h) === BINS-1
export const PER_OCTAVE = 8;        // 名义值，保留导出；实际有效值看 BIN_RATIO
export const BIN_RATIO = 1.1288;    // (4h/1ms) ** (1/136)
export function binOf(ms)           // 1 → 0；4h → BINS-1
export function binValue(bin)       // MIN_MS * BIN_RATIO ** bin
// 落盘：uint32 小端，136×4 = 544B/直方图。**不要用 uint16**（单桶 >65535 会静默钳位，calls 与 samples 脱钩）
export function emptyHist()         // Uint32Array(BINS)
export function encodeHist(arr)     // → Buffer（小端 uint32）
export function decodeHist(buf)     // → Uint32Array
export function mergeHistInto(target, src)
export function quantile(hist, p)   // → number|null（桶内按对数中点取值）
export function histTotal(hist)
```

### 4.3 `lib/v3/store.mjs`

```js
export function openStore({ dir, readOnly = false, log })   // → Store（失败抛错，由调用方降级）
export function SCHEMA_VERSION

// Store（全部同步、短耗时）：
store.path
store.close()
store.metaGet(k) / store.metaSet(k, v)
store.refId(kind, name)                       // 取或建，返回 integer
store.refName(kind, id) / store.refList(kind) // → string / string[]
store.insertBatch(rows, { rollupVersion })    // 单事务 ≤2000 行；rows 见 4.9 记录形状
store.queryRecords({ fromMs, toMs, filters, cursor, limit }) // → { items, nextCursor, total }
store.getRecordById(id)
store.rollupRows({ fromMs, toMs, gran })      // gran: 'hour'|'day'；返回 rollup 行（含 hist: Buffer）
store.upsertRollupRows(gran, rows)            // 单事务
store.deleteRollupDay(day)                    // 用于重算某天
store.stats()                                 // { calls, firstTs, lastTs, bytes }
```

### 4.4 `lib/v3/metrics.mjs`（纯函数，不碰 IO）

```js
export function statusClass(status)            // 归一六态
export function summarizeRows(rows)            // rows = rollup 行 → KPI（见 §5 kpi 结构）
export function seriesFromRows(rows, { fromMs, toMs, gran }) // → [{t, calls, ok, error, incomplete, cost, ttftP50, ttftP90, e2eP50, outTok}]
export function topFromRows(rows, { key, limit })            // key: 'model'|'project' → [{name, calls, share, cost, tokPerSec, ttftP50, errorRate}]
export function costBuckets(rows)              // { amount, sdkAmount, estimatedAmount, unpricedCalls, estimateShare }
export function cacheStats(rows)               // { weighted, samples, saveRate }
export function throughput(rows)               // { weighted, mean, samples }
```

### 4.5 `lib/v3/rollup.mjs`

```js
export function createRollupIndex({ rows = [], version = 0, log } = {})
index.version                 // number（rollupVersion）
index.bump()                  // version++ 后返回新值
index.applyDelta(rows)        // 把 worker 推来的 rollup delta 合并进内存（同样结构）
index.aggregate({ fromMs, toMs, gran, filters })  // → { kpi, series, topModels, topProjects, filters }
index.replaceAll(rows, version) // 启动时从库加载
index.rowsFor({ fromMs, toMs, gran })            // 调试/持久化用
```
内存策略：小时桶只保留最近 `RETAIN_HOURS = 45*24`，更老的查询走 `store.rollupRows({gran:'day'})` 并缓存 60s（`aggregate` 内部处理）。

### 4.6 `lib/v3/parser.mjs`

```js
export function parseSessionEntry(entry, ctx)   // → record|null（语义与 lib/sessions.mjs 一致，但输出 v3 记录形状）
export function parseSessionLines(text, ctx)    // → { records, lines, bad, tail, ctx }
export function classifyFsError(err)            // → { code, reason, reasonEn, hint, hintEn }
```

### 4.7 `lib/v3/ingest.mjs`（在 worker 内运行）

```js
export async function runIngest({
  store,                 // worker 独占的写连接
  sessionsRoot, days, maxRowsPerBatch = 500, maxBytesPerRead = 8*1024*1024, budgetMs = 60,
  state, onBatch, onProgress, shouldStop,   // shouldStop() → 'pause'|'cancel'|false
})
// → { ok, phase, filesTotal, filesDone, rowsTotal, bytesRead, stopped }
```

### 4.8 `lib/v3/ingest-worker.mjs`（worker_threads 入口）

主↔worker 消息（必须逐字实现）：

```js
// 主 → worker
{ type: "init", payload: { dir, sessionsRoot, days, batchRows, legacyLedgerPath, needMigrate } }
{ type: "start" } | { type: "pause" } | { type: "resume" } | { type: "cancel" }
{ type: "migrate" }
{ type: "recalc", payload: { day } }
{ type: "shutdown" }
// worker → 主
{ type: "ready", payload: { migrated: bool } }
{ type: "rollup", payload: { version, rows } }        // rollup delta（结构同 rollup_hour 行），≤200 行
{ type: "progress", payload: { phase, filesTotal, filesDone, rowsTotal, rowsDone, bytesRead, etaMs, paused, errors } }
{ type: "batchDone", payload: { rows } }              // 本批写库行数
{ type: "error", payload: { code, message } }
{ type: "done", payload: { rows, stopped } }
```

### 4.9 写入行形状（`insertBatch` / worker `rollup` 消息都按它）

```js
// 明细行（store.insertBatch(rows) 接收）
{
  ts,                          // 必填，UTC 毫秒
  entryKey: string|null,       // 回填：`e:<srcName>:<entryId>`；live: null
  convId: string|null,
  model: string|null, provider: string|null, project: string|null,   // 存库时自动转 refs.id
  status: "ok"|"client_error"|"rate_limited"|"provider_error"|"aborted"|"incomplete",
  origin: "live"|"backfill"|"both",
  inTok, outTok, cacheRead, cacheWrite, reasoningTok, totalTok,      // number|null
  costSdk, costEst, costSource: "sdk"|"estimate"|"unpriced"|null, priceId, priceVersion,
  ttftMs, genMs, e2eMs, stopReason
}

// rollup 行（worker → 主 的 `rollup` 消息、`store.rollupRows()` 返回，字段名一致）
{
  bucket,                      // rollup_hour: 本地小时起点 ms；rollup_day: 'YYYY-MM-DD'
  modelId, providerId, projectId,     // number（0 = 未知）
  model, provider, project,           // string|null，仅主线程内存索引用，进库时可缺
  status,
  calls, inTok, outTok, cacheRead, cacheWrite, reasoningTok, totalTok,
  costSdk, costEst, unpriced,         // unpriced = 无价调用数
  e2eSum, e2eN, genSum, genN, outTokTput,
  ttftHist, e2eHist                    // Uint32Array 或 Buffer（两向可互转）
}
```

### 4.10 `lib/v3/importer.mjs`
```js
export function createImporter({ host, store, rollup, paths, log, onDelta })
// → { start(), pause(), resume(), cancel(), migrateLegacy(), recalcDay(day), status(), dispose() }
// status() → { phase:"idle|scanning|importing|paused|done|error", filesTotal, filesDone, rowsTotal,
//              bytesRead, etaMs, lastError, startedAt, finishedAt, workerAlive }
```
要求：
- worker 用 `new Worker(new URL("./ingest-worker.mjs", import.meta.url), { /* 无参，靠 init 消息 */ })`。
- **自调度 `setTimeout` 链 + 指数退避**（有净进展 → 100ms；无进展 → 2s→10s→60s→300s 封顶），**不用 `host.schedule`**（最小 10s 且会重叠）。
- `dispose()` 必须 `worker.terminate()`；`index.mjs` 用 `host.effect("usage-ledger:worker", () => importer.dispose())`。
- 收到 `rollup` 消息：`rollup.applyDelta(rows)` → `version = rollup.bump()` → 节流 2s 调 `onDelta(version)`。

### 4.11 `lib/v3/migrate.mjs`

```js
export async function migrateLegacyV2({ store, rollup, legacyPath, onProgress, batchRows = 2000, log })
// 流式读 v2 ledger.jsonl（createReadStream + readline），按 v3 记录形状 upsert，同时建 rollup。
// 幂等：靠 entry_key 唯一索引；重复跑不会重复计账。完成后 store.metaSet("migrated_at", iso)。
// → { ok, rows, skipped, ms }
```

### 4.12 `lib/v3/prices.mjs`

```js
export function createPriceBook({ dir, fetchImpl, getSettingsSnapshot, log, now })
// getSettingsSnapshot() 由 index.mjs 提供：返回**内存快照**（绝不读盘）
priceBook.load() / priceBook.status() / priceBook.refresh() / priceBook.ensureFresh({force})
priceBook.resolve(model)        // 记忆化；单次请求内不再触碰设置
priceBook.apply(record)         // → 补 cost_est / cost_source / price_id / price_version
priceBook.version               // number
```
沿用 v2 的三源抓取 + `priceOverrides` 语义；**唯一改动**：设置来自快照参数，不在热路径调用 `host.getSettings()`。

---

## 五、HTTP API v3（服务端 ↔ 客户端）

全部返回 `200 + {ok:boolean}`，失败也给结构化 `code`（前端据此分支），**绝不抛 500**。
所有端点都支持公共查询参数：`from`/`to`（ISO 或毫秒）、`range`（`today|24h|7d|30d|90d|all`）、`gran`（请求只允许 `auto|5m|1h|1d`；**响应里的实际粒度可能是 `5m|15m|1h|6h|1d`**——桶数超 720 时服务端自动升粒度，客户端必须按 `range.gran` 画轴，并按 `range.truncated` 提示）、`model`、`provider`、`project`、`status`（多值用逗号）。

### 5.1 `GET /api/v3/overview`

```jsonc
{
  "ok": true,
  "version": 42,                       // rollupVersion，客户端据此判断是否需要重渲染
  "range": { "key": "7d", "fromMs": 1793850000000, "toMs": 1794454800000,
             "gran": "1h", "granAuto": true, "timezone": "UTC+08:00", "tzLabel": "Asia/Shanghai" },
  "freshness": { "lastIngestAt": 1794454700000, "lastImportAt": 1794454000000,
                 "ledgerRecords": 149005, "importing": false, "coverage": { "imported": 441, "eligible": 441 },
                 "degraded": null },
  "kpi": {
    "calls": 16673, "ok": 16353, "error": 317, "incomplete": 3, "aborted": 0, "successRate": 0.9808,
    "ttft": { "p50": 2306, "p90": 6646, "p99": 23402, "samples": 11296, "coverage": 0.677, "approx": true },
    "e2e":  { "p50": 12000, "p90": 40000, "samples": 16673, "approx": true },
    "tokPerSec": 42.5, "tokPerSecMean": 51.2, "tokPerSecSamples": 12000,
    "cacheHitRate": 0.42, "cacheHitSamples": 9000, "cacheSaveRate": 0.31,
    "tokens": { "input": 1500000, "output": 90000, "cacheRead": 900000, "cacheWrite": 0, "total": 2502000 },
    "cost": { "amount": 12.3456, "sdkAmount": 10.3456, "estimatedAmount": 2.0,
              "unpricedCalls": 0, "estimateShare": 0.162, "isLowerBound": false }
  },
  "series": [ { "t": 1793850000000, "calls": 12, "ok": 12, "error": 0, "incomplete": 0,
                "cost": 0.12, "ttftP50": 2100, "ttftP90": 5000, "e2eP50": 12000, "outTok": 3400 } ],
  "topModels": [ { "name": "mimo-v2.6-pro", "calls": 12000, "share": 0.72, "cost": 9.1,
                   "tokPerSec": 44.2, "ttftP50": 2100, "errorRate": 0.01 } ],
  "topProjects": [ { "name": "JK项目/知识库", "calls": 8000, "share": 0.48, "cost": 5.2,
                     "tokPerSec": 40.1, "ttftP50": 2300, "errorRate": 0.02 } ],
  "filters": { "models": ["mimo-v2.6-pro"], "providers": ["xiaomi"], "projects": ["JK项目/知识库"],
               "statuses": ["ok", "client_error", "rate_limited", "provider_error", "aborted", "incomplete"] },
  "prices": { "version": 7, "fetchedAt": 1794200000000, "stale": false, "overridesError": null }
}
```

`series` 必须**按 `range`/`gran` 枚举补 0 桶**（不允许只返回有数据的桶）。

### 5.2 `GET /api/v3/records`

参数：`from`/`to`/`range`、`model`、`provider`、`project`、`status`、`q`（关键字）、`cursor`（`<ts>_<id>`）、`limit`（≤200，默认 50）。

`q` 在窗口内明细超过 20,000 行时**不再全量 LIKE 扫描**，直接返回 `{ok:false, code:"too-broad", hint:"把时间窗缩小到 7 天再搜"}`（150k 行实测 LIKE 扫描 1981ms，不能放在请求路径上）。

```jsonc
{ "ok": true, "total": 16673,
  "records": [ { "id": 123456, "ts": 1794454000000, "model": "mimo-v2.6-pro", "provider": "xiaomi",
                 "project": "JK项目/知识库", "status": "ok", "origin": "both", "sessionId": "01a1...",
                 "input": 310, "output": 226, "cacheRead": 9856, "cacheWrite": 0, "reasoning": 0,
                 "total": 10392, "promptTok": 10166, "cacheHitRate": 0.969,
                 "cost": 0.0021, "costSource": "estimate", "priceId": "modelsdev:xiaomi/mimo-v2.6-pro",
                 "ttft": 1879, "gen": 8232, "e2e": 10111, "stopReason": "toolUse" } ],
  "nextCursor": "1794453999000_123400" }
```

### 5.3 其它端点

| 端点 | 说明 |
|---|---|
| `GET /api/v3/record/:id` | 单条详情，同 records 的单行结构 |
| `GET /api/v3/import/status` | `{ok, status}`（结构见 4.9 `status()`） |
| `POST /api/v3/import/start` / `pause` / `resume` / `cancel` / `recalc?day=YYYY-MM-DD` | 全部**立即返回**（≤50ms），在后台推进 |
| `GET /api/v3/import/errors` | `{ok, errors:[{code, reason, hint, files:[…]}]}` |
| `GET /api/v3/meta` | `{ok, meta:{schemaVersion, rollupVersion, stateDir, sessionsRoot, ledgerBytes, degraded, prices, importer}}` |
| `GET /api/v3/export?format=csv` | 流式 CSV（`res.write` 分批，≤64KB 一块），末行附口径脚注 |
| `POST /api/v3/prices/refresh` | 强制刷新价格表 |
| `POST /api/v3/grant` | 申请会话目录读取（宿主弹窗） |

---

## 六、客户端契约

- 入口：`client/entry.mjs`，`export default { mount(container) → cleanup }`；可拆 `client/charts.mjs`、`client/format.mjs`、`client/state.mjs`（**都在 `client/` 内**）。
- 首屏只发 **1 个** `/api/v3/overview` + 1 个 `/api/v3/import/status`；明细表按需（切到表格视图或滚动到底）。
- 状态必须进 URL hash：`#ul?range=30d&gran=1h&model=all&status=all&view=chart`，只写非默认值。
- 渲染：**禁止 `container.innerHTML = ...` 整页重绘**；首帧建骨架，之后按键写 `textContent`/属性/`path.d`。列表用 keyed 复用。
- 必具四态：`idle/loading`（骨架）· `ready` · `stale`（保留旧数据 + 顶部 banner）· `error`（按 `code` 分文案）。
- 每次请求带 `AbortSignal.timeout(8000)`；请求代数守卫（旧响应不得覆盖新状态）。
- 图表：点数 ≤720；`crosshair` + `shared tooltip`（显示该桶区间与该桶口径）+ 图例可点隐藏系列 + `sparkline`（KPI 卡）。
- 表格：虚拟滚动或分页（keyset `nextCursor`），表头可排序（本地排序当前页 + 重新查询全量二选一，必须写清）；行可键盘触达。
- 导出：调服务端流式接口（不再前端串行拉页）。
- 顶栏必须有**真值行**：`2026-11-04 → 2026-11-11 · 16,673 次 · 粒度 1h（自动） · 数据截至 12:04:31`。
- a11y：分段控件 `role="tablist"`/`aria-selected`，KPI 变化 `aria-live="polite"`，表格 `role="table"`。

---

## 七、验收与自检命令

```bash
cd /c/Users/11373/Desktop/omp_optimize/cliproxy-stats

# 单测（既有 266 个必须继续全绿）
npx vitest run

# v3 数据层自检（C 提供）
npx vitest run tests/v3

# 端到端性能（主对话提供，C 可复用）
node scripts/v3-bench.mjs             # 导入 15 万条 + 各窗口聚合 + 首屏
```

硬门槛（任一不达标即返工）：

| 门槛 | 阈值 |
|---|---|
| 冷启动 `activate()` | ≤200ms 且零写盘 |
| `overview` 服务端耗时（30d） | ≤50ms |
| 单次主线程阻塞 | ≤16ms |
| 15 万条导入 | ≤120s（含 rollup） |
| 内存增量 | ≤150MB |
| 既有 266 个用例 | 全绿 |

---

## 八、相关

- 方案正文（结论/证据/复现/坑）：`C:/Users/11373/Desktop/omp_optimize/用量账本重构/报告/用量账本v3重构方案.md`
- 量化脚本：`C:/Users/11373/Desktop/omp_optimize/用量账本重构/scripts/`（`probe-getsettings-hotpath.mjs`、`bench-rollup.mjs`、`bench-write-modes.mjs`、`bench-sqlite.mjs`、`probe-service-latency.mjs`、`probe-e2e-client.mjs`）
- 宿主能力证据：`C:/Users/11373/pi-web-ui/node_modules/pi-web-ui/dist/server/plugins.js`（`3813-3817` schedule clamp、`2852-2857` readTextPath 整文件、`3656-3681` ui.update 全量广播、`4286` 同进程 import）
