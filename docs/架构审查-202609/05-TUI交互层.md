# 架构审查分册 05 — TUI 交互层

> 审查日期：2026-09-25 · 方式：只读代码深度探查（未修改任何文件）
> 范围：约 17,500 行——`src/cli.ts`、`src/cli-repl.ts`、`src/cli-input.ts`、`src/cli-prompts.ts`、`src/cli-session.ts`、`src/cli-tools.ts`、`src/cli-args.ts`、`src/tui/` 整个目录（run.tsx、App.tsx、FullScreenApp.tsx、InputBox.tsx、Prompts.tsx、ToolCard.tsx、store.ts、cli-interactive.ts、cli-renderer.ts、stream-buffer.ts、live-window.ts、markdown.ts、StreamingMarkdown.tsx、TranscriptReview.tsx、theme.ts、input-queue.ts、input-history.ts、file-completions.ts、history-replay.ts、keybindings/、vim/、session-stats.ts、spinner-core.ts、cli-spinner.ts、i18n.ts、model-picker-flow.ts、open-editor.ts、paste-chip.ts、clipboard-image.ts、tool-output.ts、tool-result-summary.ts 等）。
> ⚠️ 行号基于审查当日代码（v1.5.0）。后续编辑会造成漂移，引用前先用符号名 grep 重新锚定。
> 总纲见 `docs/架构分析与升级总纲-202609.md`。

> ✅ **第二轮次级项处置（2026-09-26，正文保留原始证据不改写）**：本册体验包落地——
> TUI 系统提示解冻（`deps.buildTurnSystemPrompt` 每轮重建，MCP 中途连接即可见，指纹
> memoize 使重建廉价）、权限弹窗 diff 预览（edit/multi_edit/write 从 tool.input 纯内存
> 构建，不读盘；20 行折叠）、TranscriptReview `useMemo` + `transcriptToLines` 条目级
> WeakMap 缓存（主题/选项变体分键；FullScreenApp memo 键改内容指纹 length:lastId）、
> tailVisualLines append-only 前缀缓存（`(settled,行数,total,宽行标志)` 按 wrap 宽度分槽；
> 新旧实现随机输入等价性 fuzz 测试防渲染回归）、file-completions 陈旧列表后台异步刷新
> （in-flight 即防抖，冷启动仍同步一次）、appendHistory 免全量读（≤8KB 尾读 + memo）。
> **appendStreaming/push 拷贝经微基准核实为有意不改**：V8 字符串 `+` 是 O(1) rope
> （20k 次追加 ~1ms），chunk-list+join 每帧读反而慢三个数量级；transcript 数组拷贝
> 5000 项累计 ~43ms，摊销化收益为负。**诚实化捆绑**：假鼠标注释删除（stdin/stdout
> 传参从不启用鼠标协议）、expandTool/expandedOf/expandedId 三件套删除（从未接线的
> ctrl+r 宣称）、cli-spinner `setMode` no-op + 死 `SpinnerMode` 删除、孤儿
> SpinnerGlyph.tsx 删除、仓库根 TUI_IMPROVEMENTS.md 删除、/branch"resumed immediately"
> 与 /fork"Launch a sub-agent"描述改诚实。**结构项按用户拍板本轮不做**：B4
> StreamingMarkdown 重 lex、B8 热键统一、B9 i18n 清扫、B11 三输入栈、B14 vim visual、
> B15 小修包、run.tsx/InputBox 拆分。详见总纲"次级清单处置标注"节；2007 测试绿。

---

## 1. 渲染架构

### 1.1 三套并存的渲染栈

项目实际存在**三条渲染路径**，由 `src/cli.ts` 分派：

| 路径 | 触发条件 | 技术 | 入口 |
|---|---|---|---|
| **Ink TUI（默认）** | TTY 且未加 `--no-tui` | Ink 7 + React 19，声明式 | `cli.ts:631-740` → `tui/run.tsx:1456 runTui()` |
| **行式 REPL** | 非 TTY / 管道 / `--no-tui` / `CCR_NO_TUI=1` | 自绘 ANSI（raw-mode widget + `\r\x1b[K` 重绘） | `cli.ts:743` → `cli-repl.ts:80 runRepl()`，输入用 `tui/cli-interactive.ts`（TTY）或 `cli-input.ts` readline（非 TTY） |
| **print 无头模式** | `-p/--print` | 纯 `process.stdout.write`，支持 `text/json/stream-json` 三种输出格式 | `cli.ts:383-462` |

