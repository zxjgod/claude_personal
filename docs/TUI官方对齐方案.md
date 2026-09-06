# TUI 官方对齐方案（2026-09-06）

> **执行状态**：
> - ✅ **批次 A（视觉骨架）已完成并通过验收**（2026-09-06）——按决策 1-A/2-A/3-A/4-A/5-B 执行：默认英文、官方极简 footer、先 A 批验收、Ctrl+O 展开语义、官方 188 动词全量。含两轮代码审查修复与用户真机反馈三修（底线补回为完整 ╭╮╰╯ 圆角框、Spinner 平台帧序列 Windows ✳→`*` + 动词橙色恢复、PromptFooter key 警告消除）。测试 1438 → 1476（全绿），tsc/lint/build 通过。详见 [完成报告](./更新日志/20260906-TUI官方对齐批次A.md)。
> - ✅ **批次 B（输入行为）已完成**（2026-09-06）——`!` bash 模式、`#` 记忆前缀、Ctrl+R 历史搜索（内联 reverse-i-search，工具卡展开完全退役由 Ctrl+O 查看器承接）、Ctrl+S 暂存草稿、Ctrl+G $EDITOR 编辑草稿、Ctrl+T todos 收展（含 Next: 行）、Ctrl+D/L、空闲 Ctrl+C 清空→双击退出（footer exit 提示）、排队消息 dim 可视化 + ↑ 取回、双击 Esc 800ms、Alt+P 模型选择器、Alt+T thinking 开关。测试 1476 → 1494（全绿）。详见 [批次 B 完成报告](./更新日志/20260906-TUI官方对齐批次B.md)。
> - ⏳ 批次 C（模式与状态流）、批次 D（打磨）待启动。

> 目标：**对齐官方 Claude Code 的 TUI 界面体验**（视觉骨架 + 交互行为 + 状态功能三层）。
> 信息源（四路交叉验证，均为一手资料）：
> 1. 本机官方 `claude 2.1.202`（npm 包二进制内嵌 bundle 的字符串/键位表提取）
> 2. 官方反编译参考源码 `C:\Users\20616\Desktop\claude test\src\src\`（REPL/PromptInput/keybindings/theme 等完整 TUI 层）
> 3. 官方文档 code.claude.com/docs/en/interactive-mode（2026-09 最新快捷键全表）+ /statusline 文档
> 4. 本仓库现状（两轮全量代码审读：src/tui 41 个文件 + 关联核心模块）

---

## 一、现状速览：本地 TUI

- **架构**：Ink 7 + React 19；入口 `cli.ts → tui/run.tsx(Root)`；默认 inline 模式（`<Static>` transcript + live 区域），可选全屏备用屏（`FullScreenApp`）。
- **状态**：手写 pub/sub store（`store.ts`，useSyncExternalStore + 16ms 帧合并 + 字段切片渲染）——与官方 `state/store.ts`（34 行手写 createStore）**架构同源，无需重写**。
- **已对齐项**（此前 P0 批完成）：Ctrl+O transcript 查看器（/ 搜索、{}/{}、v 进编辑器）、Esc Esc rewind + 文件还原（checkpoint）、折叠 thinking、重试倒计时、剪贴板贴图、vim 模式、keybindings 覆盖、/resume、排队 type-ahead、@ 补全、多行输入。
- **主要欠账**：①输入框/底栏布局与官方差异大；②中英文文案混杂；③缺 `!`/`#` 前缀模式、Ctrl+R/S/G/T/D/L 键位、队列可视化、plan 审批流、历史持久化等；④spinner/工具行/权限框视觉细节与官方不一致。

## 二、目标画像：官方 TUI 关键设计（提取结论）

### 2.1 布局（inline 模式）

