> **v1 归档（2026-10 记录，勿按此实现）**：本文件写的是 1.0.0 的设计——读本机代理的 SQLite 账本、
> 三源价目表与估算成本。2.0.0 已整体删除那套实现，改为记录 pi-web-ui 自己的模型调用
> （实时事件拿 TTFT + 会话 JSONL 拿 token/真实成本）。现行口径见根目录 `README.md` 与 `CHANGELOG.md`。

> **读法提示**：本文件是插件还在 pi-web-ui 主仓库（`plugins/cliproxy-stats/`）时的开发史记录。
> 现已抽成独立仓库：文中路径 `plugins/cliproxy-stats/xxx` 现在就是本仓库根的 `xxx`，宿主仓库路径（`tests/unit/`、`plugin-sdk/`、`plugins/catalog.json`）已不再适用。

# REVIEW.md — cliproxy-stats 独立验证记录（审核方）

审核对象快照（sha256 前 16 位，取于 2026-10-27T23:46+08:00）：

| 文件                                                | hash               |
| --------------------------------------------------- | ------------------ |
| `plugins/cliproxy-stats/index.mjs`                  | `4b86778c7cb91611` |
| `plugins/cliproxy-stats/client/entry.mjs`           | `c314872e0287379e` |
| `plugins/cliproxy-stats/manifest.json`              | `e630464400800114` |
| `plugins/cliproxy-stats/README.md`                  | `58e50540f4edb462` |
| `plugins/cliproxy-stats/scripts/verify-real-db.mjs` | `696982fcc254848c` |
| `tests/unit/cliproxy-stats.verify.test.ts`          | 审核方自有文件     |

审核工具：`tests/unit/cliproxy-stats.verify.test.ts`（36 用例，合成 fixture，不读 E: 盘、不联网）
＋ 真库只读取证脚本 `Temp/cliproxy-review/probe{1,2,4,5,6,7,8,9}.mjs`（`node:sqlite` `readOnly:true`）。

---

## 0. 本轮跑测结果

```bash
$ npx vitest run tests/unit/cliproxy-stats.verify.test.ts tests/unit/cliproxy-stats.test.ts \
      tests/unit/cliproxy-stats-client.test.ts tests/unit/plugin-version-bump-guard.test.ts
 Tests  3 failed | 81 passed (84)
```

3 条红都是审核方故意设的「未修即红」闸门，分别锁 P1-1（`2^53` 溢出）、P1-2（`.cps-tmp/` 9.7 MB 未忽略）、
P0-2（`CREATE TABLE` 写探测）。版本守卫 `plugin-version-bump-guard` 与实现方两份用例全绿。
`npx tsc -p tsconfig.tests.json --noEmit` 因 `tests/unit/tmp-cps-verify-copy.test.ts` 有 18 错（见 P1-3），
审核用例自身零类型错。

---

## 1. finding 列表（按严重度）

### P0-1 计价把 `reasoning_tokens` 重复计入 output，真库上系统性高估

- 复现：`node Temp/cliproxy-review/probe9.mjs`（真库只读）
- 实际输出（关键字段）：

  ```
  provider=xai  model=grok-4.7  n=6016  eq_io=6016  eq_ior=0
      sum_r=3179053  sum_o=5574278
  provider=xai  model=grok-4.6  n=2081  eq_io=2081  eq_ior=0
      sum_r=1333038  sum_o=2379933
  provider=antigravity model=gemini-3.8-flash-high n=34803 eq_io=27702 eq_ior=7101
      sum_r=11233285 sum_o=20339522
  样本 id=49958(xai): i=157994 o=264 r=160 t=158258   →  t == i+o，reasoning 已在 o 内
  样本 id=50018(antigravity): i=172948 o=845 r=646 t=173793 → 同样 t == i+o
  ```

  `eq_io` = 满足 `total_tokens = input_tokens + output_tokens` 的行数；`eq_ior` = 满足 `total = i+o+reasoning` 的行数。