Ink 路径内又分两种布局：**默认 `<Static>` 原生滚动模式**（已完成内容写入终端 scrollback，永不重绘）和 **opt-in 全屏模式**（`--fullscreen`/`CCR_FULLSCREEN=1`，DEC 1049 alt-screen + 自研 `ScrollView` 应用内滚动，`run.tsx:1468-1539`、`FullScreenApp.tsx`）。全屏模块与 `App.tsx` 完全解耦（`FullScreenApp.tsx:1-25` 注释明确"不 import App.tsx 任何东西"）。

### 1.2 默认模式的核心设计：`<Static>` + 活区分离

`App.tsx:1-16` 说明了架构：**已完成的 transcript 进 `<Static>`（write-once，进入终端 scrollback，不重绘）**；活区（streaming 文本、活跃工具卡、spinner、输入框）在其下方重绘。这天然避免了流式闪烁。两个精彩的工程细节：

- **`transcriptEpoch` 补丁**（`store.ts:308-315`、`App.tsx:190-199`）：Ink 的 `<Static>` 内部索引单调递增，rewind/`/resume` 使 transcript 数组**变短**后 `slice(index)` 永远为空——通过 bump epoch 作为 `<Static key={epoch}>` 强制 remount 解决。
- **活区高度不变式**（`live-window.ts:1-28`）：Ink 用数 `\n` 的方式擦除上一帧，帧高于终端时 cursor-up 在视口顶部被钳制，顶部行会泄漏进 scrollback（"同一 ● 行重复 50 次"症状）。`tailVisualLines()` 把流式文本窗口化到"帧高 ≤ rows 且行宽 < cols"，且**故意按比正文列窄几列重包裹**（`App.tsx:263` 传 `columns - 8`），防止 wrap-ansi `trim:false` 的边界空格膨胀导致终端自动换行打乱擦除计数。这是对 Ink 渲染模型相当深的理解。

### 1.3 Store 状态管理

`tui/store.ts`（1170 行）是**手写的 pub/sub 外部 store**，无 Redux/Zustand，通过 `useSyncExternalStore` 接入 React：

- **单一 `StoreState` 对象 + 浅合并 `set()`**（`store.ts:491-494`），状态写入永远同步，通知可批量。
- **16ms 帧合并**（`store.ts:345 FRAME_MS`、`445-488`）：一批 mutation 合并为一次 emit；`flush()` 在回合结束强制排干（`run.tsx:458`）。
- **字段切片订阅**（`useStoreSelector.ts`）：`useStoreField(store, "streamingText")` 单字段 `===` 比较；`useStoreSelector` 带 shallow-equal 缓存 + selector 存 ref（避免内联箭头函数导致反复重订阅）。`App.tsx` 被拆成 ~10 个区域组件（TranscriptRegion / StreamingRegion / ThinkingRegion / ActiveToolsRegion / StatusLineRegion / TokenWarningRegion / RetryRegion / InteractionRegion / HelpRegion），**根组件本身不订阅 store**（`App.tsx:766-770`），一个 token delta 只重渲染 StreamingRegion 叶子。
- **Overlay 即 Promise**：权限/提问/选择器等全部建模为 `Overlay` union（`store.ts:128-212`），`askPermission()` 等返回 Promise，agent loop `await` 它，UI 侧组件调 `overlay.resolve()` 关闭——命令式编排与声明式 UI 的干净缝合。overlay 有 FIFO 队列 + settled 守卫（`store.ts:971-990`），打开时强制退出 review 模式防止 resolve 悬挂；`cancelOverlays()` 按类型给出安全默认值（permission→"no"，`store.ts:993-1011`）。
- **不触发渲染的旁路状态**：`draft` 镜像（`store.ts:278-289`，无订阅者，供 "?" 热键在事件时刻读取 + overlay 卸载 InputBox 后草稿保活）、`tipPool`（`store.ts:1040`）刻意放在 state 之外。

**评价**：这是一个考虑得非常周全的轻量 store，注释中大量"为什么"级别的决策记录（如 EXIT_DOUBLE_PRESS_MS 与 EXIT_HINT_MS 故意不同、`store.ts:354-369`）。

---

## 2. 输入管线

### 2.1 完整链路（Ink 路径）

