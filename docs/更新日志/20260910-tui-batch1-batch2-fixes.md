# 更新日志 — TUI 修复第一批 + 第二批（真 bug / 死链 / 官方对齐缺口）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-09-10
> 类型：fix | feature
> 模块：TUI（theme / HelpPanel / pickers / tool-output）、commands（copy / release-notes）、tools（edit / diff）、测试基建
> 主题：修掉 6 个用户可见的真 bug、新增 `/copy` 与 `/release-notes` 两个命令、给 diff 补行号槽、消除 CI 抖动，并订正一处文档吹嘘
> 状态：已落地
> 验证：`npx tsc --noEmit` 0 错误、`npx biome check src` 0 error、`npx vitest run` **129 文件 / 1661 用例全绿**
> 关联文档：`TUI官方对齐方案.md`（D2/D3）、`20260906-TUI官方对齐批次B.md`（B5）、`20260908-TUI审查热修第二批.md`

---

## 一、现象 / 用户反馈

2026-09-07 的 TUI 三层审查留下一份待办清单。本次逐条**核验后**修复，发现清单本身也有过期与误报（见第五节）。实际修复的问题：

| # | 现象 |
|---|------|
| 1 | 启动 banner 的 "What's new" 栏宣传 `/release-notes for more`，但**该命令不存在** —— 输入后落到技能展开，行为不可预期 |
| 2 | `/theme light` 切换后，`ModelPicker` 的边框/高亮仍是暗色蓝，`ProviderPicker`/`SessionPicker` 仍是 ANSI `cyan`；上下文告警行与权限提示的高危徽章仍是暗色红 |
| 3 | 帮助面板（`?`）里权限模式列表顺序是 `default→acceptEdits→bypassPermissions→plan`，而**同一面板下一行的快捷键说明**写的是 `…→plan→bypassPermissions` —— 自相矛盾 |
| 4 | 编辑文件的 diff 没有行号，而同一 UI 里 write 的代码预览**有** 4 列行号槽 —— 两种呈现不一致 |
| 5 | 全量测试在 CI 上间歇性红：`PgUp opens the transcript review pager` 超时、`p0-tui-features` 的 Esc 用例断言失败，单跑却全绿 |

---

## 二、根因

| # | 根因 | 位置（文件:行） | 后果 |
|---|------|----------------|------|
| 1 | banner 写死了一个从未注册的命令 | `src/tui/banner.ts:100-103` | 死链 |
| 2a | 模块级 `const ACCENT = "#5769f7"` 冻结了**暗色** `palette.permission`，`applyTheme()` 改不动 | `src/tui/ModelPicker.tsx:20` | 浅色主题下仍是暗色蓝 |
| 2b | 裸 ANSI 名 `"cyan"`，根本不经过 palette | `src/tui/ProviderPicker.tsx:20`、`src/tui/SessionPicker.tsx:20` | 完全不跟主题 |
| 2c | `RISK_LEVELS` 表与 `App.tsx` 的告警行硬编码 `#f7768e`/`#e0af68`（暗色值） | `src/tui/Prompts.tsx:28-32`、`src/tui/App.tsx:440` | 浅色主题下错误红仍是暗色 |
| 3 | MODES 数组是手写的旧顺序，与 `store.ts` 的 `PERMISSION_MODE_CYCLE` 各写各的 | `src/tui/HelpPanel.tsx:15-29` | 两处真源漂移 |
| 4 | diff 由 `generateSimpleDiff` 生成，**丢弃了行号位置**（LCS 走完后只 push 文本） | `src/tools/utils/diff.ts:14` | 渲染层无从得知行号 |
| 5 | 测试用**固定 sleep 赌** Ink 的 ~20ms ESC 消歧计时器已经触发（`escFlush()` 睡 60ms；PgUp 用例睡 10ms），并行负载下事件循环被饿死则赌输 | `src/__tests__/p0-tui-features.test.tsx:43`、`src/__tests__/tui-components.test.tsx` | 单跑绿、全量红 |

**机制（第 4 条）：** 行号不能在渲染层靠「数渲染出来的行」恢复 —— diff **跳过**了未变行，计数必然漂移。位置只能由 LCS 行走过程本身记录，所以修复落在 diff 生成侧，而不是渲染侧。

---

## 三、改动明细

### 1. `/release-notes`（新命令）

`src/commands/release-notes.ts`：读取随包发布的 `docs/CHANGELOG.md`（用与 `version.ts` 相同的双候选 `package.json` 探测法定位包根，dev / dist / 全局安装三种布局都成立）。

