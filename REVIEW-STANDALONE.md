# REVIEW-STANDALONE · cliproxy-stats 上线前独立复核

判定：**FAIL（P0 = 0，P1 = 2，P2 = 5）**

- 复核对象：`C:/Users/11373/Desktop/omp_optimize/cliproxy-stats`，提交 `a0a36cc`（未 push）
- 复核时间：2026-10-28
- 复核者：独立审核子 agent（只写本文件与临时目录脚本，未改任何实现文件与配置，`git status` 复核前后均为 clean）
- 结论摘要：T1/T2/T3/T4/T6/T8 全绿；两条 P1 全在 README 文案与真库行为不一致，代码不用改。

---

## T1 跑绿

| 命令 | 结果 |
| --- | --- |
| `npm ci` | 第 1 次失败：`EPERM: unlink @rolldown/binding-win32-x64-msvc.node`（Windows 文件锁，被存活 node.exe 占用），node_modules 被删到一半（vitest 已删、`.bin` 空）。第 2 次 `npm ci` 成功：added 70 packages，`.bin` 21 项 |
| `npm test` | **159 passed / 0 failed**（4 个测试文件全过），5.45s |
| `npm run check` | 通过：`✓ manifest 自检通过（manifest 1.0.0，权限 ui/http/net/storage）` |

无红。npm 只装在本仓库目录内（`pwd` 与 `node_modules` 路径已核对）。

## T2 registry 元数据（全过）

`registry/plugin.json` 键集合：`author / description / descriptionEn / homepage / icon / id / name / source / tags`。

| 约束 | 实测 |
| --- | --- |
| `id` 匹配 `^[A-Za-z0-9_-]+$`、2–50、等于仓库名 | `cliproxy-stats`，14 字符，正则通过，== 仓库名 ✓ |
| `author` 匹配 `^[A-Za-z0-9_.-]+$`、== `source` owner | `JSJ189`，== `JSJ189/cliproxy-stats` 的 owner ✓ |
| `description` 5–300 | 143 字符 ✓（`descriptionEn` 272 ✓） |
| `tags` ≤10、每个 ≤30 | 6 个，最长 13 ✓ |
| `additionalProperties:false` | 无多余键（`scripts/check-manifest.mjs` 亦按同一 10 键白名单拦住）✓ |
| `icon` ≤10 | `📊` = 1 码点 ✓ |
| `iconSvg` | registry 里**未给**该键；manifest 的 3 处 `iconSvg`（311B）全部 `<svg` 开头、无 `<script>`、无 `on\w+=`、无 `javascript:` ✓ |

核实限制（如实报告）：`xing-shuyin/pi-web-ui-plugins` 的 schema 原文本次**无法联网核实**——`fetch_content` 对 `https://xing-shuyin.github.io/pi-web-ui-plugins/catalog.json` 与 `https://github.com/xing-shuyin/pi-web-ui-plugins` 各失败一次（代理 `127.0.0.1:7897` 未返回 HTTP 状态）。改以宿主解析器为替代证据：`server/plugin-catalog.ts::toEntry` 读取 `id/source/name/nameEn/description/descriptionEn/icon/iconSvg/homepage`，与本地 10 键白名单不冲突；`author`、`tags` 是宿主忽略但 registry 认的字段（背景已确认 schema 含 `author` 必填与 `tags` 长度约束）。

## T3 manifest 与仓库结构（全过）

