# 03 · 终端状态显示 UI：Spinner、流式渲染与工具进度

> 基于 Claude Code 2.1.88 恢复源码（`src/`）分析。本文回答：**终端里的「✻ Pondering… (13s · ↓ 1.2k tokens)」、流式 markdown、工具进度行、状态行都是怎么实现的。**

---

## 1. 整体 UI 架构

### 1.1 渲染栈

项目 vendor 了一套**深度定制的 Ink**（React for CLI，约 80 个文件，不是官方 Ink）：

```
React 组件树 (REPL.tsx，约 5000 行)
   │  React commit
   ▼
自定义 react-reconciler → 虚拟 DOM
   │  onRender = throttle(queueMicrotask, 16ms)     ← 帧率上限 ~60fps
   ▼
Yoga 布局 → cell 网格 screen buffer（双缓冲 frontFrame/backFrame）
   ▼
log-update.ts: cell 级 diff → 相对光标移动 + stdout patch
   ▼
终端写序列包在 \x1b[?2026h ... \x1b[?2026l（DEC 2026 同步更新）里，消除闪烁
```

### 1.2 静态区 / 动态区的分离

这套实现里**没有官方 Ink 的 `<Static>` 组件**，分离靠布局：

- **全屏模式（默认）**：`<FullscreenLayout scrollable={…} bottom={…}>`（`src/components/FullscreenLayout.tsx:31`）
  - `scrollable` = 消息历史（虚拟滚动 ScrollBox，只渲染可见行）+ spinner
  - `bottom` = 固定底部的输入框、状态行、权限对话框（`flexShrink:0`）
- **非全屏 legacy 模式**：已完成消息内容不变 → cell diff 为空 → 自然"静态化"，终端滚动把它们推入 scrollback；spinner 永远在组件树最底部，出现/消失只是行数增减。

**可移植要点**：静态/动态分离的本质是「已完成内容直接写 stdout 进 scrollback，只有底部 N 行参与每帧重绘」。

---

## 2. Spinner 状态机

### 2.1 动作词表

`src/constants/spinnerVerbs.ts:16` —— `SPINNER_VERBS` 是约 **185 个硬编码动名词**（`Accomplishing`、`Baking`、`Clauding`、`Cogitating`、`Pondering`、`Reticulating`、`Whatchamacalliting`…），支持用户配置 replace/append。

**选词发生在每个 turn 开始时一次，turn 内不轮换**（`src/components/Spinner.tsx:166`）：

```ts
const [randomVerb] = useState(() => sample(getSpinnerVerbs()))
const verb = overrideMessage ?? currentTodo?.activeForm ?? randomVerb
```

优先级：外部覆盖消息 > 当前任务的 activeForm > 随机词。

### 2.2 五种模式（由 SSE 流事件驱动）

`SpinnerMode = 'requesting' | 'thinking' | 'responding' | 'tool-input' | 'tool-use'`

| 流事件 | mode |
|---|---|
| 发出请求 | `requesting`（扫光更快、方向相反） |
| `content_block_start: thinking` | `thinking` |
| `content_block_start: text` | `responding` |
| `content_block_start: tool_use` / `input_json_delta` | `tool-input` |
| `message_stop`（有待执行工具） | `tool-use`（整条消息按正弦波呼吸闪烁） |

### 2.3 动画时钟与逐帧推导

- 全局共享时钟 `createClock`（`src/ink/components/ClockContext.tsx:10`）：一个 `setInterval`，订阅者驱动，无订阅停摆省电；终端失焦时节拍 ×2。
- 只有叶子组件订阅 50ms 帧（`SpinnerAnimationRow.tsx:103`），父组件不在高频时钟上 —— 每 turn ~25 次渲染而非 ~383 次。
- 每帧推导（都在叶子组件里算）：

```ts
const frame = Math.floor(time / 120)              // 字形每 120ms 一帧
const FRAMES = ['·','✢','✳','✶','✻','✽', ...逆序]  // 往返摆动
const elapsed = now - loadingStartTimeRef - totalPausedMsRef   // 墙钟，走 ref 不经 React
const tokens  = smoothApproach(responseLength / 4)             // 字符数/4 估算，分段平滑逼近
```

- **stall 检测**：3 秒无新 token → spinner 与文字在 2 秒内插值变红（truecolor SGR 插值）。
- **thinking 子状态**：退出 thinking 模式时显示 `thought for Ns`，且至少展示 2 秒避免闪烁感。
- **宽度门控**：终端窄时依次丢弃 thinking 段 → 计时 → token 计数。

### 2.4 高频数据走 ref，不走 React state

`responseLengthRef`、`loadingStartTimeRef` 等由 agent loop 的消费侧直接更新（`REPL.tsx:1427-1455`），动画帧自己读 —— 避免每个 SSE delta 触发 React 渲染。

---

## 3. 流式 markdown 渲染

### 3.1 数据通路

```
query.ts async generator ──yield──▶ REPL for await 循环
  ▶ handleMessageFromStream（纯分发函数，utils/messages.ts:2930）
  ▶ setStreamingText(text => text + delta)   ← text_delta
```

### 3.2 关键技巧 1：只渲染到最后一个换行符（`REPL.tsx:1473`）

```ts
const visibleStreamingText = streamingText
  ? streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null
  : null
```

正在生长的半行不显示 —— 避免 `**`、链接等行内 markdown 语法半句抖动。

### 3.3 关键技巧 2：稳定前缀 + 尾部重解析（`Markdown.tsx:186` StreamingMarkdown）