```
╭──────────────────────────────────────────╮   ← 圆角顶边框(仅 top)，灰 promptBorder
│ ❯ 输入区（多行，超过 maxVisibleLines=max(3,│      bash 模式变粉 bashBorder + "! " 提示符
│   rows/2-footer) 内部滚动）                │
╰──────────────────────────────────────────╯
 ⏵⏵ accept edits on (shift+tab to cycle)  ·  claude-opus-4-5 · 86% until auto-compact
 ↑ footer 行：左列 hints（优先级：Press ctrl+c again to exit > Pasting… >
   ctrl+r 搜索框 > -- INSERT -- > 模式指示 `⏸ plan mode on`，全空兜底 `? for shortcuts`；
   busy 时 `esc to interrupt`）；右列 模型/上下文%（官方默认靠 /statusline 命令，右列默认空）
```

transcript 区（进终端 scrollback 的已完成消息）：
- 用户消息：`> 文本`，dim 灰（浅灰背景块 userMessageBackground，简版布局无背景）
- 工具行：`⏺ ToolName(参数)` — 工具名 **bold**；点三态：dim●（运行中，闪烁）→ 绿●（成功）→ 红●（失败）；排队中 dim●
- 结果行：`  ⎿  `（2 空格+⎿+2 空格）**dim** 缩进列，嵌套内容不重复 ⎿
- 截断处：`(ctrl+o to expand)` dim
- bash 模式消息：`! cmd`（! 为粉色 bashBorder）；记忆消息：`#` remember 色带背景

### 2.2 Spinner

- glyph 帧序列 `· ✢ ✳ ✶ ✻ ✽` + 逆序（11 帧），**120ms/帧**；颜色 claude 橙 `rgb(215,119,87)` + shimmer `rgb(245,149,117)`
- 动词：**mount 时采样一次固定**（不是轮换！），官方 188 词表（Accomplishing…Zigzagging，含 Clauding/Prestidigitating）；可被 currentTodo.activeForm/subject 覆盖
- **stall 检测**：3 秒无新 token，glyph 颜色向红色 `rgb(171,43,63)` 插值告警
- thinking 模式：`thinking…` 最少显示 2s，结束显示 `Thought for Ns` 再 2s
- spinner 下方 dim 行：有 todos 时 `Next: <下一个任务>`；否则 `⎿ Tip: ...`（tipScheduler 按 cooldownSessions 挑选）；>30min 提示 /clear、>30s 提示 /btw

### 2.3 权限对话框

- permission 蓝 `rgb(87,105,247)` + 顶部 `▔`(columns) 分隔线
- 选项（数字+y/n）：`1. Yes` / `2. Yes, and don't ask again for commands in <dir>`（bash）/ `Yes, and always allow access to <path>`（文件类）/ `3. No, and tell Claude what to do differently (esc)`
- 对话框内 **shift+tab 直接切权限模式**；ctrl+e 展开解释

### 2.4 模式系统（footer 文字表达，边框颜色不随权限模式变）

| 模式 | 符号 | 颜色 | footer 文案 |
|---|---|---|---|
| default | （不显示） | text | — |
| acceptEdits | ⏵⏵ | 紫 rgb(135,0,255) | `⏵⏵ accept edits on (shift+tab to cycle)` |
| plan | ⏸ | teal rgb(0,102,102) | `⏸ plan mode on (shift+tab to cycle)` |
| bypassPermissions | ⏵⏵ | 红 | `⏵⏵ bypass permissions on (shift+tab to cycle)` |

- **循环顺序：default → acceptEdits → plan → bypassPermissions**（本地现为 default→acceptEdits→bypass→plan，顺序错了）
- plan 审批流：ExitPlanMode 工具 → `Ready to code?` 面板（计划全文 + Requested permissions + `Would you like to proceed?` + `ctrl+g edit in editor`）→ 批准即切 acceptEdits（本地 plan 目前只是挡板，无审批 UI）

### 2.5 关键交互（与本地差异标 ★）