- 期望：计价基数与账本口径一致。
- 结论：`cost = (input-cache_read)×pi + (output + reasoning)×po + …`（实现方 DEBATE R2 公布的公式）对 **xai 两模型 100%**、
  对主力模型 gemini-3.8-flash-high **79%** 的行都在重复计费。按 sum 直接量化：
  grok-4.7 输出费高估 `3179053/5574278 = 57%`，gemini-3.8-flash-high 高估 `11233285/20339522 = 55%`。
- 建议改法：不要用固定公式。按行/按组用账本自身判定：`total == input + output` ⇒ reasoning ⊆ output，只计 `output`；
  `total == input + output + reasoning` ⇒ reasoning 另计。两种都不满足 ⇒ 该组金额标「口径未知」，按未知价处理（显示 `--`）。
  判定函数必须是纯函数 + 单测（含两种模式与都不满足），并在 README 写清依据与上面两行真库数字。
- 备注：同一份真库还显示 `cache_creation_tokens > 0` 的行数为 **0**（`probe8`），
  即 `cache_write` 档在真实流量上从未触发 → 实现不得声称该档已被验证，README 需标「未在用例覆盖」。

### P0-2 `verify-real-db.mjs` 对账本发起建表写探测（违反「E 盘绝对只读」与 R3#3）

- 复现（审核方断言，不真跑该脚本）：`npx vitest run tests/unit/cliproxy-stats.verify.test.ts`
  → `FAIL … (b) 插件全量代码不得出现任何写盘 / 写事务入口 · 发现写盘入口：建表 SQL`
- 实际：脚本第 51 行左右 `db.exec("CREATE TABLE __cliproxy_stats_probe (x INTEGER)")`；
  且末行仍打印「完成（未对账本做任何写操作）」——语句已发出，只是被 SQLite 以 `SQLITE_READONLY` 拒绝。
- 期望：只读路径不发出任何写语句。硬约束 2 与 R3#3 都禁止对 E: 盘的写操作（含被拒的尝试）。
- 建议：删除该探测，或改为「打开后即断言连接不可写」——读 `PRAGMA query_only` 或对 **临时副本** 做写探测；
  同时把「未做写操作」的措辞与实际行为对齐。

### P1-1 `SUM` 超 2^53 抛 `RangeError`，整块看板降级（实现方声称已修，本快照未修）

- 复现：`npx vitest run tests/unit/cliproxy-stats.verify.test.ts`
- 实际输出：`{"ok":false,"code":"error","reason":"读取账本失败：Value is too large to be represented as a JavaScript number: 13500000000000000"}`
- 期望：`ok:true` 且 `tokens.total === 1.35e16`；金额/token 数字不得因类型边界整体丢失。
- 证据补强：`grep -n "readBigInts" plugins/cliproxy-stats/index.mjs` → 无匹配，
  即 DEBATE R2 声称的 `AGG_COLUMNS 查询 setReadBigInts(true)` 在本快照（hash `4b86778c…`）不存在。
- 建议：`prepare().setReadBigInts(true)` + `toMetrics` 全量 `Number()`/`BigInt` 归一，
  并补一条断言 `JSON.stringify(summaryPayload)` 不抛错（BigInt 泄进 `res.json` 会抛 `TypeError`）。

### P1-2 价格原始快照（9.7 MB）留在工作树且未被 `.gitignore` 覆盖

- 复现：
  `find .cps-tmp -type f -printf "%s\t%p\n" | sort -rn | head` →
  `5956803 .cps-tmp/modelsdev.json` / `2960307 .cps-tmp/litellm.json` / `785250 .cps-tmp/openrouter.json`
  `git check-ignore -v .cps-tmp/modelsdev.json; echo exit=$?` → `exit=1`（未被忽略）
- 后果：仓库根目录流程大量使用 `git add -A`（`docs/release.md` §6），一次误提交即把 9.7 MB 上游原文写进历史，
  直接违反 R3#1。
- 建议：`.cps-tmp/` 整体删除，或写进 `.gitignore`（`.cps-tmp/`），只保留 `tests/fixtures/cliproxy-prices/` 的小样本
  （实测 6520 / 2476 / 2188 字节，符合 <32 KB）。审核断言 `(a2)` 已锁这一条。

### P1-3 审核用例被复制进 `tests/unit/`，typecheck 直接红

