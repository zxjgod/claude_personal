# 更新日志

> `claude_personal` 的变更记录。**每次修复 bug 或更新功能后在此追加一条**，让某个子功能日后出问题时可以「查表回溯」——是哪次改动引入的、改了哪些文件、当时为什么这么做、对应哪次 commit。
> 配套：定位看 [`../项目架构.md`](../项目架构.md)，改动方法看 [`../模块维护方案.md`](../模块维护方案.md)。

## 为什么要写

更新与排查是一对：更新时留下「改了什么、为什么」，排查时就能从现象反查到那次改动。没有这条记录，每次 bug 都要重新通读代码。所以约定：**任何用户可感知的改动都留一条日志**，并在下面两张索引里登记。

---

## 何时必须写

- 修复任何**用户可感知的 bug**（卡死、显示错乱、崩溃、退出码异常等）→ 写一篇 `fix`。
- 完成一个**里程碑或成体系的新特性**（如 `/effort`、TUI 重做、一批新工具）→ 写一篇 `feature`。
- 改动**跨多文件**或动了**核心机制**（agent-loop / 权限 / 进程管理 / provider 路由 / 持久化）→ 无论是否 bug 都记录受影响文件与设计决策。
- **复杂/难复现问题**：动手前先写一篇 `analysis`（结论先行 + 调用链 + 复现实验 + 修复建议），修完再写 `fix` 并互链。

可不单独写：纯本地实验、未落盘、纯文档/注释微调（可并入相关条目）。

---

## 怎么写

1. 复制 [`_模板.md`](./_模板.md)，按命名规则起名，填好头部元信息块与各章节。
2. 在本文件的**两张索引**各加一行/一项（按日期 + 按模块）。
3. 涉及计数变化（文件/命令/工具/测试数）时，顺手用《模块维护方案》末尾的核对命令更新《项目架构.md》的数字。

### 命名规则

`YYYYMMDD-<英文短横线主题>[-类型后缀].md`，全小写英文/拼音 kebab-case，日期前置便于排序：

- 修复类：`20260626-bash-deadlock-fix.md`
- 分析类：`20260626-bash-deadlock-analysis.md`（放 `analysis/` 子目录）
- 特性/里程碑类：`20260620-terminal-ui.md`（无 `-fix` 后缀）
- 同日多篇用主题区分；**同一问题当日二次修复不另起文件**，在原文件追加「七、二次修复（同日）」小节。

### 目录布局

```
docs/更新日志/
  README.md          ← 本文件：索引 + 约定（唯一入口）
  _模板.md           ← 复制用模板
  YYYYMMDD-*.md      ← 修复/特性日志（条目多了可按 2026/ 年份分目录）
  analysis/          ← 深度分析（*-analysis.md），与对应 fix 互链
```

> 历史日志仍在 [`../archive/`](../archive/)（数字偏旧、只读归档），已在下方索引登记，不迁移文件、只建索引。

### 必记的可追溯字段

每篇头部元信息块至少含：**日期**、**类型**(fix/feature/analysis)、**模块/子系统名**、**主题一句话**、**受影响文件全路径清单**（按 新增/修改/删除 分组）、**根因定位到 文件:行号**、**关联 commit**、**相关测试**（新增用例名 + 通过数新旧对比）、**验证命令与实测结果**、**关联文档链接**。

---

## 索引 ①：按日期（倒序）