| 键/前缀 | 官方行为 | 本地现状 |
|---|---|---|
| `/` `@` | 命令/文件补全 | ✅ 已有 |
| `!` | bash 模式：直跑 shell、输出进上下文、Claude 自动回应；光标在 0 时 esc/backspace/ctrl+u 退回 | ★ 无 |
| `#` | 快速记忆：追加写入 CLAUDE.md，# 渲染为 remember 色块 | ★ 无 |
| Enter 多行 | `\`+Enter / shift+enter / ctrl+j | ✅（缺 shift+enter 探测，终端依赖） |
| ↑/↓ | 多行光标优先，移不动才翻历史 | ✅ 逻辑一致 |
| Esc | 链：关面板→收队列消息回输入框→空输入+空闲双击(800ms)rewind | ★ 队列收回无；双击窗口 2s≠800ms |
| Esc busy | 中断，事后 `Interrupted · What should Claude do instead?` | ★ 文案不同 |
| Ctrl+C | busy 中断；空闲清输入→双击退出（footer 显示 `Press ctrl+c again to exit`） | ★ 空闲一击即退 |
| Ctrl+D | 双击 800ms 退出 | ★ 无 |
| Ctrl+O | toggle 详细 transcript（verbose 全量+时间戳+模型） | ✅ 大体一致，缺 ctrl+e 展开/q 退出/footer 文案 |
| Ctrl+R | **历史搜索**（reverse-i-search） | ★ 冲突：本地=展开工具卡 |
| Ctrl+T | todos 展开/收起 | ★ 无（固定显示） |
| Ctrl+S | stash/恢复草稿（含光标） | ★ 无 |
| Ctrl+G | $EDITOR 编辑当前草稿 | ★ 无（仅查看器内 v） |
| Ctrl+V | 贴图 [Image #N]（Win=alt+v） | ✅ 已有 |
| Ctrl+L | 重绘 | ★ 无 |
| Alt+P / Alt+T | 模型选择器 / thinking 开关 | ★ 无 |
| Shift+Tab | 模式循环（顺序见上；Windows 无 VT 用 meta+m） | ★ 顺序不同 |
| 排队 | 消息以 **dim 用户消息显示在输入框上方**，可 Up/Esc 取回编辑；bash 队列 `<bash-input>` | ★ 只有 queued N 计数 |
| Ctrl+滚轮 | scrollback（终端原生） | ✅ |

### 2.6 状态功能

- **rewind**（双击 Esc）：先选消息，再选动作：`Restore code and conversation` / `Restore conversation` / `Restore code` / `Summarize from here` / `Summarize up to here`（带 add context 输入框）/ `Never mind`。本地已有 turn 选择+整体还原，缺二级动作拆分。
- **输入历史**：**跨 session 持久化**（每 project 一文件 + lockfile），去重、大粘贴折叠 `[Pasted text #1 +10 lines]` 外置存储。本地仅内存 100 条。
- **auto-compact**：水位提示为常驻行 `Context low (X% remaining) · Run /compact to compact & continue`（auto-compact 开启时 dim `X% until auto-compact`），非 toast。完成后 `⏺ Summarized conversation`（bold）+ `⎿ Summarized N messages` + `⎿ Context: "..."`（dim）。
- **statusline**：`settings.statusLine`（type:command）自定义命令，JSON stdin（model/cost/context_window/vim.mode 等 30+ 字段），300ms 防抖重跑，渲染在 footer 左列上方；启用时抑制 `? for shortcuts`。
- **状态管理**：官方 messages 在 REPL 组件 useState（不在全局 store），AppState 存 settings/verbose/todos/fileHistory/tasks/mcp 等；本地 transcript-in-store 模式等效，不动。

### 2.7 主题 token（官方 theme.ts）

claude `rgb(215,119,87)`、claudeShimmer `rgb(245,149,117)`、promptBorder `rgb(153,153,153)`、bashBorder `rgb(255,0,135)`、autoAccept 紫 `rgb(135,0,255)`、planMode teal `rgb(0,102,102)`、permission 蓝 `rgb(87,105,247)`、success 绿 `rgb(44,122,57)`、error 红 `rgb(171,43,63)`、warning 琥珀、subtle `rgb(175,175,175)`、remember、userMessageBackground 等；ANSI 降级映射（spinner→redBright、shimmer→yellowBright、dim→blackBright）。字形常量：⏺(darwin)/●(win)、⎿、✻、⏵⏵、⏸、↯。

---

## 三、差距总表与分批方案

分四批：**A 视觉骨架（观感巨变）→ B 输入行为 → C 模式与状态流 → D 精细打磨**。每批独立可交付、可回滚（单 git 分支）。

### 批次 A：视觉骨架对齐（P0）

| # | 项 | 改动 | 主要文件 |
|---|---|---|---|
| A1 | 官方主题 token | theme.ts 引入官方 token 表（含 light/dark/ANSI 降级）+ 字形常量文件 figures.ts（⏺⎿✻⏵⏵⏸↯，Windows 用 ●） | `tui/theme.ts`（新增 `figures.ts`） |
| A2 | **输入框重构** | 上下双横线+`> ` → 官方**圆角顶边框**（仅 top，round）+ `❯` 提示符；bash/记忆等模式换边框色与提示符；输入区超过 `max(3, floor(rows/2)-2)` 行内部滚动；外部编辑器激活时整框替换为 dim italic `Save and close editor to continue...` | `tui/InputBox.tsx`、`tui/App.tsx` |
| A3 | **footer hint 行** | 新建 PromptFooter：左列优先级链 `Press ctrl+c again to exit` > `Pasting…` > 历史搜索框 > `-- INSERT --`(vim) > 模式指示（符号+色+`(shift+tab to cycle)`）> 兜底 `? for shortcuts`（busy 时 `esc to interrupt`）；右列 模型 · ctx%（见决策点 2）；替代现 StatusBar 的 hint 段 | 新建 `tui/PromptFooter.tsx`，改 `StatusBar.tsx`/`App.tsx` |
| A4 | 消息渲染对齐 | 用户消息 dim `> `（去蓝色）；工具行 `⏺ bold Name(...)`，点三态 dim●闪→绿●/红●；结果行统一 `  ⎿  ` dim 缩进；`(ctrl+r to expand)` → `(ctrl+o to expand)` | `ToolCard.tsx`、`transcript-lines.ts`、`run.tsx`（echo 路径）、`history-replay.ts` |
| A5 | Spinner 对齐 | 换官方帧序列+逆序 120ms；动词表换官方 188 词且 **mount 采样一次**；stall 3s 变红插值；thinking ≥2s `thinking…`→`Thought for Ns`；todos 存在时下方 dim `Next: <task>` | `spinner-core.ts`、`StatusLine.tsx` |
| A6 | 文案 i18n 统一 + 版本号 | 全部硬编码中/英文案收进 i18n 表（详见附录清单）；默认语言见决策点 1；banner 版本读 package.json（现硬编码 1.0.0）；中断提示改 `Interrupted · What should Claude do instead?` | `i18n.ts`、`banner.ts`、`run.tsx` 等约 10 文件 |
| A7 | 权限对话框升级 | permission 蓝 + `▔` 分隔线；选项文案对齐官方（bash 加 "Yes, and don't ask again for commands in <cwd>"，文件类加 "Yes, and always allow access to <path>"）；y/n 快捷；**框内 shift+tab 切模式** | `Prompts.tsx`、`theme.ts`、`permissions.ts`（新增选项语义） |

验收：并排截图对比官方（同终端、同字号）；既有 1438 测试全绿 + 新增视觉回归测试。

### 批次 B：输入行为对齐（P1）

| # | 项 | 改动 | 主要文件 |
|---|---|---|---|
| B1 | `!` bash 模式 | 输入以 `!` 开头：粉边框+`! `提示符；Enter 直跑命令、输出以 `> <bash-stdout>` 消息进上下文、Claude 自动回应（可关）；光标==0 时 esc/backspace/ctrl+u 退回普通模式 | `InputBox.tsx`、`run.tsx`、新 `UserBashEcho` 渲染 |
| B2 | `#` 记忆前缀 | `#` 开头：remember 色渲染；Enter 追加写入 CLAUDE.md + 确认行 | `InputBox.tsx`、`run.tsx`、`memory.ts` 已有命令复用 |
| B3 | Ctrl+R 历史搜索 | 内联 reverse-i-search（匹配高亮、Tab/Esc 接受、Enter 接受并执行）；**工具卡展开改绑 Ctrl+O**（打开 TranscriptReview 定位），Ctrl+R 现有展开行为退役（键位让位） | `InputBox.tsx`、新 `HistorySearchInline.tsx`、`run.tsx`(ExpandHotkey) |
| B4 | Ctrl+S / Ctrl+G / Ctrl+T | stash 草稿（text+cursor，再按恢复）；Ctrl+G 调 $EDITOR 编辑草稿（复用 open-editor.ts，含 raw mode 挂起）；Ctrl+T todos 收起/展开（收起时 spinner 下显示 `Next: <task>` 替代） | `InputBox.tsx`、`open-editor.ts`、`TodoList.tsx`/`App.tsx` |
| B5 | Ctrl+C/D/L 语义 | Ctrl+C：busy 中断→空闲有输入清空→空输入双击(800ms)退出（期间 footer 显示 exit message）；Ctrl+D 双击退出；Ctrl+L 强制重绘（Ink clear+repaint） | `run.tsx`(InterruptHotkey)、`PromptFooter.tsx` |
| B6 | 队列可视化 | 排队消息以 dim 用户消息渲染在输入框上方（非全屏）/scrollable 尾部（全屏）；Up 从首行可取回队列编辑；Esc 收回队首；bash 队列 `!` 样式；保留 `⏎ queued` 瞬时提示 | `InputBox.tsx`、新 `QueuedMessages.tsx`、`input-queue.ts`、`store.ts`(queue 内容镜像) |
| B7 | 双击 Esc 800ms | 窗口 2s→800ms（官方 useDoublePress 常量） | `InputBox.tsx` |
| B8 | Alt+P 模型选择器 / Alt+T thinking | Alt+P 开 ModelPicker overlay（列表+左右调 effort 可简版为列表）；Alt+T 切 thinking 开关（透传给 agent-loop） | 新 `ModelPicker.tsx`（仿 ProviderPicker）、`commands/model.ts`、`run.tsx` |

### 批次 C：模式与状态流对齐（P1）

| # | 项 | 改动 | 主要文件 |
|---|---|---|---|
| C1 | 模式循环修正 | 顺序改 `default→acceptEdits→plan→bypass`；mode indicator 用官方符号/色/文案（default 不显示）；Windows 无 VT 时 meta+m 兜底 | `store.ts`、`InputBox/ModeHotkey`、`theme.ts` |
| C2 | **Plan 审批流** | 新增 ExitPlanMode 工具（plan 模式注入；plan 内容为参数）→ 触发 `Ready to code?` 面板（计划 markdown + Requested permissions 列表 + `Would you like to proceed? 1. Yes 2. Edit in editor(ctrl+g) 3. No`）→ 批准切 acceptEdits 并继续；拒绝回 plan；plan 模式系统提示词补齐（探索优先/只读工具集） | 新 `tools/exit-plan-mode.ts`、`tui/PlanApproval.tsx`、`permissions.ts`、`system-prompt.ts` |
| C3 | Rewind 二级动作 | RewindPicker 选中 turn 后弹动作菜单：`Restore code and conversation` / `Restore conversation` / `Restore code` / `Never mind`（Summarize 项列为可选）；restore 拆分为只代码/只对话/两者 | `RewindPicker.tsx`、`checkpoint.ts`(restore 参数化)、`run.tsx` |
| C4 | Compact/水位呈现 | `⏺ Summarized conversation`(bold)+`⎿ Summarized N messages`+`⎿ Context: "..."`(dim)；水位 toast 改为常驻 TokenWarning 行：`Context low (X% remaining) · Run /compact to compact & continue`，auto-compact 开启时 dim `X% until auto-compact` | `run.tsx`、`auto-compact.ts` 事件、新 `TokenWarning.tsx`（或并入 RetryRegion 区域） |
| C5 | 输入历史持久化 | `<configHome>/history/<project-hash>.jsonl`（追加+lockfile+去重，跨 session 读取倒序混排本 session 优先）；大粘贴折叠为 `[Pasted text #N +N lines]` 引用（内容外置 pasteStore） | `input-history.ts`（新纯模块+测试）、`InputBox.tsx`、`run.tsx` |
| C6 | Transcript 查看器补齐 | footer 文案 `Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · home/end top/bottom · ctrl+e to collapse`；q 退出；ctrl+e 全量展开/折叠切换；搜索栏 less 风格（n/N + current/count 角标） | `TranscriptReview.tsx` |

### 批次 D：精细打磨（P2，选做/可裁剪）

| # | 项 | 改动 |
|---|---|---|
| D1 | Spinner tips | 简版 tipScheduler：内置 ~15 条官方风格 tips（cooldown 机制简化为会话内不重复），无 todos 时轮换显示 `⎿ Tip: ...` |
| D2 | /statusline 命令 | 支持 `settings.statusLine`（type:command，JSON stdin 含 model/context_window/cost/vim.mode），渲染 footer 左列上方，300ms 防抖；启用时抑制 `? for shortcuts` |
| D3 | 帮助面板重排 | 按官方键位全表更新（新增 ctrl+t/s/g/d/l、alt+p/t、!、#），宽度自适应，中英双语 |
| D4 | Banner 对齐 | 官方风格 logo + cwd + 版本 + tips 双栏（保留现吉祥物为选项） |
| D5 | 大粘贴折叠 | 粘贴 >1024 字符折叠引用（与 C5 pasteStore 共用） |

### 明确不做（超出"TUI 体验对齐"范围或依赖官方云端/内部特性）

voice 输入、teammates 多代理视图、/btw 侧问、global search(ctrl+shift+f)、quick open(ctrl+shift+p)、`:` emoji 补全、spellcheck、Ctrl+B 后台任务系统、fast mode ↯（与本地 /effort 重叠）、自然语言 session 搜索、PR 状态徽标、usage-limit 自动继续、IDE 桥、fullscreen renderer 实验开关、auto 模式（ant 内部 feature）。这些留 backlog，需要时另行立项。

---

## 四、实施与验收

- **顺序**：A → B → C → D，每批一个分支一次合并，`tsc/lint/test/build` 四关全过；每批附带组件测试（ink-testing-library）+ i18n 双语断言。
- **不动的部分**：store 架构、Static/live-window 渲染管线、checkpoint 机制、vim 引擎、keybindings 引擎——这些已与官方同构或更优，只做接口适配。
- **风险点**：①InputBox 重构触及 931 行核心文件，需先抽 PromptFooter/QueuedMessages 子组件再改壳，避免大爆炸 diff；②键位变更（Ctrl+R 语义翻转）需在帮助面板+changelog 明示；③官方 188 动词表与文案有版权考量——采用"行为对齐、词表抽样收录"策略（保留官方 10% 高频词+自造同风格词补齐，或全量照搬由你拍板）；④i18n 默认语言切换影响现有中文测试（约 20+ 断言需同步）。
- **回滚**：每批独立 commit 链，revert 单批不影响其他。

## 五、决策点（需你拍板）

1. **UI 默认语言**：A. 默认英文完全对齐官方观感，`CCR_LANGUAGE=zh-CN` 可切回中文（推荐，文案以官方为基准翻译）｜ B. 默认中文（现状观感，英文仅 fallback）
2. **底部信息密度**：A. 官方极简：footer 左列 hints + 右列 `模型 · ctx%`，砍掉 tokens/cost 常显（/cost /tokens 命令可查）（推荐）｜ B. 保留现 StatusBar 全量信息（模型·模式·tokens·ctx·cost·queued），仅重排进官方双列布局
3. **执行范围**：A. 四批全做（A→D 一次立项）｜ B. 先做 A 批看观感效果再定 B/C（推荐——A 批后观感变化最大，B/C 是行为项可分期）
4. **Ctrl+R 冲突**：A. 完全对齐官方：Ctrl+R=历史搜索，工具卡展开改走 Ctrl+O 查看器（推荐）｜ B. 保留 Ctrl+R=展开，历史搜索换其他键
5. **spinner 动词表**：A. 抽样 ~60 词+同风格自造｜ B. 全量照搬官方 188 词（**用户选择 B**，编号以会话决策表为准）