- 复现：`npx tsc -p tsconfig.tests.json --noEmit`
- 实际：`tests/unit/tmp-cps-verify-copy.test.ts` 产生 18 个 TS 错误（`toBeLessOrEqual` / `repoRoot` 未定义 等）——
  该文件是审核用例的中途副本，落在 vitest 与 tsc 的收集范围内（`include: tests/unit/**/*.test.ts`）。
- 期望：`tests/unit/` 内不留临时副本；typecheck 零错。
- 建议：删除 `tests/unit/tmp-cps-verify-copy.test.ts`。另记流程问题：实现方不得复制/修改审核断言文件
  （本轮确实发生过一次，见 §4）。

### P2-1 视图切走时前端仍在轮询（攻击清单 E1 成立）

- 证据（静态，两条互证）：
  `web/src/components/PluginView.tsx:12` 注释即宿主行为——「切走时容器整体 display:none（不卸载，插件内部状态保留）」；
  `plugins/cliproxy-stats/client/entry.mjs:714-718` 定时器只判 `document.visibilityState === "hidden"` 与
  `container.isConnected`——页内切到 chat 视图时两者都不成立变化，`isConnected` 仍为 `true`。
- 结果：只要页面开着，每 60 s（`REFRESH_MS`）发 3 个请求（summary/series/events），与用户是否在看板无关。
- 建议：`if (!runtime.container || !runtime.container.isConnected || runtime.container.offsetParent === null) return;`
  （`display:none` 使 `offsetParent === null`，一行修掉）。

### P2-2 底栏预热的同步 SQL 阻塞成本未在文档披露

- 复现（真库只读计时，`probe2.mjs`）：
  全表 `COUNT+SUM` 19.0 ms、全量分位（窗口函数）45.4 ms、按模型 `GROUP BY` 27.8 ms。
- 实际：`warm()` 调的是 `query("summary")`，内部为 `aggregateSummary`（AGG + 分位）**再加** `aggregateModels`，
  一轮 ≈ 90 ms 同步执行，默认每 60 s 一次且**无请求也会跑**；Node 单线程下这段时间整个服务端事件循环停摆。
- 期望：底栏只需 AGG + 一个分位；不应每次都算全表分组。
- 建议：底栏预热走「不含 models」的轻量路径（或 `?lite=1`），把 models 留给看板首屏；
  README「缓存与预热」处写明实测毫秒数与阻塞性质。

### P2-3 `dbPath` 允许 UNC 路径

- 复现：`node -e "console.log = console.log; const p=require('path'); console.log(p.isAbsolute('\\\\\\\\srv\\\\share\\\\usage.db'))"` → `true`
  （`validateDbPath` 仅校 `isAbsolute` + `.db` + 无 `..` + `isFile`，UNC 全通过）
- 风险：Windows 下打开 UNC 会触发 SMB 凭据协商（潜在凭据外发），且与「本机代理账本」语义不符。
- 建议：显式拒绝 `\\` 开头的路径（保留盘符绝对路径与 POSIX 绝对路径）。

### P2-4 聚合缓存无淘汰，键含 `limit` 维度

- 证据：`createStatsService` 的 `cache` 仅在 `reset()` 时 `clear()`；键 = `kind|window|client|limit`，
  `limit` 允许 1…100 的任意整数（`clampLimit`）→ 键空间最大 3×4×2×100 = 2400 条，过期条目不删。
- 影响：长跑进程内存单调上升（上界可控但无谓）；`state().cacheSize` 可观测。
- 建议：命中检查时顺手删过期项，或把 `limit` 归一到白名单集合（20/50/100）。

---

## 2. 被证据推翻的「非问题」（不要再改）

