# 简体中文语言层（zh-CN）

把上游 [hardbeat920/monocode](https://github.com/hardbeat920/monocode) 的界面文案翻成简体中文，并打包成 Apple Silicon 的 `aarch64` DMG。

## 设计取舍

不修改上游源码，因此 **Sync fork 永远不冲突**。

| 层 | 处理对象 | 手段 | 生效时机 |
| --- | --- | --- | --- |
| Webview | React 渲染出来的文本节点、`title`/`placeholder`/`aria-label` 等属性 | `dist/zh-cn.js` 运行时字典（精确匹配 + `Open {0}` 模板匹配） | 页面加载时注入，`MutationObserver` 兜住后续渲染 |
| 原生菜单 | macOS 菜单栏、Dock 右键菜单、Finder 权限弹窗 | 生成 `src-tauri/src/zh_cn.rs`，在 `setup` 里按菜单 id / 当前英文文本retitle | 启动时 |

为什么不用「把源码里的字符串换成中文」：MonoCode 里同一段英文经常既是界面文案又是逻辑常量（枚举比较、HTTP 头、storage key、CSS 类）。在 DOM 层替换可证明安全；源码层的批量替换会静默改变行为。

为什么用运行时字典而不是 i18n 框架：上游没有 i18n 基建，引入框架等于大规模改源码，与其「不冲突」的目标相反。

## 目录

```
tools/zh-cn/
  extract.mjs        抽取待翻译文案 → .zh-cn/worklist.json
  translate.mjs      增量翻译 → .zh-cn/dictionary.json
  patch-native.mjs    生成 src-tauri/src/zh_cn.rs 并挂到 lib.rs
  build.mjs          tsc + vite build + 注入（tauri 的 beforeBuildCommand）
  postbuild.mjs      单独注入 dist/（手工调试用）
  lib/filters.mjs    「这是不是界面文案」的判定规则
  lib/collect.mjs    TS AST 扫描
  lib/menu-extract.mjs  从 menu.rs / macos.rs / Info.plist 抽原生文案
  lib/provider.mjs   LLM 客户端（OpenAI 兼容 / Anthropic 兼容）
  lib/runtime-script.mjs  生成 dist/zh-cn.js
  lib/native.mjs     生成 zh_cn.rs、改 lib.rs、本地化 Info.plist
  glossary.json      术语表，权重高于模型自由发挥
  tauri.zh-cn.conf.json  打包覆盖配置
```

生成物（已在 `.gitignore` 中）：`.zh-cn/`、`src-tauri/src/zh_cn.rs`、`src-tauri/Info.zh.plist`。

## 本地手动跑

```bash
npm ci
node tools/zh-cn/extract.mjs
ZH_TRANSLATE_FORMAT=openai \
ZH_TRANSLATE_BASE_URL=https://api.openai.com/v1 \
ZH_TRANSLATE_API_KEY=sk-… \
ZH_TRANSLATE_MODEL=gpt-4.1-mini \
node tools/zh-cn/translate.mjs --workers 6
node tools/zh-cn/patch-native.mjs
npx tauri build --target aarch64-apple-darwin --bundles dmg \
  --config tools/zh-cn/tauri.zh-cn.conf.json
```

`tauri build` 会执行覆盖配置里的 `beforeBuildCommand`（`node tools/zh-cn/build.mjs`），它先 `tsc` + `vite build`，再注入 `dist/zh-cn.js`。**不要**在 `tauri build` 之前手工 `npm run build` 指望注入留在产物里——tauri 会重跑前端构建并覆盖 `dist/`。

## GitHub Actions

工作流：`.github/workflows/zh-cn-release.yml`

触发：push 到 `main`（含 Sync fork）、手动 `workflow_dispatch`。
行为：版本号对应的 Release 已存在就跳过；否则翻译 → 注入 → 打包 → 发布 `zh-cn-v<version>`。

需要在仓库 Settings → Secrets 配置：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `ZH_TRANSLATE_API_KEY` | 是 | 翻译网关的 key |
| `ZH_TRANSLATE_BASE_URL` | 是 | 例如 `https://api.openai.com/v1` |
| `ZH_TRANSLATE_MODEL` | 是 | 例如 `gpt-4.1-mini` |
| `ZH_TRANSLATE_FORMAT` | 否 | `openai`（默认）或 `anthropic` |

翻译字典存在独立分支 `zh-cn-state`，不占 `main`，也不会被 Sync fork 冲掉；每轮只翻译新增/变更的文案。

## 已知边界

- 运行时层只替换**完全匹配**的文本，所以带插值的句子依赖 `{0}` 模板（`Open {0}` 这类），模板规则在 `lib/collect.mjs` 里按「每一段都得像人话」判定。
- `code`/`pre`/`kbd`/`textarea`，以及带 `translate="no"` 或 `cm-content` 类的节点不翻译，避免动到用户内容与代码编辑器。
- 没有 Apple Developer 证书时产物是 ad-hoc 签名、未公证：首次打开需右键 → 打开，或 `xattr -dr com.apple.quarantine /Applications/MonoCode.app`。
- 上游若重命名菜单 id 或改文案，`zh_cn.rs` 的 `BY_ID`/`BY_TEXT` 会按新抽取结果自动重建；没覆盖到的项保持英文而不是报错。
- 机器翻译会出错，尤其是长句。术语表 `glossary.json` 是纠正译法的最省力位置。
