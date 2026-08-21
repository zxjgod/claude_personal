# 模式切换界面优化 (2026-08-21)

## 问题描述

用户报告了三个与模式切换相关的UI问题：

1. **模式过多** - 包含了 `auto` 和 `dontAsk` 模式，而官方 Claude Code 只有 4 个模式
2. **模式文字颜色太暗** - 状态栏中的模式名称使用 `dimColor` 导致难以阅读
3. **Shift+Tab 切换模式时弹出 Toast 挤压布局** - Toast 通知会推动输入框向下移动

## 解决方案

### 1. 移除非官方模式

对齐官方 Claude Code，只保留 4 个模式：

- `default` - 执行修改文件或命令前询问
- `acceptEdits` - 自动批准 Read/Edit/Write 工具
- `bypassPermissions` - 自动批准所有工具（危险模式除外）
- `plan` - 仅规划模式，不执行破坏性操作

**修改的文件：**
- `src/tui/store.ts` - 更新 `PERMISSION_MODE_CYCLE` 数组
- `src/commands/mode.ts` - 更新命令描述和模式说明

### 2. 增强模式文字可读性

将状态栏中的模式显示从 `dimColor` 改为彩色加粗，使其更加醒目：

**之前：**
```tsx
<Text dimColor>
  {busy ? "working…" : "? shortcuts · / commands"}
  {" · "}
  <Text color={modeColor(permissionMode)}>{permissionMode}</Text>
  {" · "}
  {tokensIn}↑ {tokensOut}↓ tokens
</Text>
```

**之后：**
```tsx
<Text dimColor>
  {busy ? "working…" : "? shortcuts · / commands"}
  {" · "}
</Text>
<Text color={modeColor(permissionMode)} bold>
  {permissionMode}
</Text>
<Text dimColor>
  {" · "}
  {tokensIn}↑ {tokensOut}↓ tokens
</Text>
```

这样模式名称不再继承 `dimColor`，而是使用其专属颜色（黄色、紫色、红色、蓝色）并加粗显示。

**修改的文件：**
- `src/tui/App.tsx` - `StatusBar` 组件
- `src/tui/FullScreenApp.tsx` - `FsStatusBar` 组件

### 3. 移除模式切换 Toast 通知

完全移除按 Shift+Tab 切换模式时的 Toast 弹窗通知：

**之前：**
```typescript
cyclePermissionMode(): PermissionMode {
  const mode = nextPermissionMode(this.state.permissionMode);
  this.set({ permissionMode: mode });
  this.showToast(`Permission mode: ${mode}`);  // ← 移除这行
  return mode;
}
```

**之后：**
```typescript
cyclePermissionMode(): PermissionMode {
  const mode = nextPermissionMode(this.state.permissionMode);
  this.set({ permissionMode: mode });
  // Toast removed - mode is visible in the status bar
  return mode;
}
```

现在切换模式时：
- ✅ 不再显示 Toast 弹窗
- ✅ 不会挤压输入框布局
- ✅ 模式变化直接在状态栏中实时更新（彩色加粗，非常醒目）

**修改的文件：**
- `src/tui/store.ts` - `cyclePermissionMode()` 方法

## 模式颜色映射

```typescript
modeColors: {
  default: "#e0af68",           // 黄/金色 - 中性
  acceptEdits: "#bb9af7",       // 紫色 - 编辑宽容
  bypassPermissions: "#f7768e", // 红色 - 最宽容
  plan: "#7aa2f7",              // 蓝色 - 只读规划
}
```

## 验证

- ✅ 构建成功（无 TypeScript 错误）
- ✅ 模式循环仅包含 4 个官方模式
- ✅ 状态栏模式文字清晰可见（彩色加粗）
- ✅ 两种布局模式（默认和全屏）均已更新
- ✅ 按 Shift+Tab 切换模式时无弹窗，不挤压布局

## 影响范围

- 用户体验：模式切换更流畅，无弹窗干扰，模式状态在状态栏清晰可见
- 兼容性：与官方 Claude Code 模式完全对齐
- 破坏性变更：移除了 `auto` 和 `dontAsk` 模式（如果有用户配置使用这些模式，会回退到 `default`）

## 用户反馈

用户明确表示不想要模式切换后的弹窗，因为：
1. Toast 会推动输入框向下，造成布局跳动
2. 状态栏已经实时显示模式，弹窗是多余的
3. 影响输入流畅度

解决方案完美匹配用户需求。
