# 2026-06-28 — M24 TUI 响应平滑 + 输入框稳定（加强修复轮）

## 背景

用户实测 M23 产物有两个体感问题：

1. **AI 输出响应不平滑、生硬、卡顿**。
2. **输入框跳位**：在下方输入字母（ASCII）会被强制弹到固定位置，删字也跳；**输入汉字不跳**。

通读当前 `main`（最后提交 `4c2d9b8 update for tui`）后还确认了一处**文档/代码漂移**：`M计划更新日志.md`（M17）与 `项目计划表.md`（M15.1 / M17）都声称已落地帧合批 / 字段订阅 / ScrollBox / alt-screen / 多行输入，但**当前源码里这些机制全部不存在**（M23 是在一棵已回退掉 M15.1/M17 成果的树上做的）。`/keybindings` 仍宣传 `Ctrl+J`、`PgUp/PgDn`，实际按了无反应。

本轮按用户选定的**最小稳定**范围：只治「响应平滑度」「输入框稳定性」，并消除文档漂移；**保留现有 `<Static>` 滚动模型，不引入 alt-screen**（M17 全量重做留待 M25）。

## 根因

| 症状 | 根因 |
|---|---|
| 卡顿 | `store.set()` 每次同步 `emit()` + `App` 用 `useSyncExternalStore` **整快照订阅** → 流式每帧（~30fps）触发整棵 Ink 树 reconcile（含输入框、状态栏、全部活动卡）。在途 assistant 文本是不断增长的 `<Text>`，每帧整段重跑 Yoga 布局。 |
| 跳位 | `InputBox` 分隔线 `"─".repeat(terminalColumns())` **正好等于终端列宽** → 触发 DECAWM 自动折行，终端实际占行比 Ink 行模型多 1 行；每次 InputBox 重渲染（ASCII 每键一次、退格一次；中文走 IME 仅上屏一次）→ Ink 按错误行数定位动态区 → 输入框「跳」。`InputBox` 是全仓**唯一**顶格 `repeat(cols)`，其余渲染器早已留 `-1`。 |

> 「打汉字不跳、打字母跳」是关键线索：ASCII 每 keypress 同步重渲、错位累积；中文经 IME 组字阶段不逐码点交付程序，重渲次数远少。这把根因精确指向「InputBox 重渲时的行数/布局计算」而非输入逻辑。

## 主要变更

- 更新 `src/tui/store.ts`（24.1 帧合批）
  - `set()` 仍**立即写 state**（`getSnapshot` 即时可见，同步读者/测试零回归），仅把 `emit()` 延到下一帧合并：`scheduleEmit()` + `FRAME_MS=16`。
  - 新增 `flush()`（同步排空待发通知）、`setBatching(on)`（切同步语义，关时先 flush）、构造器 `{ batching? }`。
  - **默认 OFF**（单测同步断言不变）；`runTui` 构造时开 ON。

- 新增 `src/tui/useStoreSelector.ts`（24.2 字段切片订阅）
  - `useStoreField(store, key)` —— 订阅单字段，`Object.is` 比较。
  - `useStoreSelector(store, selector)` —— 订阅派生切片，**浅等缓存**：selector 返回的 fresh object 若与上次浅等则返回旧引用，避免身份变化打穿 React bail-out / 破坏 `getSnapshot` 稳定性。

- 更新 `src/tui/App.tsx`（24.2 / 24.3 / 24.5）
  - root **不再整快照订阅**；拆为六个区域组件各订阅自己的切片：`TranscriptRegion`（`transcript`）/ `StreamingRegion`（`streamingText`）/ `ActiveToolsRegion`（`activeTools`）/ `StatusLineRegion`（状态切片）/ `InteractionRegion`（`overlay`+`busy`）/ `StatusBar`（model+token）。
  - 流式文本进独立 `StreamingRegion`：token delta **只重渲这一叶子**，输入框/状态栏不动。
  - 外层列容器固定区域**垂直顺序**，InputBox 位置可预测。

- 更新 `src/tui/run.tsx`（24.1）
  - `runTui` 构造 store 时 `{ batching: true }`。
  - `runTurn` 的 `finally` 调 `store.flush()`，turn 结束的 idle 态立即上色。

- 更新 `src/tui/InputBox.tsx`（24.4 治跳位核心 / 24.5）
  - 模块级 `RULE_WIDTH = terminalColumns()` 改为 per-render `ruleWidth() = Math.max(20, cols - 1)`，**留 1 列防 DECAWM 折行**，并随终端 resize 自适应。

- 更新 `src/commands/keybindings.ts`（24.0 去不实宣传）
  - 删除未实现的 `Ctrl+J`（换行）与 `PgUp/PgDn`（滚动回看），只列真实可用键位；细化 ↑/↓ 描述为「命令面板导航」。

- 文档漂移更正（24.0）
  - `docs/archive/项目计划表.md`：M15.1 收口节、M17 节各加「⚠️ 漂移更正」横幅。
  - `docs/archive/M计划更新日志.md`：M17 节加同款横幅。
  - 均显式标注「在当前 main 已回退，未随 M23 保留」，并指明 M24 重新落地范围与 M25 待办（ScrollBox/alt-screen）。

## 测试

- 新增 `src/__tests__/use-store-selector.test.tsx`（2 例）
  - 未订阅字段变化不重渲、订阅字段变化才重渲（`useStoreField` + `useStoreSelector` 浅等缓存）。
- `src/__tests__/tui-store.test.ts` 加帧合批 5 例
  - 默认同步 / 批量合并为单 notify（state 仍即时可见）/ `flush` 幂等 / 帧定时器自发 emit / `setBatching(false)` 排空并恢复同步。
