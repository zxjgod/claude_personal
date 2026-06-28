# 2026-06-28 — M23 TUI 体验对齐参考版

## 背景

原 TUI 状态行只显示静态 `Thinking` / `Responding`，使用独立 `ParticleSpinner`，工具卡又使用 `ink-spinner` dots。行式 CLI 已经有较完整的参考版 spinner（粒子字形、橙色、shimmer、秒表、token），但 TUI 没有复用。

M23 将 spinner 原语抽成共享模块，并把 TUI 状态行/工具卡统一到同一套视觉与节奏。

## 主要变更

- 新增 `src/spinner-core.ts`
  - 共享 verbs / 粒子帧 / 颜色 / shimmer 数学 / `formatDuration` / `formatTokens` / `glyphAt` / `actionLabel`。
  - `cli-spinner.ts` 改为从这里 import，并 re-export 旧测试依赖的函数，保持兼容。
  - 粒子帧集按用户偏好移除 `✳`，当前为 `· ✢ ✶ ✻ ✽`（正放 + 倒放）。

- 新增 `src/tui/SpinnerGlyph.tsx`
  - 隔离的橙色粒子字形组件。
  - 自带 `setInterval`，只重绘自己这个叶子组件。

- 新增 `src/tui/StatusLine.tsx`
  - TUI 工作状态行：`✶ Reading App.tsx (16s · ↑ 1.2k tokens)`。
  - 包含橙色粒子、shimmer 标签、实时秒表、token 后缀。
  - 标签由具体动作驱动：`Reading` / `Writing` / `Editing` / `Running` / `Searching` / `Fetching` / `Delegating`。

- 新增 `src/tui/stream-buffer.ts`
  - `text_delta` 合批约 30fps flush，避免每 token 触发一次 store emit + Ink 重绘。
  - timer 可注入，便于确定性单测。

- 更新 `src/tui/run.tsx`
  - turn 开始记录 `turnStartedAt`。
  - 流式期间 token 用 char/4 估算，`usage.output_tokens` 到达后校准为真实累计值。
  - 工具调用/错误/abort/done 前 flush stream buffer，避免尾部文本滞留。

- 更新 `src/tui/App.tsx`
  - 流式期间渲染纯文本，不再每个 delta 重跑 markdown lexer。
  - assistant 文本提交为 transcript 后再解析 markdown。
  - 使用 `StatusLine` 取代旧 spinner 行。

- 更新 `src/tui/ToolCard.tsx`
  - 活动工具卡改用 `SpinnerGlyph` + `actionLabel`。
  - TUI 状态行与工具卡字形/配色统一。

- 删除
  - `src/tui/ParticleSpinner.tsx`
  - `ink-spinner` 依赖

## 测试

新增/更新测试覆盖：

- `spinner-core.test.ts`
- `stream-buffer.test.ts`
- `status-line.test.tsx`
- `tui-store.test.ts`

验证结果：

- `npx tsc --noEmit` 通过
- `npx biome check src` 通过
- `npm test`：651/651 passed
- `npm run smoke`：PASSED

## 注意

`usage` 事件在当前 agent-loop 协议里位于模型流末尾，所以状态行无法在流式中拿到逐 token 的真实输出 token。实现采用“流式估算 + usage 落地校准”的方式；最终会话累计 token 保持真实精确。
