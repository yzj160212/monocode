# 简体中文语言层（zh-CN）

把上游 [hardbeat920/monocode](https://github.com/hardbeat920/monocode) 的界面文案翻成简体中文，并打包成 Apple Silicon 的 `aarch64` DMG。

## 快速开始

1. 合入本 PR，或直接在 `main` 上保留这些文件。
2. 仓库 Settings → Secrets 配 `ZH_TRANSLATE_API_KEY`、`ZH_TRANSLATE_BASE_URL`、`ZH_TRANSLATE_MODEL`（可选 `ZH_TRANSLATE_FORMAT`）。
3. 上游更新后点 GitHub 的「Sync fork」→ 工作流自动跑：翻译 → 注入 → 打包 → 发 Release `zh-cn-v<版本>`。
4. 没配 secrets 也能跑：用仓库里的 `seed.zh-cn.json`，新增文案保持英文。
5. 发现漏译：优先改 `tools/zh-cn/overrides.json`（优先级最高），不用重翻全量。

## 设计取舍

不修改上游源码，因此 **Sync fork 永远不冲突**。

| 层 | 处理对象 | 手段 | 生效时机 |
| --- | --- | --- | --- |
| Webview | React 渲染出来的文本节点、`title`/`placeholder`/`aria-label` 等属性 | `dist/zh-cn.js` 运行时字典（精确匹配 + `Open {0}` 模板匹配） | 页面加载时注入，`MutationObserver` 兜住后续渲染 |
| 原生菜单 | macOS 菜单栏、Dock 右键菜单、Finder 权限弹窗 | 生成 `src-tauri/src/zh_cn.rs`，按菜单 id / 当前英文文本 retitle | 启动时，以及**每次前端推送快捷键覆盖、菜单被重建之后** |

为什么不用「把源码里的字符串换成中文」：MonoCode 里同一段英文经常既是界面文案又是逻辑常量（枚举比较、HTTP 头、storage key、CSS 类）。在 DOM 层替换可证明安全；源码层的批量替换会静默改变行为。

为什么用运行时字典而不是 i18n 框架：上游没有 i18n 基建，引入框架等于大规模改源码，与其「不冲突」的目标相反。

## 目录

```
tools/zh-cn/
  extract.mjs        抽取待翻译文案 → .zh-cn/worklist.json
  translate.mjs      增量翻译 → .zh-cn/dictionary.json
  audit.mjs          列出字典仍覆盖不到的可见文案（覆盖率审计）
  audit-all.mjs      零启发式审计：AST 看到但字典未覆盖的全部串，用于证明
                     判定规则没有把真文案误判成代码
  patch-native.mjs    生成 src-tauri/src/zh_cn.rs，挂到 lib.rs 与 menu.rs
  build.mjs          tsc + vite build + 注入（tauri 的 beforeBuildCommand）
  postbuild.mjs      单独注入 dist/（手工调试用）
  verify.mjs         校验产物：arm64、注入、菜单表、Info.plist、DMG 校验和
  lib/filters.mjs    「这是不是界面文案」的判定规则
  lib/collect.mjs    TS AST 扫描
  lib/menu-extract.mjs  从 menu.rs / macos.rs / Info.plist 抽原生文案
  lib/provider.mjs   LLM 客户端（OpenAI 兼容 / Anthropic 兼容）
  lib/runtime-script.mjs  生成 dist/zh-cn.js
  lib/native.mjs     生成 zh_cn.rs、改 lib.rs、本地化 Info.plist
  glossary.json      术语表，权重高于模型自由发挥
  overrides.json     人工订正，优先级最高（模型翻译会覆盖错的优先改这里）
  keep.txt           明确保持英文的串，每行一条（品牌名、协议常量）
  keep.json          同上，但用于含换行的键（keep.txt 一行一条表达不了）
  seed.zh-cn.json    已提交的字典快照，首次构建不必全量重翻
  runtime.test.mjs   运行时替换规则（代码面跳过、后续渲染、占位符）
  split.test.mjs     跨文本节点的整句替换（React 把 `text {expr} text` 渲染成
                     多个相邻文本节点，逐节点匹配翻不了）
  extract.test.mjs   抽取器判定（文案 vs CSS vs 枚举值）
  reported.test.mjs  用户报告的两轮漏译，锁定不回归
  pipeline.test.mjs  失败路径（无字典、空字典、陈旧条目、重复注入）
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
npx tauri build --target aarch64-apple-darwin --bundles app,dmg \
  --config tools/zh-cn/tauri.zh-cn.conf.json
node tools/zh-cn/verify.mjs          # 12 项产物断言
npm run zh-cn:audit                  # 还差哪些可见文案
```

`--bundles app,dmg` 两个都要：只打包 dmg 时 tauri 会清掉 `.app`，`verify.mjs` 就无从校验二进制的架构与签名。

`tauri build` 会执行覆盖配置里的 `beforeBuildCommand`（`node tools/zh-cn/build.mjs`），它先 `tsc` + `vite build`，再注入 `dist/zh-cn.js`。**不要**在 `tauri build` 之前手工 `npm run build` 指望注入留在产物里——tauri 会重跑前端构建并覆盖 `dist/`。

## GitHub Actions

工作流：`.github/workflows/zh-cn-release.yml`

触发：push 到 `main`（含 Sync fork）、手动 `workflow_dispatch`。
行为：Release `zh-cn-v<version>` 不存在时翻译 → 注入 → 打包 → 发布；已存在时，只有本次推送改动了 `tools/zh-cn/**` 或工作流本身才重出包，其余推送跳过。

需要在仓库 Settings → Secrets 配置：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `ZH_TRANSLATE_API_KEY` | 是 | 翻译网关的 key |
| `ZH_TRANSLATE_BASE_URL` | 是 | 例如 `https://api.openai.com/v1` |
| `ZH_TRANSLATE_MODEL` | 是 | 例如 `gpt-4.1-mini` |
| `ZH_TRANSLATE_FORMAT` | 否 | `openai`（默认）或 `anthropic` |

翻译字典存在独立分支 `zh-cn-state`，不占 `main`，也不会被 Sync fork 冲掉；每轮只翻译新增/变更的文案。

未配翻译密钥时，上游新增文案会保持英文，`audit` 步骤只警告不阻断。人工补法：

1. `npm run audit` 看还差哪些可见文案（`node tools/zh-cn/audit-all.mjs --limit 100000` 放开全部启发式，用于确认规则没漏掉真文案）；
2. 把缺失的串写进 `tools/zh-cn/seed.zh-cn.json` 的 `entries`（带 `{0}` 的模板写进 `patterns`），文案纠错改 `overrides.json`（优先级最高）；
3. 推送到 `main` —— gate 认出语言层变了，自动重出当前版本的 DMG 与 Release 资产。

两个坑：`kept`（来自 `keep.txt`/`keep.json`）里的键即使补了译文也不渲染，要翻它先把它从 keep 列表删掉；`.zh-cn/dictionary.json` 一旦存在就会**遮蔽** seed，本地手工改 seed 前先删掉它（CI 上该文件只在 `zh-cn-state` 分支存在时才恢复）。

## 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| Release 里界面全英文 | 那一轮翻译失败或没配 key，注入的是空字典 | 已修复：无字典时回退 `seed.zh-cn.json`；两者都空时构建直接失败 |
| `coverage below the 80% floor` | 网关/模型/Key 不对，每批都失败 | 检查三个 `ZH_TRANSLATE_*` secret；临时放宽可设 `ZH_CN_MIN_COVERAGE` |
| 菜单中文、界面英文（或反之） | 两次注入读了不同来源的字典 | 已修复：`patch-native.mjs` 与 `postbuild.mjs` 用同一回退顺序 |
| 构建报 `Target aarch64 does not exist` | `--target` 只接受完整三元组 | 用 `aarch64-apple-darwin` |
| 签名报错 / updater 校验失败 | 上游 `createUpdaterArtifacts: true`，没有签名密钥 | 覆盖配置已关掉；`signingIdentity` 设为 `-`（ad-hoc） |
| `找不到 DMG` | `--bundles dmg` 会清掉 `.app`，`verify.mjs` 无从校验 | 用 `--bundles app,dmg` |
| 拷出的 DMG 打不开 | 未公证 | 右键 → 打开，或 `xattr -dr com.apple.quarantine /Applications/MonoCode.app` |
| 菜单点开还是英文 | 前端推送快捷键覆盖重建了整份菜单 | 已修复：`menu.rs` 的 `set_menu` 之后立刻重新本地化 |
| 新版本没有新 Release | 版本号没变，且本次推送没碰 `tools/zh-cn/`，gate 判定已发布 | 手动 `workflow_dispatch` 勾 `force` |

## 已知边界

- 运行时层只替换**完全匹配**的文本，所以带插值的句子依赖 `{0}` 模板（`Open {0}` 这类）。模板是否算文案由 `lib/collect.mjs` 判定：全部 token 都是 Tailwind/CSS utility、或形如 `translateY({0}px)`、`{0}px minmax(0, 1fr)`、`commit:{0}:{1}`、`<xml>{0}</xml>`、`Ultrathink:\n{0}` 的排除。
- 判定规则只认**结构**，不认串的形状。历史教训：靠「小写单词多于 5 个就是关键词堆」「首字母必须大写」「占比 >0.4 就算 CSS」这类启发式，先后误杀了 `Command Palette`、`does not support manual compaction`、`Sign in required`、`(optional)`、`Model: {0}`。要排除一类串，就找它的 AST 特征（`keywords:` 属性、`split()` 实参）或确定的非文案语法。
- JSX 的 `&apos;` 等实体在渲染前被解码，字典键必须存**解码后**的形态，否则永不匹配。
- React 把 `text {expr} text` 渲染成多个相邻文本节点。运行时会把相邻文本节点拼起来再匹配（`splitSentences`），但**不跨越元素边界**——中间的元素可能承载用户内容。
- 模式表按**具体度**排序后匹配：先比字面字符数（多者优先），再比槽位数（少者优先）。否则通用键 `{0} details` 会抢在 `{0} usage details` 前命中，把 `usage` 留在英文里。
- 模式命中后，槽位里捕获到的内容会再查一次**精确表**（不再跑模式，避免递归）。这解决 `${live ? "Running" : "Ran"} ${n} subagents` 这类「插值本身也是文案」的情况。
- 枚举值靠**结构**识别：`===`/`!==` 一侧、`case` 后的字面串是程序匹配用的值，不是文案。JSX 子节点、UI 属性、UI 属性名（`title`/`label`/`description`…）才是渲染面。
- 中文不区分单复数，`${n} ${n===1?"model":"models"} available.` 的第二个占位符会被译文丢掉；运行时按顺序替换，缺的槽位不渲染。
- JSX 里的三元、`&&`、`??` 会被展开取全部分支，所以 `available ? "${n} models available." : hint()` 两个分支都能译到。
- `code`/`pre`/`kbd`/`textarea`，以及带 `translate="no"` 或 `cm-content` 类的节点不翻译，避免动到用户内容与代码编辑器。
- 没有 Apple Developer 证书时产物是 ad-hoc 签名、未公证：首次打开需右键 → 打开，或 `xattr -dr com.apple.quarantine /Applications/MonoCode.app`。
- 上游若重命名菜单 id 或改文案，`zh_cn.rs` 的 `BY_ID`/`BY_TEXT` 会按新抽取结果自动重建；没覆盖到的项保持英文而不是报错。
- 「保持英文」的键若含换行，`keep.txt` 一行一条表达不了，写进 `keep.json` 的 `keys` 数组。
- 机器翻译会出错，尤其是长句。纠错优先级：`overrides.json`（人工订正，最高） > `glossary.json`（术语） > 模型输出。
- 审计输出里剩下的多为例值（`https://gitlab.com`、`feature/my-task`、`glpat-…`）、品牌名与路径，属于预期不译。`node tools/zh-cn/audit.mjs` 会打印它们及出处；`node tools/zh-cn/audit-all.mjs --limit 100000` 关掉全部启发式，列出 AST 看到的一切，用来确认规则没漏掉真文案。
- 本机验证范围：菜单栏、菜单项与注入字典已实测；界面正文用 happy-dom 跑运行时脚本验证，未做真实窗口截图（受屏幕锁定限制）。