- `/release-notes` → 只显示最新一条（按 `## ` 标题切分）；
- `/release-notes all` → 全量；
- 默认截断 60 行，超出的提示去 `all` 或直接读文件。

包根探测有单测断言「解析出的目录里确实存在 package.json」，避免候选顺序写错时静默返回错目录。

### 2. `/copy`（新命令）

- `src/utils/clipboard-text.ts`：把文本送进系统剪贴板，与既有 `tui/clipboard-image.ts`（读图）对称。各平台原生工具从 stdin 读：win32 `clip.exe`（经 `SystemRoot` 解析）、darwin `pbcopy`、linux `wl-copy` 后 `xclip`。**任何失败路径都 resolve(false) 而非抛异常**。
- `src/commands/copy.ts`：`lastAssistantText()` 从后往前找最近一条**有正文**的 assistant 消息 —— 纯工具调用的回合 `content === null`，会继续往前找，不会把空答复当结果。

### 3. 主题快照（3 处）

按 `theme.ts` 头部注释要求的模式，全部改为**渲染时读** `palette`：`ModelPicker`、`ProviderPicker`、`SessionPicker`、`RewindPicker`、`SpinnerGlyph`（默认参数）改用取值函数；`Prompts.tsx` 的 `RISK_LEVELS` 改为存 palette 键名 + `riskColor()` 解析；`App.tsx` 的告警行改用 `palette.error`/`palette.warning`。

### 4. 帮助面板重排 + 双语（D3）

`src/tui/HelpPanel.tsx` 重写：

- **模式列表改为直接 map `PERMISSION_MODE_CYCLE`** —— 与 Shift+Tab 处理器同一个常量，结构上不可能再漂移（这是第 3 条根因的正解，而非把数组顺序改对一次）；
- 全部文案入 `i18n.ts`（en + zh-CN 各 31 条新键），键名列保持字面量（键名不是文案）；
- 宽度自适应：面板宽 `clamp(终端宽-2, 56..78)`，键名列由最宽键名算出，用 `padAligned`/`visualWidth` 按**视觉宽度**对齐（原先硬编码 `padEnd(22)`，`Ctrl+← / Ctrl+→` 这类宽字符会错位）。

### 5. diff 行号槽

`src/tools/utils/diff.ts`：把 LCS 走法抽成 `lcsChanges()`，返回每行**在旧/新片段中的绝对位置**。

- `generateSimpleDiff()` 输出**逐字节不变** —— 它是模型读到的工具结果；
- 新增 `diffDisplayLines(oldStr, newStr, startLine)` 供显示层用；
- `edit.ts` 从匹配偏移算出 `startLine`（`content.slice(0, idx).split("\n").length`），经 `metadata.diffLines` 传给渲染层 —— 与 write 的 `codePreview` 同一套路，**模型侧内容不动**；
- `tool-output.ts` 新增 `renderNumberedDiffLine()`，4 列行号槽与 write 预览对齐；无 metadata 时（旧会话、回放历史）自动回落到原路径。

### 6. 消除测试抖动（第 5 条）

根因是「固定 sleep 赌异步调度」，不是超时值太小 —— 所以**两件事都做**：

- 新增 `waitFor(cond)` 轮询助手，把 PgUp、`p0-tui-features` 的三个**正向**断言从「睡 60ms 后断言」改为「轮询直到成立或 2s 超时」。反向断言（「什么都没发生」）没有条件可轮询，保留 `escFlush()`；
- `vitest.config.ts` 的 `testTimeout` 提到 20s，作为第二轮兜底。

### 7. 文档订正

`docs/项目总览.md` 的「最新成果（2026-08-20 晚）」原本写着「实现 DesignSync — **达成 100% 功能对齐！**／实现了官方全部 47 个工具／0 个遗留功能」。实际 `src/tools/extended/design-sync.ts:93-101` 的 `call()` 永远返回 `not implemented`，且 `isEnabled: () => false` 把它排除在启用集外。已就地订正并保留订正记录。

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过，0 错误 |
| `npx biome check src` | 通过，0 error（warnings 不影响 CI 门禁） |
| `npx vitest run` | **129 文件 / 1661 用例，全绿**（109s） |
| 新增回归用例 | `diff-lines.test.ts`(8)、`copy-command.test.ts`(6)、`release-notes-command.test.ts`(6)、`help-panel.test.tsx`(6)、`tool-output-colors.test.ts`(+3) = **+29** |
| 抖动复测 | `input-behaviors` + `p0-tui-features` + `tui-components` 三文件连跑 **95/95 全过**；全量跑亦全绿 |
| 指标复核 | `node --import tsx scripts/doc-sync.mjs` → commands 45 / tools 45 / testFiles 129 |