- 根目录存在：`manifest.json`(4885B) / `LICENSE`(1063B, MIT © 2026 JSJ189) / `README.md` / `CHANGELOG.md` / `package.json` ✓
- `manifest.version === package.json.version === 1.0.0` ✓
- `permissions = ["ui","http","net","storage"]`：**无 `dom`、无 `fs:*`** → LOW 风险成立 ✓
- `icon = 📊`，≠ ⚡ ✓
- `apiVersion = 2`，且 permissions 非空（宿主 `plugin-manifest-validate.ts:156` 要求 apiVersion 2 必须声明 permissions）✓
- `view:false` + `preload:true` 与宿主规范一致：宿主文档 `docs/architecture-plugins.md:217-220` 明确这就是「无视图 tab 但顶层代码常驻」的写法（notes 插件同模式）；`plugin-loader.ts:382` 的过滤条件是 `(p.view !== false || p.preload)`，`loadOne` 见到 `default.mount` 即登记进视图注册表；manifest 自声明 `ui["topbar.primary"]` 的 `id:"__view"` 条目被宿主认作保留字（`ui-slots.ts:1437,1464`：自声明 `__view` 默认可见），`withPluginViewItems` 只对 `view !== false` 才合成，不冲突 ✓
- 设置项类型 `text/boolean/number` ⊆ 宿主 `SETTING_TYPES`（`server/plugins.ts:1062`）✓
- 槽位 `bottombar` / `topbar.primary` ⊆ 宿主槽位表（`web/src/ui-slots.ts:137,157`）✓
- `netAllowlist` 恰好三源，与 `net` 权限配对 ✓
- 服务端用到的 host API 全在 SDK 声明面内：`effect / fetch / getSettings / log / onSettingsChanged / registerBackgroundTask / route / schedule / storage / ui`；`host.schedule(ttlMs, fn, opts)` 的 number 入参合法（`plugin-sdk/index.d.ts:284`、实现 `plugins.ts:4768`）✓

## T4 数据源发现（全过）

顺序与实现一致：设置项 `dbPath` → `CLIPROXY_USAGE_DB` → `~/.pi/agent/cliproxyapi.json` 的 baseUrl 端口 → 已知安装位置 → 搜索根（盘符浅扫）。

结构化空态（本机真实环境，注入不存在的搜索根，不抛错）：

```
{"ok":false,"code":"db-not-found","reason":"未找到代理用量账本 usage.db（已试 17 个位置）",
 "hint":"在设置里填 usage.db 绝对路径","candidates":[...17 条...],"path":""}
```

已尝试候选路径（前 5 行）：

```
C:\Users\11373\.pi\agent\cliproxyapi.json
C:\Users\11373\AppData\Local\CLIProxyAPI\8317
C:\Users\11373\AppData\Local\EasyCLIProxyAPI
C:\Users\11373\AppData\Roaming\CLIProxyAPI\8317
E:\8317
```

真库自动发现（默认链路，零配置）：

```
ok=true  source=search-root  path=E:\EasyCLIProxyAPI-v0.2.25-Windows-amd64\usage-records\usage.db  用时 2ms
readdir 调用次数=3  最深 readdir 层数=1  （只枚举 C:\ D:\ E:\ 三个根）
```

其它断言：`DISCOVERY_MAX_DEPTH=2` / `DISCOVERY_MAX_ENTRIES=500`；注入 501 条目的层被跳过并写日志（`跳过 X:\：条目 501 > 500`）；`autoDiscover:false` 时 `readDir` 一次都没被调用；`bad-path`（非法设置项）与 `db-not-found` 分开返回，不静默回落到另一份数据。

## T5 只读与安全红线（除 P1-1 外全过）

- `new DatabaseSync(file, { readOnly: true })` ✓（`index.mjs:582`），另加连接级 `PRAGMA busy_timeout` / `PRAGMA query_only = ON`；全仓**没有** `journal_mode` 写操作
- `index.mjs` / `lib/` / `client/` / `scripts/` 里 `writeFile*` / `appendFile` / `copyFile` / `unlink` / `rename` / `mkdir` / `rm` / `CREATE TABLE` / `INSERT INTO` / `UPDATE ... SET` / `DELETE FROM` / `VACUUM` **零命中**（仅注释与两条连接级 PRAGMA）
- 真库不可写实测：`PRAGMA query_only = 1`；`CREATE TABLE` 与 `INSERT INTO usage_events` 均被拒 `attempt to write a readonly database`
- `usage.db` 本体前后对比：mtime `1793118928430.356 → 1793118928430.356`（未变），size `69718016 → 69718016`（未变）
- 价格原文体积：`tests/fixtures/cliproxy-prices/litellm.json` 2188B、`modelsdev.json` 6520B、`openrouter.json` 2476B；全仓 >32KB 的 `.json` 只有 `package-lock.json`（豁免）✓

**审核方自我披露**：我在真库上发过一条 `CREATE TABLE _cps_review_probe` 写探测语句，被 SQLite 拒绝、未产生任何写入。仓库自带 `scripts/verify-real-db.mjs` 的纪律是「连写探测都不发」，实现方请保持该纪律，后续审核也应只用 `readOnly` + `query_only` 断言。