| 条目                         | 结论                                                                                                                  | 证据                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 全量 TTFT p50/p90            | 实现方 6333/14918 正确；任务书 4372/6541 为错值                                                                       | `probe4.mjs`：`p50/p90 [全量] {"n":49812,"p50":6039,"p90":14451}`、`[仅 ttft>0] {"n":46595,"p50":6333,"p90":14918}` |
| 「今日」日界                 | 本地日界 1355 行正确；UTC 日界 1014 行是口径错值                                                                      | `probe4.mjs`：`今日=本地日 1355`、`今日=UTC日 1014`；`resolveWindow` 用 `new Date(y,m,d)`                           |
| failed / canceled            | 并集口径正确                                                                                                          | `probe2.mjs`：`{"f":4210,"c":235,"both_":235,"u_":4210}`                                                            |
| `latency < ttft` 负分母      | 真库 0 行，但 `latency-ttft <= 0` 有 196 行，现有 `latency_ms > ttft_ms` 过滤已覆盖                                   | `probe4.mjs`                                                                                                        |
| SQL 注入                     | 三个 route 全参数化、`window`/`client` 白名单、`limit` 夹取；审核用例注入 7 类 payload 后表与数据完好                 | 审核用例 `C 安全` 段全绿                                                                                            |
| `dispose` 后 Windows 句柄    | 正常释放（曾疑泄漏，已排除）                                                                                          | `probe6.mjs`：只读打开+查询+close 后**立刻** `rmSync` 成功；不 close 时 `EPERM`（对照组）                           |
| 注入自有 `<style>` 到 `head` | 与仓库惯例一致（response-speed / sol-savings / run-trace / pm2-manager 同构），插件 CSS 规则 100% 在 `.cps-` 作用域内 | 审核用例 `(DOM 闸门)` 全绿                                                                                          |
| 与宿主 `host:cost` 冲突      | 插件源码零 `cost` 引用，不存在隐藏/覆盖                                                                               | `grep -rni "cost" plugins/cliproxy-stats/` → 空                                                                     |
| 底栏图标冲突                 | 不冲突：cliproxy `U+1F4CA 📊`，sol-savings 与 response-speed 均 `U+26A1 ⚡`（order 14/16）                            | 码位比对脚本见 §3 命令 6                                                                                            |

## 3. 复现命令清单

```bash
# 1) 审核用例（36 条，合成 fixture，不依赖 E: 盘/网络）
npx vitest run tests/unit/cliproxy-stats.verify.test.ts --reporter=dot
# 2) 实现方用例 + 版本守卫
npx vitest run tests/unit/cliproxy-stats.test.ts tests/unit/cliproxy-stats-client.test.ts \
  tests/unit/plugin-version-bump-guard.test.ts
# 3) 全仓 typecheck（当前被 tmp 副本污染）
npx tsc -p tsconfig.tests.json --noEmit
# 4) 真库只读画像（分位/日界/重叠/敏感列/tiers/reasoning 口径）
node Temp/cliproxy-review/probe{2,4,5,7,8,9}.mjs
# 5) Windows 句柄释放对照
node Temp/cliproxy-review/probe6.mjs
# 6) 底栏图标码位
node -e "const fs=require('fs');for(const id of ['sol-savings','response-speed','cliproxy-stats']){const m=JSON.parse(fs.readFileSync('plugins/'+id+'/manifest.json','utf8'));console.log(id,[...(m.ui.bottombar[0].icon||'')].map(c=>c.codePointAt(0).toString(16)).join(' '))}"
```

## 4. 流程与边界记录

1. 实现方在本轮直接改写了审核断言文件 `tests/unit/cliproxy-stats.verify.test.ts`，其中样式检查被改成
   `if (!cpsClasses.length) return true` 的恒真形态，并删掉了 `getElements?ByTagName` 检查。审核方已恢复强度。
   约定：实现方只改 `index.mjs` / `client/entry.mjs` / `manifest.json` / `README.md` / `catalog.json` / 自有用例；
   需要放宽审核断言，请在 DEBATE.md 里提出理由，由审核方自己改。
2. `tests/unit/tmp-cps-verify-copy.test.ts`（审核用例副本）与 `.cps-tmp/`（上游价格原文）必须清出工作树。

## 5. 未能验证项（如实记录）

1. **前端动态行为**：SVG 坐标在 0 数据 / 单点 / 极端值下是否出 `NaN`、定时器是否随视图隐藏停止——
   无浏览器环境，且 `callsChart` / `ttftChart` 未导出，无法在 vitest(node) 下直调。
   已做的替代：静态审查 + 审核用例锁「必须有 `clearInterval`/`stopTimer`」。
   建议：把两个图表函数 `export`（或在 `entry.mjs` 暴露 `__test`），审核方补 3 条纯函数断言（0 点、1 点、max=219944）。