- 已闭合的 block token 晋升为 stable prefix，走 memo 化渲染，**边界单调前进**；
- 只有末尾未完成块每个 delta 重新 lex —— O（不稳定段） 而非 O（全文）；
- 完整 Markdown 渲染带 500 条 LRU lexer 缓存，无语法文本走 fast path。

### 3.4 关键技巧 3：流结束原子切换

完整 assistant 消息到达时，先清 streamingText 再 push 正式消息，**两件事在同一 React 批次内** —— 无 gap、无重复。

---

## 4. 工具调用 UI

### 4.1 工具输入生成中

`content_block_start: tool_use` 时立即上屏"合成工具消息"（工具名 + 已生成的部分 JSON 输入），随 `input_json_delta` 更新。

### 4.2 执行中

- 行首 `ToolUseLoader`：未 resolved 时灰色 `⏺` 以 600ms 闪烁，完成变绿/红；
- 工具名用 `tool.userFacingName(input)` + 参数摘要；
- 进行中进度（如 Bash 每秒 tick）**就地替换**而非追加，防止消息爆炸；
- 权限等待显示 `Waiting for permission…`。

### 4.3 结果摘要折叠

连续的只读工具（Read/Grep/Glob/LS）被折叠成单行（`CollapsedReadSearchContent.tsx:345`）：

```
⏺ Searched for 13 patterns, read 6 files   （活跃期用现在时 + 灰点；结束后过去时 + dim）
```

Ctrl+O 展开明细。

---

## 5. 状态行（statusline）

1. **spinner 行内状态段**：`(13s · ↓ 1.2k tokens · thought for 4s)`，50ms 帧重算，按剩余宽度渐进显示。
2. **用户自定义 statusLine 命令**（`StatusLine.tsx:191-234`）：assistant 消息/权限模式/模型变化时触发，**300ms 防抖**后执行用户配置的 shell 命令（注入模型/cwd/cost/context 用量等 JSON 上下文），结果显示在输入框下方。

---

## 6. UI 与 agent loop 的连接方式

**答案：async generator 直接消费 + setState 扇出；高频数据走 ref 绕开 React。**

```
query() async generator ──yield──▶ for await 循环（REPL.tsx:2793）
  ▶ handleMessageFromStream 分发：
     setMessages          → 已完成消息（静态区）
     setStreamMode        → spinner 模式
     setStreamingText     → 流式 markdown
     setStreamingToolUses → 工具输入进度
     responseLengthRef += delta   ← 高频，不走渲染
```

全局跨组件状态（tasks、statusLineText、权限模式）走一个 **30 行的极简 observable store**（`src/state/store.ts:10`）+ `useSyncExternalStore`。

---

## 7. 可移植最小实现（纯 Node.js + ANSI，不用 Ink/React）

对应实现见 `tool/mini-agent/src/ui.js`。核心机制：

### 7.1 屏幕分区：scrollback + 底部动态区

```js
let dynLines = 0  // 上次渲染的动态区行数
function renderDynamic(lines) {
  let out = `\x1b[${dynLines}A`              // 光标上移 N 行回到动态区顶部
  for (const l of lines) out += `\x1b[2K\r${l}\n`   // 逐行：擦除 + 重写
  process.stdout.write(out)
  dynLines = lines.length
}
```

- 已完成内容直接 `stdout.write(line + '\n')` 进 scrollback，永不重绘；
- spinner 是 N=1 的特例：`\r\x1b[K ✻ Pondering… (13s · ↓ 1.2k tokens)`。

### 7.2 动画时钟

- 一个全局 `setInterval(50ms)`；渲染前隐藏光标 `\x1b[?25l`，退出时 `\x1b[?25h`（挂 `process.on('exit')`）；
- 字形 `['·','✢','✳','✶','✻','✽']` 每 120ms 换帧；elapsed/token 每帧推导。

### 7.3 流式文本

- chunk 累加进 buffer，**只落定到最后一个 `\n`** 的部分（markdown 渲染后直接写 scrollback）；
- 流结束：完整渲染写 scrollback + 清动态区，同一同步代码段完成。

### 7.4 工具进度

- 状态机 `requesting → thinking|responding → tool-input → tool-use`，由 SSE 事件类型驱动；
- 每个进行中工具一行 `⏺ ToolName(参数摘要)`，活跃闪烁，结束变绿/红落定 scrollback；
- 连续只读工具聚合：`Read 3 files, Searched for 2 patterns`。

### 7.5 必备小件

- 颜色：手写 SGR（`\x1b[38;2;R;G;Bm` truecolor、`\x1b[1m` bold、`\x1b[2m` dim）；
- 宽度：中文/emoji 需 wcwidth 计算列宽，否则裁剪错位；
- 节流：SSE delta 触发的重绘合并到 16–32ms 帧。

---

## 附：关键代码位置速查

| 功能 | 位置 |
|---|---|
| 动作词表（~185 词） | `src/constants/spinnerVerbs.ts:16` |
| Spinner 主组件 / 动画行 | `src/components/Spinner.tsx:62` / `Spinner/SpinnerAnimationRow.tsx:81` |
| 全局动画时钟 | `src/ink/components/ClockContext.tsx:10` |
| 流事件分发状态机 | `src/utils/messages.ts:2930` |
| agent loop 消费点 | `src/screens/REPL.tsx:2793` |
| 整行截断技巧 | `src/screens/REPL.tsx:1473` |
| StreamingMarkdown | `src/components/Markdown.tsx:186` |
| 工具行 loader | `src/components/ToolUseLoader.tsx:11` |
| 折叠摘要 | `src/components/messages/CollapsedReadSearchContent.tsx:345` |
| 极简全局 store | `src/state/store.ts:10` |
| 渲染管线 diff/原子写 | `src/ink/log-update.ts:123` / `src/ink/terminal.ts:190` |