## T6 客户端可加载性（全过）

`client/entry.mjs` 的 `import` 行**一条都没有**（`grep -nE "import|require\(|from ['\"]"` 零命中），因此不存在裸包名解析失败 → 无白屏风险。`esc` / `formatBytes` 内联在文件头并有注释说明「独立仓库不引 `@pi-web-ui/plugin-sdk/client`」。判定：通过。

- 契约：`export default { mount }`（1038 行），`mount(container)` 返回 cleanup ✓
- 空态：`renderNotice` 用 `<details class="cps-tried">` 渲染 `err.candidates`（截前 30 条，逐条 `<li><code>`），服务端 `index.mjs:1133,1221` 确实把 `candidates` 随响应下发 ✓
- 定时器：`startTimer` 先 `stopTimer()`；`stopTimer` 用 `clearInterval` 并置 null；回调三重 guard —— `document.visibilityState === "hidden"` / `!container.isConnected` / `root.offsetParent === null`（宿主切走视图只 `display:none`）都不发请求；unmount 清 timer、`AbortController`、`onLocale`、`MutationObserver`、点击监听 ✓
- `window.__piWebUiHost` 桥（`setView` / `onUiAction` / `onLocale`）在宿主 `web/src/plugin-host.ts` 中确实暴露 ✓

## T7 README 诚实性

逐条核对（真库只读 SQL 复算，纯 SELECT）：

| README 断言 | 实测 | 判定 |
| --- | --- | --- |
| TTFT = 代理侧「收到请求 → 上游首包」，与 `response-speed` 的客户端 TTFT 区分 | README 有专节（第 62–64 行）明写，客户端注释同口径 | ✓ 真 |
| 成本按公开目录价估算、显示价源与快照时间、`估算值不能当账单用` | README 第 67–72 行明写 | ✓ 真 |
| 未知模型价 `null`、绝不冒充 0 | README 写「界面标『未知价』」；`fmtCost` 对 null/非有限值返回 `--`（`client/entry.mjs:266`）——「未知价」与 `--` 两种表述都成立 | ✓ 真 |
| `cache_read ⊆ input`：0 行违反；`sum(cache)=5.41B ≤ sum(input)=6.02B`；41 732 行 >0 | 0 违反 / 5.41B / 6.02B / 41 732 | ✓ 逐字对上 |
| `reasoning > output`：3 110 行（6.2%）；`sum(output)=553 246`、`sum(reasoning)=2 216 518`；全是 antigravity `gemini-3.x-flash-high` | 3110 / 553246 / 2216518；provider 全为 antigravity（`gemini-3.8/3.7/3.6-flash-high`） | ✓ 数字全对 |
| `total = i+o` 41 644 行（83.4%）、`= i+o+r` 14 018 行 | 41644、14018 | ✓ 真（但见 P2-3） |
| `ttft_ms = 0` 3 222 行 | 3222（6.5%） | ✓ 真 |
| 覆盖 2026-08-18 → 2026-10-28 | 本地日 `2026-08-18 11:34:21 → 2026-10-28 00:23:38` | ✓ 真 |
| 隐私段：只读、不上传（无遥测/无回传/无账号）、明细不含 api_key/IP/request_id | 只读有 `readOnly` 兜底；敏感列排除有单测锁死 | ✓ 真 |
| **不动 `-wal`/`-shm`** | **不实** | ✗ **P1-1** |
| **`reasoning ⊆ output` 不成立** | 表述笼统 | ✗ **P1-2** |

## T8 发布清单（全过）

`TODO-PUBLISH.md` 覆盖：占位替换表（6 处 `JSJ189`：manifest author/homepage、registry source/author/homepage、package.json author/homepage/repository、LICENSE 版权人、README 徽章）→ 建公开仓并 push → CI 绿 → fork `xing-shuyin/pi-web-ui-plugins` → 只加 `plugins/cliproxy-stats/plugin.json` 一个文件 → 提 PR → CI 自动合并（并写明「manifest/LICENSE 在仓库根」「无 dom/fs:\* → LOW」）→ 后续发版四步。判定：通过（细节瑕疵见 P2-5/P2-6）。

---

## Findings

