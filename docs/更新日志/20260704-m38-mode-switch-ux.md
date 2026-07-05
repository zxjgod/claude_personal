# 2026-07-04 — Shift+Tab 模式切换体验优化

## 背景

基于代码审查发现 Shift+Tab 模式切换存在的 5 个不足，全部修复并同步文档。

## 主要变更

### 1. FullScreenApp 独立处理 Shift+Tab
- `FullScreenApp.tsx` 新增 `FsModeHotkey` 组件
- 全屏模式下不再依赖 `App.tsx` 的 `ModeHotkey`，完全自包含
- 清理了 `App.tsx` 中全屏路径的冗余 `ModeHotkey` 包装

### 2. 切换视觉反馈 (Toast)
- `store.ts` 新增 `toast` 状态和 `showToast()` 方法
- 新增 `Toast.tsx` 组件，居中显示带圆角边框的通知
- Shift+Tab 切换模式时显示 `Permission mode: <mode>` 提示，2 秒后自动消失
- Toast 集成到 `App.tsx` 和 `FullScreenApp.tsx`

### 3. Overlay 帮助文本补充
- `PermissionPrompt` — 底部提示添加 `Shift+Tab mode`
- `QuestionPrompt` — 底部提示添加 `Shift+Tab mode`
- `CommandPicker` — 底部提示添加 `Shift+Tab mode`
- `ProviderPicker` — 底部提示添加 `Shift+Tab mode`
- `SessionPicker` — 底部提示添加 `Shift+Tab mode`
- `EffortPrompt` — 底部提示添加 `Shift+Tab mode`

### 4. 模式说明帮助面板
- 新增 `HelpPanel.tsx` 组件
- 按 `?` 键触发（在 overlay 期间不触发）
- 显示全局快捷键说明列表
- 显示四种权限模式的详细描述（当前模式带 ❯ 标记）
- Esc 或 Enter 关闭
- `store.ts` 新增 `showHelp` 状态和 `setShowHelp()` 方法
- 集成到 `App.tsx` (`HelpRegion`) 和 `FullScreenApp.tsx` (`FsHelpRegion`)
- `ModeHotkey` / `FsModeHotkey` 增加 `?` 键处理

### 5. `/mode` 命令
- 新增 `src/commands/mode.ts`
- 无参数：显示模式列表（当前模式带 ❯ 标记）
- 带参数：`/mode bypassPermissions` 直接切换到指定模式
- 未知模式报错并列出可用模式
- 在 `registry.ts` 中注册
- `CommandContext` 新增 `setPermissionMode` 字段
- TUI 和非 TUI 路径均支持

### 6. 状态栏优化
- `theme.ts` 新增 `modeColor()` 函数和 `modeColors` 映射
- 状态栏移除了 `modelLabel`（供应商/模型 ID）
- 所有信息压缩到一行显示
- `mode:` 前缀移除，只显示模式名称
- 各模式颜色（亮色）：
  - `default` — 黄色 `#e0af68`
  - `acceptEdits` — 紫色 `#bb9af7`
  - `bypassPermissions` — 红色 `#f7768e`
  - `plan` — 蓝色 `#7aa2f7`

## 受影响文件

**新增：**
- `src/commands/mode.ts`
- `src/tui/HelpPanel.tsx`
- `src/tui/Toast.tsx`

**修改：**
- `src/tui/store.ts` — 新增 toast/showHelp 状态及相关方法
- `src/tui/App.tsx` — Toast、HelpPanel、StatusBar 更新
- `src/tui/FullScreenApp.tsx` — FsModeHotkey、FsHelpRegion、FsStatusBar 更新
- `src/tui/theme.ts` — modeColor 函数和 modeColors 映射
- `src/tui/Prompts.tsx` — 权限确认/问题提示添加 Shift+Tab 提示
- `src/tui/CommandPicker.tsx` — 命令面板添加 Shift+Tab 提示
- `src/tui/ProviderPicker.tsx` — 提供商选择器添加 Shift+Tab 提示
- `src/tui/SessionPicker.tsx` — 会话选择器添加 Shift+Tab 提示
- `src/tui/EffortPrompt.tsx` — 努力程度滑块添加 Shift+Tab 提示
- `src/commands/registry.ts` — 注册 modeCommand
- `src/commands/types.ts` — CommandContext 新增 setPermissionMode
- `src/cli.ts` — 命令上下文注入 setPermissionMode
- `src/tui/run.tsx` — TUI 命令上下文注入 setPermissionMode
- `src/__tests__/tui-components.test.tsx` — 测试更新以匹配新状态栏格式

## 验证结果

- `npm run typecheck`：通过
- `npm run check`：通过（202 files）
- `npm test`：通过（891 passed）

## 设计决策记录

- Toast 使用 `setTimeout` 自动清除，后继调用会替换前一个 toast
- HelpPanel 只在非 overlay 期间触发（避免输入冲突）
- FullScreenApp 完全自包含，不导入 `App.tsx` 的任何组件
- 模式颜色采用 Tokyo Night 配色方案中的亮色，辨识度高