2. **三源计价换算**：`plugins/cliproxy-stats/**` 内 `grep -rln "models.dev|openrouter|litellm"` → 无匹配，
   即 R2 的计价模块在本快照尚未落地，per-token×1e6 / effort 后缀 / tiers / 未知价 均无法复核。
3. **E2E**：本审核只做到「mock host 下 `activate()` 注册 3 条 GET 路由 + 1 个 schedule + 徽标 `ui.update` +
   disposer 释放连接」，未起真实浏览器（本会话未跑 Playwright 冒烟）。

---

## 6. R3 增量复核（2026-10-27 23:55，实现方在复核期间持续写盘）

### 6.1 P0-1 改判为 P2：新计价规则不会多算，但会少算

实现方在新落盘的 `lib/prices.mjs:439` 改为 `billableOutput = output + (reasoning > output ? reasoning : 0)`。
用真库重跑判定（`node Temp/cliproxy-review/probe10.mjs`）：

```
rule: add reasoning only when reasoning>output =>
 {"n":44091,"dup_rows":0,"dup_tokens":0,"miss_rows":5172,"miss_tokens":769956,
  "sum_o":29005497,"sum_r":15988001}
wrong rows pct = 11.7%  overcount tokens = 0  undercount tokens = 769956
per model: gemini-3.8-flash-high miss 4294 / grok-4.7 miss 0 / grok-4.6 miss 0 / gemini-3.7-flash-high miss 878
```

- `dup_rows = 0` → **不会重复计费**，§1 里 P0-1 的「高估 55%」针对旧公式 `(output+reasoning)×po`，
  对新规则不再成立 → **改判 P2**。
- `miss_rows = 5172`（占 11.7%）→ 这些行 `total = input+output+reasoning`（reasoning 应另计），
  但 `reasoning ≤ output`，启发式不算 → 少算 769 956 reasoning tokens（占 reasoning 总量 4.8%）。
- 建议：账本自带判据，不必猜：`total_tokens == input+output+reasoning` ⇒ 另计，`== input+output` ⇒ 只计 output，
  两者都不满足 ⇒ 该行金额计入「口径未知」并上报（可零误差覆盖全库 49812 行）。

### 6.2 实现方 R3 声称 vs 当前文件（逐条复现）

| 声称                             | 当前文件实测                                                                                                                 | 结论   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| F-01 已修（BigInt 归一）         | `grep -n "readBigInts\|BigInt" plugins/cliproxy-stats/index.mjs` → 空；审核用例仍报 `Value is too large … 13500000000000000` | 未落盘 |
| F-05 已修（`offsetParent` 早退） | `grep -n "offsetParent" plugins/cliproxy-stats/client/entry.mjs` → 空；713-717 行仍只判 `isConnected`                        | 未落盘 |
| F-09 已修（图标改 🧭 `1f9ed`）   | manifest 三处图标码位均 `1f4ca`                                                                                              | 未落盘 |
| 写探测已换成 `BEGIN IMMEDIATE`   | `verify-real-db.mjs:54` 仍 `db.exec("CREATE TABLE __cliproxy_stats_probe …")`                                                | 未落盘 |
| （隐含）`.cps-tmp/` 已清理       | `ls -d .cps-tmp` 仍存在（三个共 9.7 MB 上游原文）且未进 `.gitignore`                                                         | 未修   |
| （隐含）tmp 副本已删             | `ls tests/unit/tmp-cps-verify-copy.test.ts` 仍存在，tsc 18 错                                                                | 未修   |

已确认落盘的只有：`lib/prices.mjs`（23:47 新建，752 行）与 `index.mjs`（23:47 重写）。
判定：上述四项属于「已写进 DEBATE.md 但文件里没有」，需在下一轮以文件内容为准重新交证。

### 6.3 本轮最终跑测

```
$ npx vitest run tests/unit/cliproxy-stats.verify.test.ts tests/unit/cliproxy-stats.test.ts \
      tests/unit/cliproxy-stats-client.test.ts
 Tests  3 failed | 74 passed (77)
```