```
stdin (raw mode, bracketed paste 2004h)
  → Ink useInput / usePaste 广播给所有活跃监听器
      ├─ InterruptHotkey (run.tsx:1402-1453)  Ctrl+C/D、Esc：忙时 abort controller，闲时双击退出
      ├─ ModeHotkey (App.tsx:566-631)         全局热键 → keybindings resolver → store 动作
      ├─ Overlay 组件自持键盘 (Prompts.tsx 等)  store.overlay 存在时其余监听器主动 return
      └─ InputBox (InputBox.tsx:566-1027)     ~460 行的单一 useInput 处理函数
  → Enter 提交 → run.tsx Root.onSubmit (1126-1343)
      ├─ busy? → InputQueue.push（type-ahead，run.tsx:1159-1165）
      ├─ "!" 前缀 → runBashMode（直接执行 shell + 注入 <bash-stdout> 上下文 + 自动回合）
      ├─ "#" 前缀 → runMemoryMode（追加 CLAUDE.md，无模型回合）
      ├─ "/" 前缀 → handleSlashCommand（console 输出被 captureConsole 捕获为 log item，run.tsx:524-540）
      └─ 普通文本 → appendHistory → expandFileRefs(@引用) → beginUserTurn(checkpoint) → runTurn
```

关键设计点：