- `src/__tests__/input-box.test.tsx` 加分隔线宽度回归 1 例
  - 渲染出的横线严格窄于终端列宽（不顶格）。

## 验收

- `tsc --noEmit` 0 错。
- `biome check src/` 干净（164 文件）。
- `vitest run --dir src` **659/659**（651 → 659，+8）。
- `npm run smoke` PASSED。
- 真机 `npm start` 手测：长流式平滑、ASCII 输入/退格不跳（待用户确认）。

## 决策

1. **最小稳定优先于全量恢复 M17** —— 帧合批 + 字段订阅 + 留 1 列即可根治两症状，无需高风险的 alt-screen 大改；alt-screen 历史上已回退过一次，重做单独成轮（M25）。
2. **`set()` 立即写 state、仅延迟 emit** —— 合批只作用「通知频率」，不作用「状态可见性」，保同步测试与非 React 读者零回归。
3. **默认 batching OFF，生产 ON** —— 单测保持同步断言零改动。
4. **分隔线留 1 列而非顶格** —— 最小、零依赖、跨终端稳定的修法。
5. **24.3 尾窗暂不做** —— mid-stream 段落折进 `<Static>` 会改变流式提交模型、有部分 markdown/重排风险；隔离子树已足够平滑，不引入该风险。
6. **文档漂移显式标注而非默默补码** —— M15.1/M17 是否回填由 M25 决定，但「文档说有、代码没有」当轮消除。

## 不做（本轮边界）

- 不引入 alt-screen（DEC 1049）/ ScrollBox / 全屏贴底布局（M17 全量重做，留 M25）。
- 不做多行输入（Ctrl+J）+ ↑/↓ 行间光标（同属 M17，留 M25）。
- 不改 agent-loop 事件协议。
- 不动行式 CLI（非 TTY）路径。

---

## 追加（同日）：实时流式 markdown 渲染

### 触发

用户要求：**AI 输出时就用 markdown 渲染**、同时**不卡顿**、TUI 以 **claude code** 为目标。

这撤销了上文 24.3 的「markdown 延到提交时解析」决策（M23.7 起的做法）。原决策是为避免每帧重新 lex 整段 markdown 而把渲染推迟到消息提交——但它与「输出时就渲染 markdown」直接冲突。

### 正解：单调稳定前缀分割（对齐参考标准）

参考标准 `reference/components/Markdown.tsx` 的 `StreamingMarkdown` 给出了既实时又不卡的解法，本轮照此移植：

- 新增 `src/tui/StreamingMarkdown.tsx`
  - `stablePrefixRef` 记录「已 settle」的边界。每帧只 `marked.lexer(children.substring(boundary))` —— 成本 O(尾块长度)，不是 O(整条消息)。
  - 把「最后一个非 `space` token」之前的已完成块推进稳定前缀；稳定前缀经 `memo` 包裹的 `MarkdownChunk` **解析一次、之后永不重 lex**（尾块增长不影响它）。
  - 只有制作中的最后一个块每帧重 lex。
  - `marked.lexer` 把未闭合的 ` ``` ` 代码围栏当成单个 token，所以边界**永不切进开放围栏**——块边界总是安全的。
  - 边界**单调递增** → render 期间写 ref 是幂等的（StrictMode 双渲染安全）；提交时组件卸载（`streamingText → ""`）自动重置。

- 更新 `src/markdown.ts`
  - 加 `hasMarkdownSyntax` 快路径：首 500 字符无 markdown 标记 → 跳过 `marked.lexer`，按纯段落返回（trim 尾换行）。省去纯文本尾每帧 ~3ms 的 lex。

- 更新 `src/tui/App.tsx`
  - 抽 `AssistantMessage`（橙 `●` 项目符 + markdown 列布局），**共享**给「已提交 assistant 行」与「流式区」——提交瞬间无布局跳动，尾块只是停止重 lex。
  - `StreamingRegion` 由「渲染纯文本」改为 `<StreamingMarkdown>{streamingText}</StreamingMarkdown>`。

### 为什么这样不卡

- 稳定前缀只解析一次（`memo`），流式增长**不会**让它重新 lex。
- 每帧重 lex 的只有一个尾块（有界）。
- 叠加本轮已落地的字段切片订阅（仅 `StreamingRegion` 重渲）+ StreamBuffer ~30fps 合批 + 帧合批 emit —— 重渲范围、重渲频率、重 lex 范围三者都被夹住。

### 测试

- 新增 `src/__tests__/streaming-markdown.test.tsx`（6 例）
  - 已完成块的标题/粗体**标记被消费**（不泄漏 `**`/`#`）。
  - 列表渲染成 bullet 而非裸 `-`。
  - 未闭合代码围栏留在实时尾块、不被提前切分。
  - 跨 `rerender` 增长时块逐个干净 settle（稳定前缀 ref 跨重渲持续）。
  - `renderMarkdown` 纯文本快路径原样返回（trim）、真 markdown 仍走 lexer。

### 验证

- `tsc --noEmit` 0 错。
- `biome check src/` 干净（166 文件）。
- `vitest run --dir src` **665/665**（659 → 665，+6）。
- `npm run smoke` PASSED。
- 真机 `npm start`：流式输出实时显示 markdown（标题/粗体/列表/代码），长输出不卡（待用户确认）。

### 决策更新

- **撤销 24.3「markdown 延到提交」**，改为**实时流式 markdown**（稳定前缀分割）。这是「实时渲染」与「不卡顿」唯一兼得的做法，且与参考标准一致。
- mid-stream 段落折进 `<Static>` 的尾窗优化**仍不做**——稳定前缀分割已把重 lex 成本夹到 O(尾块)，无需改流式提交模型。