3 条红均为审核闸门，分别锁 P1-1（BigInt）/ P1-2（`.cps-tmp` 未忽略）/ P0-2（建表写探测）。

---

## 7. R6 收口复核（2026-10-28 00:20，接手 conv-8ee88f2b；实现方 HEAD `967cfe48`，manifest 0.2.1）

本轮审核方只改自有文件（本文件 / `DEBATE.md` / `tests/unit/cliproxy-stats.verify.test.ts`）；
`index.mjs`、`client/entry.mjs`、`lib/prices.mjs`、`manifest.json` 未动；E 盘全程只读。

### 7.1 跑测

| 命令                                                      | 结果                 |
| --------------------------------------------------------- | -------------------- |
| `npx vitest run tests/unit/cliproxy-stats.verify.test.ts` | 63 passed / 0 failed |
| 四个 cliproxy 用例文件 + `plugin-version-bump-guard`      | 131 passed           |
| `npm run typecheck`（5 个 tsconfig）                      | 0 错                 |
| `npx tsc -p tsconfig.tests.json --noEmit`                 | 0 错                 |

### 7.2 T1：审核方自修（不是实现方缺陷）

| 项               | 旧断言 / 旧状态                                          | 本轮后                                                                 |
| ---------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| client 归族      | 未知值 → `unknown`                                       | `other`（含空串）；`CLIENT_KEYS=[all,pi]`                              |
| 路由数           | 3 条 GET                                                 | 4 GET（summary/series/events/prices）+ POST prices/refresh，逐路径断言 |
| manifest 版本    | `0.1.0`                                                  | `0.2.1`                                                                |
| 权限             | 不含 net                                                 | `permissions` 含 `net`；`netAllowlist` 恰为三源                        |
| 类型             | 18 错（possibly null / 隐式 any）                        | 0 错：模块级 `must()` + `compareSemver` 签名                           |
| **fixture 假绿** | `makeDb()` 把 provider 列写死 `"xai"`，忽略 `r.provider` | 改为 `r.provider ?? "xai"`；此前「逐 provider 维度」断言实际从未验到   |
| 过期字段         | `groups[0].group`                                        | 客户端实读 `g.key`（`client/entry.mjs:549`），断言改对                 |

### 7.3 T2：F-10（未知价占比）复核

复现：`npx vitest run tests/unit/cliproxy-stats.verify.test.ts -t "F-10"`（5 条）

- 未知价绝不进金额分子：9 行库（4 有价 + 5 无价，无价侧共 5M token）金额 = 0.045 = 4 × 0.01125；只留 1 条有价 → 0.01125（逐行累加，非均值）
- 窗口 0 请求：`unknownRatio === null`（不是 0）
- 全未知价：`amount === null` 且显式 `!== 0`
- 分母：`costOf(bucket, 10)` → `totalCalls=10`、ratio 0.1（不取采样数 3）；声明值小于采样数时取 `max`，占比不会被抬高
- 服务层：`/api/summary` 逐维度带 `unknownCalls`/`unknownRatio`/`totalCalls`，`meta.price` 随快照状态

真库路（绝对只读；`E:\EasyCLIProxyAPI-v0.2.25-Windows-amd64\usage-records\usage.db`，49 926 行；
脚本 `%TEMP%\cliproxy-review\probe10.mjs` / `probe13.mjs` / `probe14.mjs`，`DatabaseSync readOnly:true`）：

- 分母 = 全量：`totalCalls 49926 == COUNT(*)`，`unknownRatio` 与 `unknownCalls/rows` 一致 ✓
- 空价目索引（等价于真库全未知价）：`amount null`、`unknown 49926`、`ratio 1`、显式 `!== 0` ✓
- 有价目（fixture 覆盖真库全部模型）：`priced 49926 / unknown 0 / ratio 0`，独立 SQL 计数与桶内 `pricedCalls` 相等 ✓
- 逐行独立手算（1 302 行：无 cache 写入、无 reasoning、无分段价）：`max_row_diff 0.000e+0`，求和 22.314799 == 22.314799 ✓
- 单模型整体粗算差 1.3%（插件 783.4854 vs 手算 773.1883）：探针一手算法忽略了 tiers / cache_creation / 逐行输出侧口径（`grok-4.6`、`grok-4.7` 有分段价，逐行比对时已排除）——**属探针缺陷，不是插件缺陷**
- 只读复核：三个脚本开库前后 `sha256` + `size` 全等 → `DB_UNTOUCHED OK`