| 日期 | 类型 | 模块 | 主题 | commit | 关联 |
|---|---|---|---|---|---|
| 2026-07-06 | fix | TypeScript / TUI 测试 | [修复类型收窄错误和 TUI 滚动测试超时问题](./20260706-typecheck-tui-timeout-fix.md) | 待提交 | — |
| 2026-07-04 | feature | TUI / commands / theme | [Shift+Tab 模式切换体验优化（Toast 反馈、帮助面板、/mode 命令、状态栏颜色）](./20260704-m38-mode-switch-ux.md) | 待提交 | [M38 计划表](../archive/M38计划表-指令深化与权限模式.md) |
| 2026-07-02 | feature | commands / sessions / compact / effort / permissions / TUI | [M38 `/` 指令深化（effort 定义、sessions 删除、compact 进度条）+ Shift+Tab 权限模式即时切换](./20260702-m38-command-permission-mode.md) | 待提交 | [M38 计划表](../archive/M38计划表-指令深化与权限模式.md) |
| 2026-07-02 | feature | TUI / theme / spinner-core / InputBox / CommandPicker | [角色分色（`theme.ts`）+ 思考态趣味动词循环（`verbAt`）+ `/help` 命令面板（方向键选择 + 视口滚动）](./20260702-tui-role-color-verb-command-palette.md) | 待提交 | — |
| 2026-06-29 | fix | TUI / FullScreenApp / InputBox / ScrollView | [全屏 TUI 实测修复（光标漂移 prompt 末行、busy 变色/缩小、Ctrl+U/D 滚动）+ 抽 FullScreenApp 独立模块解耦](./20260629-fullscreen-tui-fixes.md) | 待提交 | [M25 计划表](../archive/M25计划表-全屏TUI.md) |
| 2026-06-29 | feature | TUI / InputBox / 全屏布局 | [M25 多行输入（Ctrl+J / 行间光标）+ 可选全屏布局（alt-screen / ScrollView 回看，默认关）](../archive/M25计划表-全屏TUI.md) | 7db7a98 | [M25 计划表](../archive/M25计划表-全屏TUI.md) |
| 2026-06-28 | fix | TUI / store / InputBox / 流式响应 | [M24 TUI 响应平滑 + 输入框稳定（帧合批 + 字段订阅 + 流式区隔离 + 分隔线留 1 列治跳位）](./20260628-m24-tui-smoothing.md) | 待提交 | [M计划表 §十一 M24](../archive/M计划表-对齐CCB.md) |
| 2026-06-28 | feature | TUI / 状态行 / 流式响应 | [M23 TUI 体验对齐参考版（StatusLine / SpinnerGlyph / StreamBuffer / spinner-core）](./20260628-m23-tui-statusline.md) | 待提交 | [M计划表 §七 M23](../archive/M计划表-对齐CCB.md) |
| 2026-06-28 | feature | provider 路由 / 配置 | [`/provider` 多 API 端点档案热切换（中转站/国内平台免重启切换）](./20260628-provider-profiles.md) | 待提交 | [M计划表 §六 M22](../archive/M计划表-对齐CCB.md) |
| 2026-06-28 | feature | 测试基建 / 集成测试 | [M21 测试广度（5 大集成测试 + CI 冒烟元测试，508→613）](./20260628-m21-testing.md) | 待提交 | [M计划表](../archive/M计划表-对齐CCB.md) |
| 2026-06-28 | fix | TUI / InputBox | [`/` 命令面板陈旧选中索引越界崩溃修复](./20260628-inputbox-stale-suggestion-crash-fix.md) | 待提交 | — |
| 2026-06-28 | feature | 工程基建 / CI / 构建 | [M20 工程化对齐（Biome / esbuild / 冒烟 / husky / CI）](./20260628-m20-engineering.md) | 待提交 | [M计划表](../archive/M计划表-对齐CCB.md) |
| 2026-06-28 | feature | TUI / resume | [/resume 交互式 Session Picker（方向键 + 滚动窗口 + 历史回放）](./20260628-resume-session-picker.md) | 待提交 | — |
| 2026-06-26 | fix | BashTool / agent-loop / permissions | [Bash 工具死循环 / 转圈卡死修复](../archive/bash-deadlock-fix-20260626.md) | ecabdae | [analysis](../archive/bash-deadlock-analysis.md) |
| 2026-06-26 | analysis | BashTool / 进程管理 | [Bash 死锁根因分析](../archive/bash-deadlock-analysis.md) | — | [fix](../archive/bash-deadlock-fix-20260626.md) |
| 2026-06-26 | fix | TUI 终端界面 | [终端界面 bug 修复](../archive/终端界面bug修复-20260626.md) | — | — |
| 2026-06（里程碑） | feature | 终端渲染层 | [终端界面对齐记录](../archive/更新日志-终端界面.md) | — | — |
| M1–M6（里程碑） | feature | 全局 | [M 计划实现日志](../archive/M计划更新日志.md) | — | 仅到 M6，已断档 |

> 新条目加在表格**最上方**。

## 索引 ②：按模块（出 bug 时从这里查某子功能的历次改动）

> 某个子功能再出问题时，先在这里找它涉及过哪些日志，再顺藤摸瓜到 commit 与设计决策。

