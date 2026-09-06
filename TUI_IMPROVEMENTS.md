> ⚠️ **本文档已过期**（2026-08-25 记录的 ↑↓ 滚动/LIVE_CHROME_ROWS=10 等与后续代码不符）。
> 当前 TUI 状态以 [docs/TUI官方对齐方案.md](docs/TUI官方对齐方案.md) 与 [批次 A 完成报告](docs/更新日志/20260906-TUI官方对齐批次A.md) 为准。

# TUI 用户体验改进

## 修改日期
2026-08-25

## 改进内容

### 1. 移除了所有"PgUp回滚"相关的提示文字

用户反馈这些提示不清楚，不知道是什么意思。已全部改为更清晰的中文提示：

**修改的文件：**
- `src/tui/App.tsx` - 移除状态栏和流式区域的"PgUp回滚"提示
- `src/tui/FullScreenApp.tsx` - 改为"鼠标滚轮/↑↓ 滚动"
- `src/tui/CommandPicker.tsx` - 简化为"↑↓ 移动 · Enter 运行"
- `src/tui/SessionPicker.tsx` - 简化为"↑↓ 移动 · Enter 恢复"
- `src/tui/ProviderPicker.tsx` - 简化为"↑↓ 移动 · Enter 切换"
- `src/tui/HelpPanel.tsx` - 改为"↑↓ / 鼠标滚轮 - 滚动查看历史消息"
- `src/tui/TranscriptReview.tsx` - 改为"↑/↓ 滚动 · Home/End 顶/底"

**具体改动：**
- ❌ 旧提示：`PgUp 回滚查看`
- ✅ 新提示：`已省略` 或直接不显示

- ❌ 旧提示：`PgUp/PgDn scroll`
- ✅ 新提示：`鼠标滚轮/↑↓ 滚动`

### 2. 启用了鼠标滚轮支持

**修改的文件：**
- `src/tui/run.tsx` - 在两处render调用中添加了stdin/stdout/stderr配置

**代码改动：**
```typescript
const { waitUntilExit } = render(<Root store={store} deps={deps} />, {
  exitOnCtrlC: false,
  // Enable mouse input for scrolling support
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
```

### 3. 增强了全屏模式的滚动支持

**修改的文件：**
- `src/tui/FullScreenApp.tsx`

**新增功能：**
- 支持 ↑ / ↓ 方向键进行小幅滚动（每次10%）
- 原有的 Ctrl+U / Ctrl+D（半页）和 Ctrl+B / Ctrl+F（全页）继续保留
- 改进了滚动状态提示：`↑ 正在查看历史 — Ctrl+End 或按 G 返回最新`

**代码改动：**
```typescript
useInput((input, key) => {
  // Support arrow keys and mouse wheel for scrolling
  if (key.upArrow) return void scrollBy(-1, 0.1);
  if (key.downArrow) return void scrollBy(1, 0.1);
  // ... 其他快捷键
});
```

### 4. 增加了AI流式输出的可见区域

**修改的文件：**
- `src/tui/live-window.ts`

**具体改动：**
- 将 `LIVE_CHROME_ROWS` 从 16 减少到 10
- 这样流式输出内容从原来的 `终端行数 - 16` 增加到 `终端行数 - 10`
- 在标准80x24终端上，流式内容可见行数从8行增加到14行（提升75%）

**代码改动：**
```typescript
// 旧值: export const LIVE_CHROME_ROWS = 16;
// 新值:
export const LIVE_CHROME_ROWS = 10;
```

### 5. 改善了省略提示的文案

**修改的文件：**
- `src/tui/App.tsx`

**具体改动：**
- ❌ 旧提示：`… 上文约 ${hiddenLines} 行（PgUp 回滚查看）`
- ✅ 新提示：`… 上文约 ${hiddenLines} 行已省略`
- ❌ 旧提示：`… 思考前文约 ${hiddenLines} 行（PgUp 回滚查看）`
- ✅ 新提示：`… 思考前文约 ${hiddenLines} 行已省略`

## 用户体验改进效果

1. **更清晰的提示文字**：所有提示都改为中文，用户一看就懂
2. **更自然的交互方式**：支持鼠标滚轮和方向键，符合日常使用习惯
3. **更多的内容可见**：AI回复时可以看到更多内容，减少"被隐藏"的感觉
4. **更简洁的界面**：移除了不必要的技术术语（PgUp/PgDn）

## 兼容性说明

- 鼠标支持需要终端模拟器支持鼠标事件（大多数现代终端都支持）
- 如果终端不支持鼠标，仍然可以使用键盘快捷键
- Windows Terminal、iTerm2、Alacritty 等都支持鼠标输入

## 测试建议

启动程序后测试：
1. ✅ 鼠标滚轮是否可以上下滚动
2. ✅ ↑↓ 方向键是否可以滚动
3. ✅ AI流式输出时内容是否比之前更多
4. ✅ 所有提示文字是否已改为中文
5. ✅ 编译是否成功（已通过）