`[P1-1] README.md:41「不写账本所在盘：…不动 -wal/-shm」与真库行为不符。` 复现：`node C:/Users/11373/AppData/Local/Temp/cps-review/wal-test.mjs`（临时目录造 WAL 库 → 正常关闭只剩 `probe.db` → 用 `new DatabaseSync(f,{readOnly:true})` 打开）。实际：只读连接打开期间出现 `probe.db-shm`+`probe.db-wal`，**关闭后仍在**（`-wal` 0B、`-shm` 32768B）；真库上同样出现 `usage.db-wal`/`usage.db-shm`（约 1 分钟后被运行中的 `EasyCLIProxyAPI.exe` PID 8252 checkpoint 回收，`usage.db` 本体 mtime/size 全程未变）。期望：README 改为「只读打开 WAL 账本会让 SQLite 在账本旁创建 0 字节 `usage.db-wal` 与 `usage.db-shm`，连接期存在、由代理下次 checkpoint 回收；账本文件本体零改动」，或实现侧改到不产生 sidecar 的打开方式。

`[P1-2] README.md:81 对 reasoning ⊆ output 只给笼统结论「不成立」，漏掉决定性事实。` 复现：`SELECT count(*) FROM usage_events WHERE CAST(reasoning_tokens AS REAL)>CAST(output_tokens AS REAL)` = 3110；再加 `AND CAST(total_tokens AS REAL)=CAST(input+output+reasoning AS REAL)` 仍 = 3110；`min/max(datetime(timestamp_ms/1000,'unixepoch','localtime'))` = `2026-08-18 11:34:21 → 2026-09-14 23:30:41`；`AND timestamp_ms >= <now-30d>` = 0。实际文案：只写「3 110 行（6.2%）违反 … 不成立」。期望：写明「3 110 行**全部**属形状 `total=i+o+r`、**全部**落在 2026-08-18→2026-09-14（30 天窗口内 0 行），因此按形状判定计费不漏计」——现写法会让读者误判计费口径不可靠。

`[P2-1] 空态 candidates 把配置文件当账本候选展示。` 复现：`discoverLedger({searchRoots:"C:/cps-review-no-such-root"})` → `candidates[0] = "C:\\Users\\11373\\.pi\\agent\\cliproxyapi.json"`。实际：客户端 `.cps-tried` 把它列成「已尝试位置」。期望：候选列表只放账本路径/目录，配置文件另起一行标注。

`[P2-2] 视图切走时定时器仍空转。` 复现：`grep -n -A6 "function startTimer" client/entry.mjs`。实际：`setInterval` 每 60s 照跑，只在回调里 `return`（不发请求）。期望：`visibilitychange`/视图切换时 `stopTimer()`，回来再 `startTimer()`。

`[P2-3] README.md:82 形状表可核算性差。` 复现：同 P1-2 的四个形状查询。实际：`83.4% + 28.1% > 100%`，且未列 `total=i+o+cache` 7 309、`total=i+o+r+cache` 5 240、`total=0` 4 158 三行。期望：加一句「这些桶按谓词成立、互相重叠（r=0/cache=0 的行同时满足多式），不是划分」。

`[P2-4] 未声明 fs 却直接 import node:fs（readDir/statSync/readFileSync）。` 复现：`grep -n "node:fs" index.mjs` + 宿主 `server/plugins.ts:992`。实际：宿主 `fs` 门控只管 `host.fs.*`，插件服务端自行 import 不经门控，声明 `["ui","http","net","storage"]` 在宿主语义下正确。期望：README 隐私段点明「不经宿主 fs 能力、直接只读枚举目录」，避免社区审核误读为漏报权限。

`[P2-5] TODO-PUBLISH.md:7 把 JSJ189 归因于 git \`user.name\`，但该仓库 user.name/user.email 均未配置。` 复现：`git config user.name; git config --global user.name`（两条都空）。实际：身份只存在于提交作者（`git log -1 --format='%an <%ae>'` → `JSJ189 <jsj1137318328@gmail.com>`）。期望：措辞改成「取自提交作者」，并提醒发布者换邮箱（gmail 私人邮箱已进 git 历史）。

`[P2-6] 文档小瑕疵。` `TODO-PUBLISH.md` 标题写「3 步」但实为 §0–§3 四节；首行让跑 `npm i` 而 CI 用 `npm ci`；`README.md` 顶部 CI 徽章指向尚未创建的仓库（发布前 404）。

---