- **BashTool / 进程管理**：`bash-deadlock-fix-20260626`（spawn + taskkill 进程树 + timedOut 标志 + 非并发安全）、`bash-deadlock-analysis`（根因）。
- **agent-loop 并行 / abort**：`bash-deadlock-fix-20260626`（并行路径加 abort 竞速）。
- **permissions 危险命令拦截 / 权限模式**：`bash-deadlock-fix-20260626`（补充易致死命令静态拦截）、`20260702-m38-command-permission-mode`（M38：`ToolContext.getPermissionMode`/`setPermissionMode` 实时模式；TUI Shift+Tab 循环 `default → acceptEdits → bypassPermissions → plan`；安全地板仍在 bypassPermissions 前执行）、`20260704-m38-mode-switch-ux`（Toast 视觉反馈、`?` 帮助面板、`/mode` 命令、状态栏模式颜色区分）。
- **TUI 启动 / 渲染**：`终端界面bug修复-20260626`、`更新日志-终端界面`（渲染层对齐）、`20260628-m23-tui-statusline`（状态行对齐参考版：`spinner-core` / `StatusLine` / `SpinnerGlyph` / `StreamBuffer`，删除 `ParticleSpinner` 与 `ink-spinner`）、`20260628-m24-tui-smoothing`（M24：帧合批 `scheduleEmit`/`flush`/`setBatching`、字段切片订阅 `useStoreSelector`、`App` 拆六区域组件、流式区隔离、分隔线 `cols-1` 治 DECAWM 跳位；同时去 `/keybindings` 不实宣传、标注 M15.1/M17 漂移已回退）、`20260702-tui-role-color-verb-command-palette`（新增 `theme.ts` 统一角色分色；`spinner-core` 新增 `verbAt`/`VERB_CYCLE_MS` 时间驱动趣味动词循环接入 `StatusLine`）、`20260702-m38-command-permission-mode`（状态栏显示当前 mode，Shift+Tab 忙碌中也可即时切换权限模式）、`20260704-m38-mode-switch-ux`（FullScreenApp 独立 Shift+Tab 处理；Toast 居中通知；`?` 键弹出帮助面板含模式说明；`/mode` 命令；状态栏单行显示，模式名称带颜色区分）。
- **TUI 多行输入 / 全屏布局（M25）**：`M25计划表-全屏TUI`（M25.1 InputBox 多行 Ctrl+J / `\`+Enter / 行间光标 / 行内 Home·End；M25.2 可选全屏 `--fullscreen`：自造 `ScrollView` + `useTerminalSize` + `transcript-lines`，alt-screen 生命周期退出必复位）、`20260629-fullscreen-tui-fixes`（实测三修：① prompt 做成最后渲染行根治光标漂移；② `keepColorWhenDisabled`/`hideBottomRule` + 撤固定 width 治变色缩小；③ flex+`measureElement` 自测高度 + Ctrl+U/D/B/F/G 滚动兜底；并抽 `FullScreenApp.tsx` 独立模块，App.tsx 仅一委托分支，默认路径零回归）。
- **工程基建 / CI / 构建**：`20260628-m20-engineering`（M20：Biome 替 eslint+prettier、esbuild 转译构建、免 key 冒烟脚本、husky+lint-staged pre-commit、GitHub Actions CI、`.gitattributes` 强制 LF、cli `--version/--help`）。
- **测试基建 / TypeScript 类型 / TUI 测试**：`20260706-typecheck-tui-timeout-fix`（修复 `path-security.test.ts` discriminated union 类型收窄问题 + `tui-components.test.tsx` 滚动测试超时问题，978/978 测试全过）。
- **测试基建 / 集成测试**：`20260628-m21-testing`（M21：tools/permissions/persistence/MCP/TUI 五大集成测试 + CI 冒烟元测试，508→613；真 git worktree 提交隔离、真 MCP SDK stdio/http mock server、分类器短路顺序、resume 折叠、30 轮长会话 store 不变量）。
- **TUI overlay / resume**：`20260628-resume-session-picker`（裸 `/resume` 弹 sessionPicker overlay、`nextOffset` 滚动窗口、`history-replay` 把 `Message[]` 回放进 transcript、零 token 恢复）。
- **provider 路由 / 配置**：`20260628-provider-profiles`（`/provider`：`.claude/providers.json` 存多套 `(provider/baseURL/apiKey/model)` 档案，TUI 方向键 overlay / `/provider <name>` 直切，`applyProfile` 原地改 `modelConfig`；`cli.ts` 把 `callModel` 改为按 provider 现解析以支持家族切换；不做 M22）。
- **斜杠命令 `/effort` / `/sessions` / `/compact` / `/mode`**：`20260702-m38-command-permission-mode`（M38：`/effort` 明确 6 档定义与供应商映射；`/sessions delete <prefix|id>` 唯一匹配删除历史会话；`/compact` 展示阶段式进度条）、`20260704-m38-mode-switch-ux`（新增 `/mode` 命令，支持直接设置权限模式）。
- **全局里程碑**：`M计划更新日志`（M1–M6，后续断档，新特性请补登）。

> 新条目按「模块名: 日志（一句话改了什么）」追加到对应键下；模块名沿用《项目架构.md》的称呼。

---

## 状态约定

为方便回答「这个功能现在到底是好是坏、谁动过它」，建议在日志里标注四态之一并在涉及的 P0/P1 缺口处更新：

`已落地` / `进行中` / `已回滚` / `已知未修`。

当前已知未修缺口（详见 [`../项目评审报告.md`](../项目评审报告.md) 与 [`../模块维护方案.md`](../模块维护方案.md) 的「高风险区」）：default 模式 bash 审批链、子代理 askUser 透传、MCP 默认免审批、web-fetch SSRF、generateSimpleDiff、TUI expandedId 未接上。
