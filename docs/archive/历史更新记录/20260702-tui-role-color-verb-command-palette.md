# 2026-07-02 — TUI 角色分色 + 思考态趣味动词循环 + `/help` 命令面板

## 背景

用户提出三点体验诉求：

1. TUI 文字配色分散在各组件的内联十六进制常量里，缺少统一的角色语义（用户 / 助手 / 命令 / 工具 / 成功 / 错误）。
2. 思考中的状态行只显示静态 `Thinking`，M23 引入的 `SPINNER_VERBS`/`pickVerb()` 一直没接进 TUI。
3. `/` 补全下拉硬编码只显示前 8 条、无法滚动；`/help` 在 TUI 里没有交互式全列表，只有静态文本。

征询方向后用户选择：文字配色走「角色分色」，思考态走「循环趣味动词」；命令展开做成方向键选择 + 视口跟随滚动的 overlay（复用 `/resume` SessionPicker 的滚动窗口原语）。

## 主要变更

- 新增 `src/tui/theme.ts`
  - 集中调色板 `palette`：`accent`/`accentBright`/`user`/`command`/`tool`/`success`/`error`，替代散落各文件的内联 hex 常量。

- 更新 `src/tui/App.tsx` / `src/tui/FullScreenApp.tsx`
  - 全部内联颜色改为 `palette.*`。
  - `TranscriptRow` 的 `user` 分支：标记与文本统一用 `palette.user`（原来标记是 `dimColor`，文本无色）。
  - `StatusLineRegion`/`FsStatusLine` 传入 `cycleVerbs={spinner === "thinking"}`。
  - `InteractionRegion`/`FsInteraction` 的 overlay 分支接入新的 `commandPicker`。

- 更新 `src/tui/ToolCard.tsx`
  - 颜色路由到 `palette`：成功/错误行用 `palette.success`/`palette.error`；工具名加粗 `palette.tool`；标题圆点 `palette.accent`。

- 更新 `src/spinner-core.ts`
  - 新增 `VERB_CYCLE_MS = 3500` 与 `verbAt(elapsedMs, seed)`：按「已过时间 + seed」确定性选词，而非每次渲染随机挑词——TUI 在思考阶段以 ~12fps 重渲染，随机会闪烁，时间驱动则每 3.5s 稳定切换一次。

- 更新 `src/tui/StatusLine.tsx`
  - 新增 `cycleVerbs?: boolean` prop；为真时用 `verbAt(elapsedMs, startedAt)` 算出的动词替换静态 `label`，再送入 `shimmerParts`。

- 新增 `src/tui/CommandPicker.tsx`
  - `/help`（或 `/commands`）弹出的命令面板 overlay，结构仿 `SessionPicker.tsx`：↑↓ 移动光标、PgUp/PgDn 翻页、Enter 执行选中命令、Esc 取消。
  - 复用 `SessionPicker.tsx` 导出的 `nextOffset` 滚动窗口原语，视口随光标滚动，超出窗口显示「↑/↓ N more」。

- 更新 `src/tui/store.ts`
  - 新增 `CommandPickerItem` 接口与 `Overlay` 的 `commandPicker` 分支。
  - 新增 `pickCommand(commands): Promise<string | null>`，与既有 `pickSession`/`askQuestion` 同样的 resolve 模式。

- 更新 `src/tui/run.tsx`
  - 新增 `runCommandPicker`：把已注册命令列表喂给 `store.pickCommand`，空列表时走 `addNotice` 提示。
  - `onSubmit` 内新增拦截（放在最前，先于 `/effort`/`/resume`/`/provider`）：`^\/(help|commands)\s*$` 命中时打开面板，选中后以 `"/" + chosen` 递归调用 `onSubmit` 走正常命令分发路径。

- 更新 `src/tui/InputBox.tsx`
  - `/` 内联补全下拉去掉硬编码 8 条截断，改为和 `CommandPicker` 一致的滚动窗口：`suggestOffset` state + `nextOffset` 维护窗口，↑↓ 支持环绕（wrap-around），超出窗口显示更多提示。
  - 颜色改用 `palette.accent`/`palette.command`。

## 测试

新增/更新测试覆盖：

- `spinner-core.test.ts`：新增 `verbAt`/`VERB_CYCLE_MS` 用例（时间扫描下始终落在词表内、窗口内稳定、40 步内出现多个不同动词、负数 elapsed 归零处理）。
- `tui-components.test.tsx`：新增 `CommandPicker` 用例（25 条假命令渲染头部/行/more 标记、Enter 选中、连续下箭头触发窗口滚动后选中、Esc 取消）。
- `tui-store.test.ts`：新增 `pickCommand` 的 resolve / 取消（null）用例。

## 验证结果

- `npx tsc --noEmit`：通过
- `npx biome check src`：通过（199 files，无需修复）
- `npm test`（`vitest run --dir src`）：886 个用例，全量并跑下 1 个用例（`CommandPicker … scrolls the window …`）因资源争抢命中 5s 超时；单独/隔离运行稳定通过（`1 passed | 21 skipped` via `-t` 过滤），判定为测试基建层面的计时抖动，非功能回归。
- `npm run build`（esbuild）：此次未单独重跑，历史构建（同一批改动）成功转译；本次仅补充文档，不改代码，故未重复执行。

## 受影响文件

**新增：**
- `src/tui/theme.ts`
- `src/tui/CommandPicker.tsx`

**修改：**
- `src/tui/App.tsx`
- `src/tui/FullScreenApp.tsx`
- `src/tui/ToolCard.tsx`
- `src/spinner-core.ts`
- `src/tui/StatusLine.tsx`
- `src/tui/store.ts`
- `src/tui/run.tsx`
- `src/tui/InputBox.tsx`
- `src/__tests__/spinner-core.test.ts`
- `src/__tests__/tui-components.test.tsx`
- `src/__tests__/tui-store.test.ts`

## 设计决策记录

- 未新建独立「主题系统」（`/theme` 命令仍是既有 stub），配色统一到单一 `palette` 常量表即可满足「角色分色」诉求，避免过度设计。
- 动词切换选择「确定性时间驱动」而非随机，是为了配合已有的高频重渲染（M24 帧合批后仍有逐 token 重绘），避免视觉闪烁；实现直接复用 M23 已有的 `SPINNER_VERBS` 词表，未新增词条。
- `CommandPicker` 与 `InputBox` 内联下拉共用 `nextOffset`，未各自实现滚动窗口，避免逻辑分叉。
- 选中 `/help` 本身会重新命中 `^\/(help|commands)\s*$` 正则、再次弹出面板而不会回退到静态帮助文本——已知行为，非缺陷（用户尚未要求改成运行静态帮助），此处登记以便日后决定是否调整。

## 注意

若后续要给 `/help` 选中自身时改成打印静态帮助文本而非重新弹面板，只需在 `run.tsx` 的拦截逻辑里把 `chosen === "help"` 单独分支到旧的静态处理路径。
