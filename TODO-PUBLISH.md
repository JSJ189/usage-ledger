> **v1 归档（2026-10 记录，勿按此实现）**：本文件写的是 1.0.0 的设计——读本机代理的 SQLite 账本、
> 三源价目表与估算成本。2.0.0 已整体删除那套实现，改为记录 pi-web-ui 自己的模型调用
> （实时事件拿 TTFT + 会话 JSONL 拿 token/真实成本）。现行口径见根目录 `README.md` 与 `CHANGELOG.md`。

# 发布清单（4 步：§0 准备 + §1–§3 上线）

> 本仓库代码可直接跑：`npm ci && npm test && npm run check` 全绿后再发布（CI 用 `npm ci`，与 lockfile 严格一致）。

## 0. 发布前必须替换的占位

本仓库里的 `JSJ189` 取自**提交作者身份**（`JSJ189 <jsj1137318328@gmail.com>`），不是从 git `user.name` 配置读的（本机该配置为空）。提交历史里已包含这个邮箱：若你不想公开它，先把历史提交重写成 GitHub noreply 邮箱（`git filter-repo` / `git rebase`）再 push，或干脆重建一个干净的首次提交。

| 位置 | 当前值 | 何时改 |
| --- | --- | --- |
| `manifest.json` → `author` | `JSJ189` | 用户名不同则改 |
| `manifest.json` → `homepage` | `https://github.com/JSJ189/usage-ledger` | 仓库改名/换 owner 则改 |
| `registry/plugin.json` → `source` / `author` / `homepage` | 同上 | 必须与上面同步改，`source` 形如 `owner/repo`，`repo` 必须等于 `id`（`usage-ledger`） |
| `package.json` → `author` / `homepage` / `repository.url` | 同上 | 同步改 |
| `LICENSE` → 版权人 | `JSJ189` | 同步改 |
| `README.md` 徽章链接 | `JSJ189/usage-ledger` | 同步改 |

改完跑 `npm run check`：它会校验 manifest 与 `registry/plugin.json` 的 id / name / author / homepage / source 完全对齐。

## 1. 创建 GitHub 公开仓库

```bash
gh repo create JSJ189/usage-ledger --public --description "pi-web-ui plugin: read-only proxy usage ledger stats" --source . --push
# 或在网页新建同名公开仓库后：
git remote add origin https://github.com/JSJ189/usage-ledger.git
git branch -M main
git push -u origin main
```

推送后确认 CI（`.github/workflows/ci.yml`）绿：`npm ci` → `npm test` → `node scripts/check-manifest.mjs`。

## 2. 提交到官方插件清单

```bash
gh repo fork xing-shuyin/pi-web-ui-plugins --clone
cd pi-web-ui-plugins
mkdir -p plugins/usage-ledger
cp <本仓库>/registry/plugin.json plugins/usage-ledger/plugin.json
git checkout -b add-usage-ledger
git add plugins/usage-ledger/plugin.json
git commit -m "feat(plugins): 新增 usage-ledger（代理用量账本只读统计）"
git push -u origin add-usage-ledger
gh pr create --title "feat(plugins): 新增 usage-ledger" --body "只读聚合本机代理 SQLite 用量账本；权限 ui/http/net/storage（LOW 风险）；manifest 与 LICENSE 在仓库根。"
```

PR **只加一个文件**：`plugins/usage-ledger/plugin.json`。不要改仓库里其它任何文件。

## 3. 等 CI 自动合并

registry 的审计脚本会从本仓库远端拉 `manifest.json` 与 `LICENSE`：

- `manifest.json` 在**仓库根**（`source` 不带子目录）；
- `LICENSE` 在**仓库根**（否则告警）；
- `manifest.name` / `manifest.id` 齐全（缺则报错），`version` 齐全（缺则告警）；
- `permissions` 不含 `dom` / `fs:*` → 风险分级 LOW → 可自动合并。

合并后即可在市场里搜到「用量账本」，也可 `pi-web-ui install JSJ189/usage-ledger`。

## 后续发版

1. 改代码 → 同时把 `manifest.json` 与 `package.json` 的 `version` 一起升（`npm run check` 会拦住不一致）。
2. 更新 `CHANGELOG.md`。
3. `git tag v1.x.y && git push --tags`。
4. 已安装用户点设置面板的「更新」即可（`pi-web-ui install --force`，保留 config）。