> 注：本次全量跑**未复现**基线中的 worktree `EPERM` 失败（`integration-tools.test.ts`）—— 该条是 Windows 临时目录的环境性问题，时有时无，与本次改动无关。

---

## 五、核验中推翻的待办（**误报，无需修改**）

清单里这三条经源码核验**不成立**，记录在此避免后人重复调查：

| 待办原文 | 核验结论 |
|---|---|
| 「exit-hint 时长 3s 与官方 800ms 窗口不符」 | **误报。** `docs/更新日志/20260906-TUI官方对齐批次B.md` 的 B5 条明确写着「双击 **800ms** 退出，footer 提示 **3s** 自动熄灭」—— 提示活得比手势窗口长是**有意设计**（提示要可读，且每次按键都会重新武装它）。改动保留为把两个时长提成具名常量 `EXIT_DOUBLE_PRESS_MS`(800) / `EXIT_HINT_MS`(3000) 并写清为何不能统一，**行为不变**。 |
| 「exit-hint 文案三处重复硬编码未入 i18n」 | **误报。** `store.ts:307/546`、`run.tsx:1389` 三处都是**注释**，不是用户可见文案；真正渲染的那句在 `PromptFooter.tsx:69` 早已走 `t("ui.footer.exitHint")`。 |
| 「docs/CODE_MODULES.md 与 PROJECT_TREE.md 描述了不存在的模块，按文档排查会踩空」 | **误报。** 两份文档开头都写明解析自 `cc-recovered-main`（逆向恢复的**官方**工程），描述的是参考实现而非本仓库 —— 那里 `src/commands/release-notes`、`src/components/StructuredDiff` 确实存在。 |

同时，`docs/局限性说明.md` 至少三条**已过期且方向相反**（它在唱衰）：称 LSP「未实现，只是调 tsc」，实际 `src/lsp.ts:80` 已是自研 tsserver 长连接 JSON-RPC 客户端；称 speculation「默认关闭」，实际 `src/cli-repl.ts:333` 明确 ON by default；称 TODO/FIXME「34 处」，实际严格正则下 `src/` 中**一处也没有**。

---

## 六、受影响文件

**新增**
- `src/commands/release-notes.ts`、`src/commands/copy.ts`、`src/utils/clipboard-text.ts`
- `src/__tests__/diff-lines.test.ts`、`src/__tests__/copy-command.test.ts`、`src/__tests__/release-notes-command.test.ts`、`src/__tests__/help-panel.test.tsx`

**修改**
- `src/tui/`：`HelpPanel.tsx`（重写）、`tool-output.ts`、`ModelPicker/ProviderPicker/SessionPicker/RewindPicker/SpinnerGlyph.tsx`、`Prompts.tsx`、`App.tsx`、`store.ts`、`run.tsx`、`i18n.ts`
- `src/tools/`：`utils/diff.ts`、`core/edit.ts`
- `src/commands/registry.ts`、`src/types.ts`
- `src/__tests__/`：`tool-output-colors.test.ts`、`p0-tui-features.test.tsx`、`tui-components.test.tsx`
- `vitest.config.ts`、`docs/项目总览.md`

---

## 七、设计决策记录

1. **行号走 metadata，不改模型看到的输出** —— `generateSimpleDiff` 是模型读到的工具结果，往里塞行号会改动 agent 的上下文。改用 `metadata.diffLines` 走显示专用通道，与既有的 `codePreview` 完全同构。代价是 diff 要算两遍；换来的是工具结果零行为变化。
2. **模式列表 map 常量，而不是把顺序改对一次** —— 只改数组顺序治标不治本，两处真源迟早再次漂移。改为引用 `PERMISSION_MODE_CYCLE` 后，结构上不可能不一致。
3. **两个 exit 时长各自具名，明确「不要统一」** —— 我一度把它们统一成 800ms，导致 `input-behaviors.test.tsx` 失败；查 B5 规格后确认 3s/800ms 的差异是有意设计，遂回退行为并把理由写进常量注释。
4. **抖动修因不修表** —— 只提 `testTimeout` 是掩盖；真正根因是「固定 sleep 赌调度」，所以主修是 `waitFor` 轮询，超时提升只作兜底。
5. **新增 `/release-notes` 而非删掉 banner 那行** —— 官方确有该命令，实现它更接近"复刻"目标，也让 banner 的宣传成真。