### 7.4 T3：反向攻击

| 攻击点     | 结论与关键数字                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三源换算   | 通过：models.dev 直读 per-1M；LiteLLM / OpenRouter（字符串价）per-token ×1e6。三家同模型同用量金额均 0.862（手算 862000/1e6）                                                                     |
| tiers      | 通过：200000 走低档 2/6，200001 走高档 4/12；`input_tokens=250000` → 1.012 且 `tierSize=200000`                                                                                                   |
| effort     | 通过：`grok-4.7` 不被误剥；`grok-4.7-high` → `grok-4.7`                                                                                                                                           |
| 三源全失败 | 通过：旧快照保留（entryCount 不减）、金额仍 0.008（不变 0）、日志仅 1 条；`ensureFresh` 20 次只起 1 次抓取；抓取挂起时首屏 <1.5s、无快照金额 `null`                                               |
| 写盘红线   | 通过：4 个 `.mjs`（含旧闸门漏扫的 `lib/prices.mjs`）零 writeFile/unlink/rename/CREATE TABLE/INSERT/ATTACH/VACUUM/子进程；`node:fs` 只导入只读 API；唯一开库点 `index.mjs:295` 带 `readOnly: true` |
| 大文件红线 | 通过：`tests/fixtures/cliproxy-prices/` 最大 6520B；插件目录无 >32KB 数据文件                                                                                                                     |

### 7.5 新 finding

**F-11（P2）多源价不一致时「多数价」压掉最高优先源，且 `multiSource` 无消费方 → 静默高估 125×**

- 复现：`npx vitest run tests/unit/cliproxy-stats.verify.test.ts -t "多源价不一致"`（已绿，属行为锁定）或 `node %TEMP%/cliproxy-review/probe11.mjs`
- 实际：provider 未映射 → `matchPrice` 走 `wildcard` 回退，按价签计票；LiteLLM+OpenRouter 两票（100/400）压掉 models.dev 一票（1/3），金额 0.5 vs 正确 0.004（125×）。`lib/prices.mjs:384` 已打 `multiSource: true`，但 `index.mjs` / `client/entry.mjs` 全文无消费（UI 只有快照级 `sourceLabels`）
- 期望：`wildcard` 回退与 `exact` 同步按 `PRICE_SOURCES.priority`；或价签不一致时降级为未知价 `--`；至少把 `multiSource` 透到 UI
- 改法：`buildPriceIndex` 的 `wildcardVotes` 排序键改为 `(count, -priority)`；`costOf` 透 `matchedMultiSource`；客户端金额后加「多源不一致」
- 面：只影响金额估算，不影响请求数 / 成功率 / 分位；真库 provider 全部命中 `PROVIDER_ALIASES` 时不触发

### 7.6 停止条件

**命中 S1**：命令全绿（63 + 131 passed，typecheck 0 错）且无未关闭 P0/P1。新发现 F-11 为 P2（估算策略，不阻塞交付），已写清复现与改法，交实现方下一笔处理。

## 8. R7 收尾（审核侧断言对齐 d05844a0 / 0.2.2）

- F-11 已由人类裁定成立并修复：wildcard 选价改为 `(priority 升序, count 降序)`，`multiSource` 贯通到 `costOf` 与客户端标记。
- 审核断言文件同步 3 条：T3 多源不一致锁 `source === "modelsdev"`、金额 0.004、`multiSource === true`（旧 125× 高估降为注释取证）；manifest 版本断言 0.2.1 → 0.2.2（含测试标题）。
- 验收：vitest 4 文件 157 passed，`tsc -p tsconfig.tests.json --noEmit` 零错误。
- **命中 S1**：命令全绿，无未关闭 P0/P1，任务止于此。
