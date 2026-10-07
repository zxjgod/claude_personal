# 更新日志 — /resume 交互式 Session Picker（方向键选择 + 滚动窗口 + 历史回放）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-06-28
> 类型：feature
> 模块：TUI（tui/run.tsx · tui/store.ts · tui/App.tsx · 新增 tui/SessionPicker.tsx · 新增 tui/history-replay.ts）+ commands/resume.ts
> 主题：在 TUI 中输入裸 `/resume` 弹出可上下选择的历史会话列表，回车恢复整段对话（零 token），列表带滚动窗口且选中项不被挤出屏幕，恢复后旧聊天记录完整回放到界面可向上翻看。
> 状态：已落地
> 验证：`npm run build`（tsc）通过；`npx vitest run` 项目自有用例 506/506 全过（新增 17 例）
> 关联 commit：待提交（本次工作树改动）
> 关联文档：[项目架构.md §12 TUI](../../项目架构.md) · [项目总览.md 模块清单](../../项目总览.md)

---

## 一、现象 / 用户反馈

用户希望丰富 `/resume` 指令：此前 `/resume` 必须带 session id（`/resume <id>`），裸 `/resume` 只打印用法提示。诉求分两轮：

**第一轮（基础）**
1. 输入 `/resume`（不带参数）弹出会话选择界面，上下排列展示所有历史 session。
2. 每个 session 有简单摘要名（日期、消息数等）。
3. ↑↓ 键切换选择。
4. 回车恢复该 session 的全部对话。
5. 恢复过程**不消耗 token**（仅把历史读进数组，不触发 LLM）。

**第二轮（补充）**
6. **滚动窗口**：列表过长时选中项不能被挤出屏幕，窗口要跟随光标滚动，高亮项始终可见。
7. **历史回放**：resume 之后之前所有聊天记录（user / assistant / tool 调用）必须在 TUI 上完整显示，可向上翻看。

---

## 二、根因（为何原实现不满足）

| # | 缺口 | 位置（文件:行） | 后果 |
|---|------|----------------|------|
| 1 | 裸 `/resume` 无交互选择器 | `src/commands/resume.ts`（原 `if (!id) 打印用法`） | 用户必须先记住/手敲 id |
| 2 | `resumeSession` 只改内存数组、用 `console.log` 提示 | `src/cli.ts:371` | TUI 下不回放、且裸 log 会污染 Ink 帧 |
| 3 | TUI transcript 不随 `messages` 数组重建 | `src/tui/run.tsx` | resume 后屏幕不显示历史，无法向上翻看 |

**机制：** TUI 的 overlay 能力（权限/提问/effort）已是成熟模式——store 持有 `overlay` 状态、组件渲染、`askX()` 返回 promise 由 orchestration await（见 `tui/store.ts` 与 `tui/Prompts.tsx`）。`/effort` 裸命令已示范「在 `run.tsx` 的 `onSubmit` 里于斜杠分发前拦截、直接开 overlay」。本次按同一范式补 `sessionPicker` overlay；恢复的状态改写沿用既有 `resumeSession`（它原地改写 `messages` 数组、更新 `cli.ts` 的 `sessionId`，全程不碰模型 = 零 token），仅补上「回放到 transcript」这一步。

---

## 三、改动明细

### 新增 `src/tui/history-replay.ts`（106 行）

把保存的 `Message[]` 纯函数式转换成 TUI 的 `TranscriptItem`，供 resume 回放使用（无 fs / 无 LLM / 零 token）。

```ts
export function messagesToTranscript(messages: Message[]): ReplayItem[]
export function firstUserPreview(messages: Message[], maxLen = 72): string
```

要点：
- 先用 `tool_call_id` 把 `role:"tool"` 的输出建索引，再为每个 assistant 的 `tool_calls` 内联其结果，输出一条 `kind:"tool"` 项（独立 tool 消息不重复发）。
- 跳过 `system`（压缩摘要/注入上下文），只回放 user/assistant/tool 三类人面对话。
- `firstUserPreview` 取首条用户消息做选择器预览行。

### 新增 `src/tui/SessionPicker.tsx`（113 行）

会话选择 overlay 组件：垂直列表 + ↑↓/PgUp/PgDn/数字键 + 回车选中 / Esc 取消。

要点：
- **滚动窗口**（需求 6）：每屏只画 `VISIBLE=8` 行，光标越过上/下边界时窗口最小幅度滑动以保持高亮可见；`↑ N more` / `↓ N more` 标记隐藏行数。滚动数学抽成纯函数 `nextOffset(cursor, offset, windowSize)` 并导出，便于确定性单测（避免依赖 Ink 输入解析）。
- 行内容：`id8 · N msgs · 时间 · open/done` + 暗色首消息预览；当前会话用 ● 高亮标记。

### 修改 `src/tui/store.ts`（271 → 325 行）