## 已核实为真、不是问题的项（请勿白改）

1. `npm test` 159/159 全绿、`npm run check` 通过；测试不依赖宿主仓库、不开真库（`tests/support/sandbox-deps.mjs` 把 `env/home/readText/readDir` 全注入沙箱）。
2. `registry/plugin.json` 键集合、`id`/`author`/`source`/`description`/`tags`/`icon` 全部合规；`iconSvg` 三处都干净（无 script / 事件处理器 / javascript:）。
3. `manifest.version === package.json.version`；`LICENSE`/`README.md`/`CHANGELOG.md`/`manifest.json`/`package.json` 都在仓库根；权限无 `dom`、无 `fs:*`；icon 非 ⚡；`apiVersion = 2`。
4. `view:false` + `preload:true` 是宿主文档化的合法组合，自声明 `__view` 条目被宿主认账；底栏 `action` 与 `host.onUiAction`、`host.setView` 接线与 SDK 一致。
5. `host.schedule` 传毫秒数合法（SDK 签名 `string | number`）。
6. 发现链不递归全盘：真机默认链路只 readdir 3 次（三个盘符根）、最深 1 层、2ms；两层深度上限 + 500 条目上限 + 跳过日志都实测生效。
7. 找不到时是结构化空态（`ok:false` / `code:"db-not-found"` / 17 条 candidates / hint 含 `usage.db` / 不抛错）；`bad-path` 与之分开；`autoDiscover:false` 完全不扫盘。
8. 真库被零配置自动发现：`E:\EasyCLIProxyAPI-v0.2.25-Windows-amd64\usage-records\usage.db`（`source=search-root`）。
9. 只读红线（除 sidecar 一点）：`readOnly:true` + `query_only=1`，`CREATE TABLE`/`INSERT` 被拒，`usage.db` mtime 与 size 全程未变；源码零写接口、零 DDL/DML/VACUUM/journal_mode。
10. 价格原文体积合规：三个 fixture 2188B / 6520B / 2476B，全仓 >32KB 的 JSON 只有 `package-lock.json`。
11. `client/entry.mjs` 零 import（无任何裸包名），`.cps-tried` 空态在，定时器有清理与三重不可见 guard。
12. README 的真库数字全部逐字对上：49926 / 41644 / 14018 / 3110 / 553246 / 2216518 / 3222 / 41732 / 5.41B / 6.02B / 0 违反 / 覆盖区间。
13. host 版旧数字 `13 651`、`4 311`、`310` 已从独立仓库 README 移除——这三个数在现库上**复现不出**（`cache_creation_tokens` 全库恒为 0，非零行数 0），不要再写回去。
14. `TODO-PUBLISH.md` 覆盖 T8 要求的全部六步与占位清单。

## 我跑过的命令

```bash
git log --oneline -5; git status --porcelain; find . -type f -not -path "./node_modules/*"
git log -1 --format='%an <%ae>'
npm ci                      # 失败一次（EPERM 文件锁），重试成功：added 70 packages
npm test                    # 159 passed / 0 failed（4 files）
npm run check               # ✓ manifest 自检通过（内部即 node scripts/check-manifest.mjs）
node C:/.../cps-review/check.mjs          # T4 空态/深度/上限/autoDiscover + T5 只读断言与 mtime 对比
node C:/.../cps-review/wal-test.mjs       # 决定性：只读打开 WAL 库会创建并遗留 -wal/-shm
node C:/.../cps-review/readme-numbers.mjs # 形状分布/reasoning/cache/ttft/覆盖区间全量复算
node C:/.../cps-review/cache-shape.mjs hunt.mjs viol.mjs   # 追 13651/4311/310 三个数 + 违反行组成
node C:/.../cps-review/notfound.mjs       # 真机结构化空态 17 条候选
node C:/.../cps-review/depth.mjs          # 真机 readdir 次数/深度/耗时
grep -rn（权限、写接口、DatabaseSync、import、cps-tried、定时器、槽位、host.* API 面）
git config user.name / --global user.name / git log -1 --format='%an <%ae>'
fetch_content × 2（registry schema 联网核实失败：代理无响应，已如实标注）
```

对 `E:\EasyCLIProxyAPI-*` 全程只读：未删除、未移动、未改权限；唯一发出的写语句被 SQLite 拒绝且已在上文披露。