- **Ink 广播语义的对抗**：每个 `useInput` 都收到每个按键，代码里到处是事件时刻快照守卫——`inputSuspended()` 信号（`InputBox.tsx:244-246`，帮助面板打开 "?" 的那次按键会在同一 stdin burst 里泄漏进 buffer，故用函数而非渲染派生 flag）；ctrl+r 在搜索中被全局热键重复派发的守卫（`InputBox.tsx:543-549`）；`consumedActionSeqRef` 防止 remount 重放上一次的 inputAction（`InputBox.tsx:496-501`，"一次 ctrl+g 后每个权限弹窗关闭都重开编辑器"的 bug 修复）。
- **同步 ref + 异步 state 双轨**（`InputBox.tsx:386-401`）：`bufferRef/cursorRef` 是事件处理的真相源，一个 stdin chunk 携带多个按键时第二个键能读到第一个键的结果；React state 只是渲染镜像。
- **keybindings 系统**（`tui/keybindings/`）：VS Code 风格 `~/.claude/keybindings.json` 用户覆盖，`DEFAULT_BINDINGS`（defaults.ts:19-38）含 shift+tab 循环权限模式、ctrl+o transcript、ctrl+r 历史搜索、ctrl+s stash、ctrl+g 外部编辑器、ctrl+t todos、ctrl+l 重绘、alt+p 模型选择器、alt+t 思考开关。alt/meta 合并、Esc 的 meta quirk 都处理了（match.ts:52-70）。
- **vim 模式**（`tui/vim/`，5 文件 ~1300 行）：完整状态机——`transitions.ts` 转移表（idle/count/operator/operatorCount/find/g/replace/indent 等 11 态），支持 d/c/y + motion/text-object(iw/a"/ib…)/find(fFtT;,)、count 前缀、寄存器 p/P、`u` undo（50 快照，insert 会话折叠为单个 undo 单元）、`.` dot-repeat（官方同款限制：`cw foo <Esc>` 后 `.` 只重放插入文本，engine.ts:12-16 诚实注明）。`/vim on` 激活，Esc 降 normal，`[N]/[I]` 指示器（InputBox.tsx:1173-1177）。
- **输入队列**（`input-queue.ts` + `run.tsx`）：忙时提交的行进 FIFO，agent loop 在回合边界 `drainQueuedInput`（run.tsx:204-224，先 flush/commit 在途流保证"回复→用户"顺序）；loop 最终 drain 与 busy 翻转之间的竞态由 `drainFollowUpTurns` 兜底，上限 10 个跟随回合防滥用（run.tsx:654-692）。**回显时机 = 注入时**而非排队时（run.tsx:836-851 注释），被 ↑ 召回或超限丢弃的行不会留下模型没见过的"幽灵用户消息"——transcript 与 `messages` 严格同步（rewind 的数据源）。空 buffer 按 ↑ 召回最后一条排队消息（B6，InputBox.tsx:820-839）。

### 2.2 粘贴 / 图片 / @补全

- **文本粘贴**：Ink `usePaste`（bracketed paste 通道，`\r\n`→`\n` 规范化，粘贴的 `\r` 不会误提交）；>1024 字符折叠为 `[Pasted text #N +L lines]` chip（`paste-chip.ts`），提交时 `expandPastedChips` 还原全文给模型；chip 全会话有效（可从历史召回再展开）。`PasteGuard`（App.tsx:74-87）是个巧妙的 hack：overlay 卸载 InputBox 后 usePaste 引用计数归零，Ink 会关掉 2004h，粘贴字节会作为原始按键轰进单键应答的权限弹窗（`y` 直接批准）——常驻空 usePaste 吸住引用计数。
- **图片粘贴**（Ctrl/Alt+V）：终端无法经 stdin 传二进制，故走系统剪贴板（`clipboard-image.ts`）：Windows PowerShell+WinForms STA 存临时 PNG、macOS osascript «class PNGf» hex、Linux xclip/wl-paste，`encoding:"buffer"` 防 UTF-8 解码毁掉 PNG 魔数。插入 `[Image #N]` chip，提交时转 base64 image block；chip **单次使用**（run.tsx:914-930），并有 draft-generation 守卫防慢速剪贴板读取（Windows ~1s）把 chip 拼进下一条消息（InputBox.tsx:968-991）。
- **@文件补全**（`file-completions.ts`）：fast-glob **同步**全仓扫描（deep 8，忽略 node_modules 等），3s TTL 缓存；前缀匹配优先、子串回填、短路径优先排序，上限 8 条。Tab 只替换光标处 `@word` 的 [start, cursor) 区间。提交侧由 `expandFileRefs` 展开为附件。
- **历史**：↑/↓ 优先多行光标移动，到边缘才进历史（官方优先级，InputBox.tsx:841-890）；ctrl+r 内联 reverse-i-search（Esc/Tab 接受不运行，Enter 接受并运行）；跨会话持久化为 `<workspace>/.claude/history/<hash>.jsonl`，连续重复折叠，上限 100（`input-history.ts`）。

---

## 3. 输出管线

### 3.1 Ink 路径：token → StreamBuffer → store → StreamingMarkdown → Static

```
agentLoop 事件流 (run.tsx:290-441 for-await)
  text_delta → StreamBuffer.push（33ms 定时器合帧，~30fps，stream-buffer.ts:15）
    → flush 时 store.appendStreamingWithTokens(delta, liveTokens())   ← 一次 emit 同时带 token 估算
      → store 16ms 帧合并 → useStoreField("streamingText") 只重渲染 StreamingRegion
        → tailVisualLines() 窗口化（高度≤maxLines，宽 cols-8 重包裹）
          → StreamingMarkdown：稳定前缀 memo + 仅尾部增量 lex
 回合/工具/重试边界 → flush + settleThinking + commitStreaming
    → transcript.push({kind:"assistant"}) → <Static> 一次性写入 scrollback
```

- **双层节流**：StreamBuffer 33ms（producer 侧）+ store FRAME_MS 16ms（notify 侧），token 洪峰下重绘稳定在 ~30fps。定时器 `unref()`（stream-buffer.ts:50）不吊住事件循环。
- **token 计数**：`committedOutputTokens + 在途字符/4` 估算，usage 事件到达后回正真实值（run.tsx:272-279, 382-396）。
- **`StreamingMarkdown`**（StreamingMarkdown.tsx）：在最后一个顶层 block 边界切分，稳定前缀经 `memo` 化 `MarkdownChunk` 只 lex 一次，每帧只重 parse 在途尾块，O(tail) 而非 O(msg)；有 `children.startsWith(prefix)` 防御性重置。
- **markdown 渲染器**（markdown.ts，518 行）：marked lexer → chalk ANSI。代码块用 highlight.js（HTML span 输出经栈式解析器转 chalk，含实体解码）；表格有完整的列宽分配算法（min/ideal/按比例压缩/超窄终端降级为竖排 key:value，markdown.ts:111-247）；`hasMarkdownSyntax` O(n) 嗅探跳过纯文本的 lexer 开销（markdown.ts:512-515）；`fromCodePointSafe` 防模型输出 `&#1114112;` 之类越界码点把整个 Ink 应用打崩（markdown.ts:41-43）。
- **thinking**：`thinking_delta` 进独立的 `streamingThinking` 缓冲（暗色斜体活区），`settleThinking()` 在阶段结束时提交为**单行折叠** "✻ Thought for Ns · M lines"（全文只能在 Ctrl+O viewer 看，P0-2）；`model_retry` 区分普通重试（丢弃部分流防"接上死片段"）与 continuation 重试（已入历史，flush+commit，run.tsx:316-337）——这个区分做得很细。

### 3.2 工具输出折叠

- **活跃卡**：`ActiveToolCard` 灰色闪烁点 + `actionLabel()` 具体化动词（"Reading App.tsx"/"Running npm test"，spinner-core.ts:445-473）+ 实时秒表；活区最多 3 张卡 + "+N more running"（App.tsx:305-317），防子代理风暴撑爆帧高。
- **完成卡**（ToolCard.tsx）：`⏺ Name(detail)` + `⎿` 分支体。Read/Grep/Glob 折叠为工具 metadata 提供的单行 summary（"Read 200 lines"，tool-result-summary.ts）；其余工具 12 行预览 + "… +N lines (ctrl+o to expand)"。Edit 结果按 `metadata.diffLines` 渲染**带行号 gutter + 前景/背景色的 diff 行**（tool-output.ts:59-81），Write 渲染带行号的语法高亮代码预览。错误经 `parseError` 结构化（TS 错误码/ENOENT/EACCES/网络，markdown.ts:361-395）+ 最多 3 行栈。
- **注意**：`store.expandTool()`（ctrl+r 追加展开副本，store.ts:781-797）**在生产代码中无任何调用者**——ctrl+r 已改绑 history:search（keybindings/defaults.ts:27），展开能力被 Ctrl+O verbose viewer 取代，`expandTool` 与 `App.tsx` 的 `expandedId` prop 是遗留死代码（App.tsx:721-723 自己承认"Legacy…(tests)"）。

### 3.3 行式 REPL 路径

`cli-renderer.ts StreamingRenderer`：按**块边界**缓冲（空行或闭合代码围栏触发），整块过 `renderMarkdown` 后写出——流式中途不会泄漏 `**bold**` 字面量；工具输出 12 行截断（无展开承诺，注释明说该路径没有按键处理器，`cli-renderer.ts:266-273`）。spinner 是单行 `\r\x1b[K` 原位重绘（cli-spinner.ts），与 Ink StatusLine 共享 spinner-core 的纯函数原语（188 个官方动词、粒子帧、shimmer 数学、失速变色）。

---

## 4. 会话 UI

- **Spinner/状态行**：官方同款语义——每次 mount 采样**一个**动词（`verbForTurn` 用回合起始时间做种子，确定性、不逐帧重掷，spinner-core.ts:224-227）；11 帧粒子动画（正向 6 + 反向去首，注释解释了朴素拼接会在两端"卡帧"，spinner-core.ts:256-261）；150ms/列的 shimmer 扫光；**3s 无活动 glyph 从 Claude 橙向错误红插值**（`stalledGlyphColor`）；`CCR_REDUCED_MOTION=1` 冻结装饰但保留计时（"时钟是信息不是装饰"）。StatusLine 自持 80ms interval，动画不触碰 store 订阅。
- **Stats/cost**：`session-stats.ts` 静态定价表（子串匹配，未知模型返回 null 而非瞎猜）+ 上下文窗口表（顺序敏感："gpt-4o" 在 "gpt-4" 前）；store 维护 tokensIn/Out、cacheReadTokens、`contextUsed`（Anthropic input 不含 cache token 要加回、OpenAI prompt_tokens 已含不能重复加——`run.tsx:492-506 estimateContextUsed` 做了 provider 语义调和，⚠️ 注意：**UI 侧调和了，但 agent-loop 的压缩阈值侧没有**，见分册 01 H1）；footer 右列显示 "N% until auto-compact"（75%/90% 阈值变色，TokenWarningRegion 出持久警告行）。cost 不在 footer（注释注明官方委托给 /statusline，本项目决策放 /cost、/tokens 命令）。
- **History replay**：`/resume` → SessionPicker overlay（50 条上限防几百次文件读）→ `messagesToTranscript` 纯数据变换回放（0 token），tool_call 与 role:"tool" 结果按 id 配对内联；thinking 块也回放。rewind（Esc+Esc）用 checkpoint 的 `turnOfMessage` 标签映射而非序号算术（防合成注入/resume 偏移，run.tsx:991-1080），支持"对话+代码 / 仅对话 / 仅代码"三种恢复，文件恢复失败时保留 checkpoint 供重试。
- **i18n**：`i18n.ts` 577 行，en + zh-CN 双语表，`{param}` 插值；**英文为默认**，中文仅 `CCR_LANGUAGE=zh-CN` 显式开启（对齐官方英文 chrome 的决策注释）。三条 UI 路径（Ink Prompts、raw-mode 菜单、文本回退）共用同一 t() 源。
- **其他**：Toast（2s 自动清除）、RetryLine（429 倒计时，store 自持 1s tick，归零后 hold 住直到重试请求首个事件）、TodoList（活跃项居中的 5 行窗口）、TipLine（8s 后出现、会话内不重复的 14 条 tip 轮换池）、HelpPanel（"?" 空草稿守卫）、banner（Ink 启动前直接写 stdout 进 scrollback，含 Unicode 块元素吉祥物）。

---

## 5. 弱点

### 5.1 渲染性能

1. **`tailVisualLines` 每帧全文扫描**（live-window.ts:138-146）：快速路径也要对**整个** streamingText 逐行 `measureWidth`。一条 10 万字符的长回复在 30fps 下每帧 O(len) 测量 + `split("\n")` 分配，整个回合累计 O(len × frames)≈准二次方。稳定前缀的测量结果没有任何缓存。
2. **StreamingMarkdown 的稳定前缀在窗口滑动后失效**：`App.tsx:263` 先做 `tailVisualLines` 再喂给 StreamingMarkdown——一旦流超过 maxLines，窗口每帧滑动，`children.startsWith(stablePrefixRef.current)`（StreamingMarkdown.tsx:50）持续失败 → **每帧全量重 lex 整个窗口文本**，增量机制名存实亡（好在窗口有界，代价封顶）。
3. **TranscriptReview 无 memo**（TranscriptReview.tsx:60-63）：每次渲染（包括每次滚动按键）都 `transcriptToLines(全量)`，对**每条** assistant item 重跑 `renderMarkdown`（transcript-lines.ts:96）。长会话中打开 Ctrl+O viewer 滚动会明显卡顿。对比 FullScreenApp 有 `useMemo(transcript)`（FullScreenApp.tsx:293）——但 memo 键是 transcript 数组引用，而 store 每次 push 都换整个数组（store.ts:496-499），所以**每个工具完成都触发全屏模式的全历史 markdown 重渲染**。
4. **`appendStreaming` 字符串整拷贝**（store.ts:643-658）：每帧 `streamingText + delta` 重建全串，长回复下 GC 压力线性放大。chunk-list + join 可缓解。
5. **file-completions 同步 glob 阻塞事件循环**（file-completions.ts:50 `fg.sync`）：TTL 过期后的第一次 "@" 按键在大仓库上同步阻塞 10-100ms，期间 Ink 渲染和按键处理全部冻结。同类问题：`appendHistory` 每次提交同步读整个历史文件（input-history.ts:68-69）。

### 5.2 状态同步 / 一致性

6. **三套输入实现严重漂移**：Ink InputBox（多行、vim、@补全、图片、chip、历史搜索）vs `cli-interactive.ts` raw widget（**单行**、无历史 ↑↓、无 @补全、无 vim、粘贴压平为空格、Home/End/Ctrl+方向键全不识别，parseKey 只认 9 种序列）vs readline。`--no-tui` 的 TTY 用户拿到的体验断崖式降级，且权限菜单（promptPermissionMenu）与 Ink PermissionPrompt 是两份独立实现。
7. **FullScreenApp 的热键绕过了 keybindings 系统**（FullScreenApp.tsx:217-249 硬编码 if-else），用户在 `~/.claude/keybindings.json` 的重映射在全屏模式**静默失效**；且缺 `transcript:review`（PgUp）分支行为与默认模式不一致。
8. **keybindings 只支持单键**：`parseChord` 能解析 "ctrl+k ctrl+s"，但 `resolveKey` 直接 `if (binding.chord.length !== 1) continue`（resolver.ts:28）——用户配置的 chord 绑定被**无声吞掉**，无任何警告。
9. **i18n 覆盖不完整、语言混杂**：行式 REPL 有大量硬编码中文绕过 t()——`cli-repl.ts:436`（"模型响应时间较长"）、`499`（"正在压缩上下文…"）、`506-511`、`223`（"当前回合结束后送达"）、`cli-prompts.ts:94,114`（"✓ 已记住"）——英文用户会看到中文；反向，run.tsx 的 notice（`1006` "Nothing to rewind"、`599` "Resumed…"、`615,642` provider 提示、model-picker-flow.ts:14,45）、banner.ts 全部硬编码英文，`CCR_LANGUAGE=zh-CN` 下依旧是英文。effort.ts 的 definition/behavior 也是中文硬编码。
10. **`selectLiveChromeRows` 的 help 面板估算是写死的 20**（App.tsx:223-224），而 HelpRegion 实际 clip 到 `max(5, rows-8)`——小终端上过度预留，streaming 窗口被无谓压缩。

### 5.3 终端兼容性（Windows）

做得好的：DECAWM 一列 slack（InputBox.tsx:79-90 详注了输入框"每键跳动"的根因排查）、Windows console scroll-on-output snap 用应用内 pager 绕开（TranscriptReview 头注）、Ink #969 右下角单元格立即滚动问题（live-window.ts:10-12）、`●` 替代 `⏺`（figures.ts）、spinner 字符集平台分叉、open-editor 走 shell 规避 CVE-2024-27980、alt-screen/raw-mode/bracketed-paste 在 `process.once("exit")` 兜底恢复（run.tsx:1489-1506）。

仍存在的：
11. **剪贴板图片在 Windows 上 ~1s 延迟**（PowerShell STA 冷启动），无异步进度指示，只有事后 pasteNote。
12. **run.tsx:1533 注释 "Enable mouse input for scrolling support" 是假的**：只传了默认的 stdin/stdout/stderr，从未写入 `\x1b[?1000h/1006h` 开启鼠标上报，也没有任何滚轮事件处理。TUI_IMPROVEMENTS.md 声称的"鼠标滚轮支持"与代码不符（该文档自己已标注过期，但误导性注释还在）。

### 5.4 对比真实 Claude Code 缺失/降级的 TUI 特性

| 特性 | 状态 |
|---|---|
| 权限弹窗（y/a/n、单键、Shift+Tab 换模式、工具感知 always 文案、风险分级图标） | ✅ 相当完整（Prompts.tsx:66-143） |
| **权限弹窗内的 diff 预览** | ❌ 缺失。PermissionPrompt 只显示单行 `detail`（run.tsx:1097 用 toolDetail 抽取 command/filePath）。真实 CC 对 Edit/Write 显示红绿 diff 供审批。讽刺的是 diff 渲染能力已存在（tool-output.ts `renderNumberedDiffLine`）但只用于**已完成**工具卡 |
| 多选问卷（AskUserQuestion multiSelect） | ✅ QuestionPrompt Space 切换 |
| Ctrl+O 详细 transcript / Ctrl+R | ✅ TranscriptReview（/ 搜索、n/N、{ } 跳 prompt、v 开 $EDITOR、ctrl+e 折叠切换）——比官方还全；但 ctrl+r 展开单个工具输出的旧能力已死（expandTool 无调用者） |
| Esc Esc rewind（对话/代码/两者） | ✅ |
| 图片粘贴、大粘贴 chip、@补全、!bash、#memory、type-ahead 队列、stash、外部编辑器、tip 轮换、todo 钉住 | ✅ 全部对齐官方 |
| **鼠标滚轮滚动** | ❌（见 12） |
| **vim visual 模式 / 宏 / `/` 搜索 / redo** | ❌ 只有 normal+insert（引擎注释未声明此局限） |
| IDE 集成、`--dangerously-skip-permissions` 的 UI 确认流 | 未见 TUI 侧对应 |
| 行式 REPL 的历史 ↑↓ | ❌（raw widget 的 up/down 只导航补全） |

### 5.5 代码组织

13. **InputBox.tsx 1298 行、单个 useInput 回调 ~460 行**（566-1027），历史搜索、vim、粘贴、图片、补全、多行光标全在一个函数里靠顺序 if 短路（顺序即优先级，注释解释了每处先后，但新增行为的回归风险高）。
14. **run.tsx 1570 行**同时承担：回合编排、slash 命令分发、bash/memory 模式、rewind、resume/provider picker、队列、SIGINT、alt-screen 生命周期——`Root` 组件本质是个上帝对象。
15. 死代码/遗留：`expandTool`+`expandedOf`+`expandedId`（仅测试用）、`cli-spinner.setMode` 显式 no-op（cli-spinner.ts:103-105）、`SpinnerGlyph.tsx` 被 StatusLine/ToolCard 各自内联 interval 取代后近乎孤儿、TUI_IMPROVEMENTS.md 整篇过期。

---

## 6. 可升级点（按 ROI 排序）

1. **权限弹窗内嵌 diff 预览**（最高价值）：`run.tsx:1082-1111 askUser` 已拿到 `tool.input`；对 edit/write/multiedit 计算 `diffLines`（`change-tracker`/`tool-output.ts:59` 的渲染函数可直接复用），塞进 `Overlay.permission` 新增 `diff?: string[]` 字段，`Prompts.tsx:121` 在 detail 下渲染限高（如 10 行 + 计数）的 diff。
2. **给 tailVisualLines 加增量测量**：live-window.ts:131 —— streamingText 只增不减（append-only），缓存 `(已测前缀长度, 前缀行数, 前缀是否含宽行)`，每帧只测新增尾部；或干脆在 store 里按行分块存储 streaming 文本。同时把 StreamingMarkdown 的窗口滑动与前缀失效解耦（对**未窗口化**全文维护稳定边界，渲染时再对稳定块做尾部裁剪）。
3. **TranscriptReview 行缓存**：`TranscriptReview.tsx:60` 改为 `useMemo(() => transcriptToLines(transcript,…), [transcript, showAll])` + 对 streaming 尾巴单独拼接（照抄 FullScreenApp.tsx:293-295 的模式）；进一步可对逐 item 的 `renderMarkdown` 结果做 item-id 级 memo（transcript item 不可变）。
4. **file-completions 异步化**：`fg.sync`（file-completions.ts:50）改 `fg.async` + 输入防抖（150ms），或在空闲时预热/TTL 到期后台刷新，按键路径只读缓存。顺带把 `appendHistory` 的 loadHistory 改为读缓存尾部一行判重。
5. **统一 keybindings 到全屏路径**：FullScreenApp.tsx:217-249 的 FsModeHotkey 换成与 App.tsx:564 相同的 `globalResolver`，并在 resolver 中对被忽略的 chord 绑定打一次启动警告（resolver.ts:28）。
6. **i18n 清扫**：把 cli-repl.ts:223,436,499-511、cli-prompts.ts:94,114 的硬编码中文与 run.tsx:599,615,642,1006 等硬编码英文全部过 t()；effort.ts 的中文 definition 同理。
7. **实现真鼠标滚轮**（或删除误导注释）：全屏模式启动时写 `\x1b[?1006h\x1b[?1000h`，在 useInput 里解析 SGR 鼠标序列（button 64/65）映射到 `scrollBy`；退出时关闭。至少应把 run.tsx:1533/1564 的假注释改掉。
8. **合并两套 TTY 输入**：给 `cli-interactive.ts` 的 raw widget 补历史 ↑↓（数据已在 `loadHistory`）、Ctrl+A/E/U/K/W（逻辑可从 InputBox 抽成共享纯函数），或干脆让 `--no-tui` TTY 也走 Ink（只关全屏特性）。当前 splitKeys 的 burst/粘贴处理质量很高，值得保留为共享层。
9. **清理死代码**：删 `store.expandTool`/`TranscriptItem.expandedOf`/`App.expandedId`（或把 ctrl+r 的展开能力真正接回——在 CompletedToolCard 上绑一个"展开"动作），删 TUI_IMPROVEMENTS.md，`SpinnerGlyph` 若无组件使用则移除。
10. **vim 补 visual 模式**：状态机（vim/types.ts:19-34）加 `VISUAL` 态 + 选区锚点，`d/y/c` 在 visual 下作用于选区——现有 operator 执行函数大多可复用（`executeOperatorMotion` 换成区间版）。
11. **`store.push` 的数组拷贝**：transcript 只增（除 epoch 重置），可改用持久化列表或分段数组，减少长会话下每次工具事件的 O(n) 拷贝（store.ts:498）。
12. **小修**：`selectLiveChromeRows` 的 help=20 改为实际 clip 值 `max(5, rows-8)`（App.tsx:223 vs 556）；InputBox 的 `deleteWordBefore` "保留一个空格"行为（InputBox.tsx:151-158）与标准 Ctrl+W（全删尾部空白）不一致，建议对齐 Unix 惯例。

---

## 总体评价

这个 TUI 层的**工程成熟度远超一般复刻项目**：Ink `<Static>` write-once 语义、log-update 擦帧数学、wrap-ansi trim:false 膨胀、Ink useInput 广播、bracketed paste 引用计数、Windows console scroll-snap、DEC 1049 泄漏防护——这些冷门坑全部有代码级对策且注释记录了根因。官方特性对齐度很高（type-ahead、rewind、chip、tip 池、失速变色等均有）。主要短板集中在：**长输出/长会话下的三处 O(n) 每帧重算**（live-window 全文测量、viewer 无 memo、全屏 transcript 全量重渲染）、**权限弹窗缺 diff 预览**、**三套输入栈漂移**、**i18n 混杂**，以及若干"注释宣称与代码不符"的诚实性问题（鼠标支持、ctrl+r 展开）。