- 新增类型 `SessionPickerItem`；`Overlay` 联合新增 `sessionPicker` variant。
- 新增 `pickSession(items): Promise<string | null>`（与 `askPermission/askQuestion/askEffort` 同范式，overlay 接管输入直到选中/取消）。
- 新增 `loadTranscript(items)`：一次性把整批预构建的 transcript 项打上新 id 合并进 transcript（单次 re-render → Ink `<Static>` 一次性打印进滚动历史，可向上翻看）；空批为 no-op（不触发 emit）。

### 修改 `src/tui/App.tsx`（138 → 141 行）

overlay 分支新增 `sessionPicker` → 渲染 `<SessionPicker>`。

### 修改 `src/tui/run.tsx`（352 → 428 行）

- `onSubmit` 在斜杠分发前拦截裸 `/resume`（正则 `/^\/resume\s*$/i`，`/resume <id>` 仍走原静态处理器）。
- 新增 orchestrator `runResumePicker(store, deps)`：`listSessions` →（上限 50，逐个 `load` 取预览）构建选择项 → `store.pickSession` → 选中后用 `captureConsole` 包住既有 `resumeSession`（抑制其 `console.log` 防污染 Ink 帧、读取布尔返回）→ `messagesToTranscript(deps.messages)` 回放 + 一条「Resumed … 0 tokens」notice。

要点：
- `deps.messages` 与 `cli.ts` 的 `messages` / `makeCommandContext` / `resumeSession` 是**同一数组引用**，故 `resumeSession` 原地改写后，回放直接读 `deps.messages` 即可；`sessionId` 也由 `resumeSession` 更新，后续保存写回所选 session。
- 采用「追加」而非「清屏重绘」：Ink `<Static>` 不重绘已打印行，追加是与其契合且稳健的选择，同样满足「向上翻看历史」。

### 修改 `src/commands/resume.ts`（25 → 47 行）

裸 `/resume` 在**非 TTY 行式 REPL**（拿不到 overlay）下改为列出最近会话 + 提示用 `/resume <prefix>`；`/resume <id>` 行为不变（测试 `/resume abc` 仍通过）。

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run build`（tsc） | 通过，0 错误，产物 `dist/tui/SessionPicker.js`、`dist/tui/history-replay.js` 生成 |
| `npx vitest run`（项目自有） | 506 / 506 全过；新增 17 例：history-replay 7 例 + store picker/replay 4 例 + SessionPicker 组件/滚动 6 例 |
| 滚动窗口不变量 | `nextOffset` 全程上下走查断言：`offset ≤ cursor < offset+window` 恒成立 |

> 注：`npx vitest run` 另报约 440 个「失败文件」，全部在 vendored 的 `claude-code-参考标准/`（它们 `import bun:test`，非本项目，预存现象）。判健康看 “Tests: 506 passed”。

---

## 五、受影响文件

**新增**
- `src/tui/SessionPicker.tsx`（选择器 overlay 组件 + 导出纯函数 `nextOffset` 滚动数学）
- `src/tui/history-replay.ts`（`messagesToTranscript` / `firstUserPreview`，纯数据转换）
- `src/__tests__/history-replay.test.ts`（7 例）

**修改**
- `src/tui/store.ts`（`SessionPickerItem` 类型 + `sessionPicker` overlay + `pickSession()` + `loadTranscript()`）
- `src/tui/App.tsx`（渲染新 overlay）
- `src/tui/run.tsx`（裸 `/resume` 拦截 + `runResumePicker` 编排 + 回放）
- `src/commands/resume.ts`（非 TTY 裸 `/resume` 列出会话）
- `src/__tests__/tui-store.test.ts`（+4 例：picker 解析/取消、loadTranscript 追加/空批）
- `src/__tests__/tui-components.test.tsx`（+6 例：SessionPicker 渲染/回车/Esc + `nextOffset` 滚动）

**删除**
- 无

---

## 六、设计决策记录

1. **沿用 overlay 范式而非新机制** —— `pickSession` 与既有 `askPermission/askQuestion/askEffort` 一致（store 持 overlay + promise）；裸命令拦截与 `/effort` 一致（在 `run.tsx` 斜杠分发前）。改动面最小、与现有 TUI 一致。
2. **复用 `resumeSession` 做状态改写** —— 恢复的「改 `messages` + 改 `sessionId` + 零 token」已在 `cli.ts` 正确实现且被两条路径共享；本次只补「回放」，不重复实现恢复逻辑（避免双份易漂移）。
3. **回放用「追加」而非「清屏重绘」** —— Ink `<Static>` 永不重绘已打印行，给它换 `key` 强制 remount 复杂且易重复打印；追加进滚动历史同样满足「完整显示 + 向上翻看」。如需 resume 时整屏清空重画，是可选后续（keyed `<Static>` remount）。
4. **滚动数学抽成纯函数 `nextOffset`** —— 把「窗口跟随光标」的核心逻辑与 React/Ink 输入解耦，可确定性单测（组件级输入解析在该 Ink 版本有怪异，纯函数测试更可靠）。
5. **预览加载设上限 50** —— 选择器为每个会话读一次 JSON 取首消息预览，按更新时间倒序取前 50，避免超大历史目录触发数百次文件读。
