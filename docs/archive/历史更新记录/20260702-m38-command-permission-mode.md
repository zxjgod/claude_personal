# 2026-07-02 — M38 `/` 指令深化 + Shift+Tab 权限模式即时切换

## 背景

用户提出 M38 计划：先写 M 计划表，再实施，再同步其他文档。需求包括：

1. `/effort` 每个努力程度必须有明确文档定义，并说明不同努力程度的区分度。
2. `/sessions` 支持删除历史对话。
3. `/compact` 压缩过程要有进度条。
4. TUI 中 Shift+Tab 可在 `default`、`acceptEdits`、`bypassPermissions`、`plan` 四种权限模式间循环；AI 思考中也可切换，后续权限检查即时生效；同时不得绕开安全地板，也不得让最高权限模式失效。

本次先落地 [`../archive/20260702-M38计划表-指令深化与权限模式.md`](../20260702-M38计划表-指令深化与权限模式.md)，再按计划实施。

## 主要变更

- 更新 `src/effort.ts`
  - 新增 `EFFORT_DEFINITIONS`，集中维护 `low`/`medium`/`high`/`xhigh`/`max`/`ultracode` 的产品语义定义、行为边界和供应商映射说明。
  - 保留 `EFFORT_DESCRIPTIONS`，但改为由 `EFFORT_DEFINITIONS` 派生，避免摘要和完整定义漂移。

- 更新 `src/commands/effort.ts`
  - `/effort` 无参数时除滑块外，展示每一档的明确含义、行为边界和映射说明。
  - `/effort <level>` 设置后输出该档的定义详情。
  - 明确说明 OpenAI-compatible 后端的 `reasoning_effort` 参数只有 low/medium/high，`xhigh`/`max`/`ultracode` 在参数层会降级到 high，但产品语义仍保留。

- 更新 `src/commands/sessions.ts`
  - `/sessions` 保持原列表行为。
  - 新增 `/sessions delete <session-prefix-or-id>`（同义：`rm`/`remove`）。
  - 删除前做唯一匹配保护：0 匹配只提示不存在；多匹配提示使用更长前缀；只有唯一匹配才调用 `deleteSession(sessionId)`。
  - 不提供批量删除或 clear-all，降低误删历史会话风险。

- 更新 `src/commands/compact.ts`
  - `/compact` 从静态 `Compacting...` 改为阶段式进度条：准备、预裁剪、模型摘要、完成。
  - 进度条表达可观测阶段，不伪造 LLM 内部 token 级真实百分比。

- 更新 `src/types.ts` / `src/agent-loop.ts`
  - `ToolContext` 新增可选 `getPermissionMode` / `setPermissionMode`。
  - agent-loop 构造 `baseContext` 时保留 getter/setter，并在每次工具权限检查前刷新 `context.permissionMode`。
  - 这样 Shift+Tab 在 AI 思考/忙碌期间切换后，后续工具调用会读取最新权限模式，而不是 turn 开始时的旧快照。

- 更新 `src/tools-m8-interactive.ts`
  - `enter_plan_mode` / `exit_plan_mode` 在修改当前 `ToolContext.permissionMode` 的同时，也调用可选 `setPermissionMode`，让 TUI 状态栏和后续权限检查同步更新。

- 更新 `src/tui/store.ts`
  - `StoreState` 新增 `permissionMode`。
  - 新增 `PERMISSION_MODE_CYCLE`、`nextPermissionMode()`、`getPermissionMode()`、`setPermissionMode()`、`cyclePermissionMode()`。
  - 循环顺序固定为 `default → acceptEdits → bypassPermissions → plan → default`。

- 更新 `src/tui/App.tsx` / `src/tui/FullScreenApp.tsx`
  - 状态栏显示当前 `mode:<permissionMode>`。
  - 默认 TUI 和 fullscreen TUI 都显示 Shift+Tab mode 提示。
  - `App.tsx` 使用 Ink `useInput` 捕获 `key.tab && key.shift`，忙碌中也可循环权限模式。

- 更新 `src/tui/run.tsx`
  - 创建 `TuiStore` 时用启动权限模式初始化 store。
  - agent-loop 的 `ToolContext` 改为使用 store 的实时 getter/setter。
  - TUI slash command 上下文也注入实时 `getPermissionMode`，`/status`、`/config` 显示当前模式而非启动旧值。

- 更新 `src/cli.ts` / `src/commands/types.ts` / `src/commands/status.ts` / `src/commands/config.ts`
  - 非 TUI 路径也把启动权限模式放入可变状态 holder，便于 plan-mode 工具同步更新。
  - `/status`、`/config` 优先读取 `ctx.getPermissionMode?.()`。

## 测试

新增/更新测试覆盖：

- `commands.test.ts`
  - `/sessions delete` 唯一匹配成功删除。
  - `/sessions delete` 前缀歧义时不删除并提示使用更长前缀。
  - `/compact` 输出阶段式进度文本。
  - `/effort` 无参数输出完整层级说明和 OpenAI-compatible 映射提示。
- `tui-store.test.ts`
  - `cyclePermissionMode()` 按 `default → acceptEdits → bypassPermissions → plan → default` 循环。
  - `setPermissionMode()` 可直接更新 store 快照。

## 验证结果

- `npm run typecheck`：通过
- `npm run check`：通过（199 files，无需修复）
- `npx vitest run --dir src src/__tests__/commands.test.ts src/__tests__/tui-store.test.ts src/__tests__/permissions.test.ts`：通过（113 passed）
- `npm test`（`vitest run --dir src`）：通过（74 个测试文件，891 passed）
- `npm run build`：通过（125 files → dist）

## 受影响文件

**新增：**
- `docs/archive/20260702-M38计划表-指令深化与权限模式.md`
- `docs/archive/历史更新记录/20260702-m38-command-permission-mode.md`

**修改：**
- `src/effort.ts`
- `src/commands/effort.ts`
- `src/commands/sessions.ts`
- `src/commands/compact.ts`
- `src/commands/types.ts`
- `src/commands/status.ts`
- `src/commands/config.ts`
- `src/types.ts`
- `src/agent-loop.ts`
- `src/tools-m8-interactive.ts`
- `src/cli.ts`
- `src/tui/store.ts`
- `src/tui/App.tsx`
- `src/tui/FullScreenApp.tsx`
- `src/tui/run.tsx`
- `src/__tests__/commands.test.ts`
- `src/__tests__/tui-store.test.ts`
- `docs/项目架构.md`
- `docs/更新日志/README.md`

## 设计决策记录

- `/sessions delete` 只做唯一匹配删除，不做批量删除，是因为历史会话删除不可逆，前缀歧义时必须失败。
- `/compact` 进度条采用阶段式表达，不做真实百分比，是因为 LLM 摘要阶段内部进度不可观测；伪造精确进度会误导用户。
- Shift+Tab 只改变实时 `permissionMode`，所有工具仍必须走 `agent-loop → checkPermission()`；`isBlockedPath` 与 `dangerousPattern` 仍在 `bypassPermissions` 前执行，保持 bypass-immune 安全地板。
- `ToolContext` 的实时 getter/setter 是可选字段，保留旧测试和非 TUI 调用方只传静态 `permissionMode` 的兼容性。
- 状态栏显示 `mode:<permissionMode>`，让用户能在 busy/思考期间确认当前权限模式是否已经即时切换。

## 注意

`bypassPermissions` 是四种普通模式中的最高自动放行模式，但不是安全地板绕过模式。敏感路径和危险命令仍会被 `permissions.ts` 的安全地板拦截，这是 M38 的明确不变量。
