# 2026-08-28 TUI 状态显示与交互升级（StatusBar v2 / ctrl+r / Esc 中断 / @ 补全 / usePaste / P3 打磨）

TUI 审查后分三批落地的升级:P0+P1-6(正确性修复 + 状态栏 v2),P1-7/8+P2(工具卡计时、排队徽标、Esc 中断、@ 文件补全、粘贴通道、输入框键位),P3(i18n 统一、列宽感知截断、翻页器上色)。

## P0 正确性修复

- **ctrl+r 工具卡展开兑现**：此前 `(ctrl+r to expand)` 提示是死文案(`expandedId` 恒 null)。Ink `<Static>` 只写一次,已打印的折叠卡无法原地重渲 —— 改为 `store.expandTool(id)` 向下**追加展开副本**(幂等,`expandedOf` 去重),`run.tsx` 的 `ExpandHotkey` 触发;`ToolCard.tsx` 导出 `isToolExpandable` 统一判定。行式 CLI 无按键回路,删除其提示。
- **Shift+Tab 双触发**:`InputBox` 补全接受补 `!key.shift`(与 `chat:cycleMode` 不再同时触发)。
- **全屏 ↑↓/Ctrl+U 冲突**:FullScreenApp 滚动键收敛为 PgUp/PgDn · Ctrl+B/F · Ctrl+End/G,↑↓(历史/多行光标)与 Ctrl+U(删行首)还给输入框。
- **死提示清理**:删 "← agents"、"鼠标滚轮";HelpPanel 快捷键表重写为全部有真实处理器的键。
- **reduced-motion 贯通**:`spinner-core.isReducedMotion()` 单一来源,StatusLine(静态 glyph+去微光,时钟降频保留)、ToolCard(静态灰点)、cli-spinner 统一遵守。

## P1-6 StatusBar v2(共享 `StatusBar.tsx`)

```
deepseek/chat · accept edits · ↑20k ↓3.1k tokens · ctx ██████░░ 28% · $0.0088 · queued 2
```

- usage 事件的 `cache_read/cache_creation` 透传进 store;`estimateContextUsed` 按提供商口径换算(Anthropic 三项求和 / OpenAI 不重复计 cache)。
- ctx 水位条:绿 <75% → 黄 ≥75%(对齐 agent-loop 150k/200k 压缩触发比)→ 红 ≥90%;跨阈值一次性 toast。
- `session-stats.lookupContextWindow` 模型窗口表;`/provider` 切换时 `setModel` + `setContextLimit` 同步。
- 窄终端逐段降级(丢 cost → 水位条缩百分数 → 丢 model),`visualWidth` 实测宽度,永不换行。
- 权限模式友好标签(`bypassPermissions` → `bypass`,theme.ts `modeLabel`)。

## P1-7/8

- **活动工具卡计时**:`ActiveTool.startedAt`,`ActiveToolCard` 渲染 `(12s)`;单 interval 同驱闪烁与秒数,reduced-motion 下计时不冻结(信息非装饰)。
- **排队徽标**:`store.queuedInputs` 镜像 InputQueue(push/drain/丢弃三处同步),StatusBar busy 时显示 `queued N`。

## P2

- **Esc 中断当前回合**:`InterruptHotkey` 支持 Esc(vim 模式让位给 normal 切换;overlay/翻页器拥有键盘时让位);busy 提示改 `(Esc/Ctrl+C interrupt)`。
- **@ 文件补全**:新模块 `file-completions.ts`(fast-glob + 3s TTL 缓存 + 忽略 node_modules 等 + 8 条上限),InputBox 检测光标处 `@word` 复用下拉 UI,Tab 替换插入、↑↓ 导航、Esc 关闭;经 App/FullScreenApp 透传,`/cd` 后按新根目录匹配;提交侧 `expandFileRefs` 原样复用。
- **粘贴通道**:Ink `usePaste`(bracketed paste 自动开关),`\r\n→\n` 归一,>5 行显示"已粘贴 N 行"一次性提示(下一键消失)。
- **InputBox 键位**:Esc 关闭 "/" 下拉(查询变化后重开);Ctrl+←/→ 词跳转;ctrl+r 改走 keybindings resolver(`DEFAULT_BINDINGS` 增 `tool:expandLast`,可重映射/解绑)。
- **输入状态 ref 同步修复**:`setBuffer/setCursor` 改为在 React updater 外同步写 ref —— 同一 stdin 块携带多个按键时(按键连发),第二个按键不再读到旧 buffer/cursor(此前两次 Ctrl+← 会从同一原点起跳)。

## P3 打磨

- **P3-13 i18n 统一**:`t()` 改读 `currentLanguage` 单例(修复 `setLanguage` 从不生效的隐患);新增 ~30 个 UI 键(en/zh-CN)。权限菜单(Ink `Prompts.tsx` 与行式 `cli-interactive.ts`/`cli-renderer.ts` 同键)、状态栏 busy/idle 提示、省略提示、粘贴提示、@ 下拉提示、ctx 阈值 toast、全屏"查看历史"提示全部走 `t()`,语言跟随 `CCR_LANGUAGE`/`LANG`(zh 环境自动中文,默认英文)。断言文案的测试显式 `setLanguage("en")` 钉住。
- **P3-15 列宽感知截断**:`terminal-width.ts` 新增 `truncateVisual`(按显示列截断,不劈宽字形/代理对,结果永不超预算);`cli-interactive`/`cli-renderer`/`spinner-core.clip`/`ToolCard`/`run.tsx` 的 5 处 `.length` 截断全部替换——中文路径/命令不再截错列。行式 CLI spinner 的动词改为 `verbAt(elapsed, startedAt)` 时间轮换,与 Ink StatusLine 一致。
- **P3-16 翻页器/全屏上色**:`transcriptToLines` 返回 `TranscriptLine[]`(text + color/dim):用户蓝、工具头橙、工具体/通知/思考暗色、错误红;`ScrollView` 接受 `string | TranscriptLine` 行(向后兼容),窗口化数学不变。

## 验证

| 项 | 结果 |
| --- | --- |
| `tsc --noEmit` | 0 错误 |
| `biome check` | 改动文件干净(存量 warning 在未触碰文件) |
| `vitest run` | **1347/1347**(新增 file-completions 6、interrupt-hotkey 6、input-box 新块 12、status-bar queued、keybindings ctrl+r、i18n UI 键 + setLanguage 生效回归、terminal-width truncateVisual 9、scroll-view 角色上色 2) |
| `npm run smoke` | PASSED |

## 文件

| 文件 | 变更 |
| --- | --- |
| `tui/StatusBar.tsx` | 新增:共享状态栏(v2) |
| `tui/file-completions.ts` | 新增:@ 路径补全源 |
| `tui/store.ts` | startedAt/queuedInputs/cache/context 字段、expandTool、setModel、阈值 toast |
| `tui/InputBox.tsx` | @ 下拉、usePaste、Esc 关闭、Ctrl 词跳转、ref 同步修复 |
| `tui/run.tsx` | ExpandHotkey(resolver)、InterruptHotkey(Esc)、queue 镜像、usage cache 接线 |
| `tui/ToolCard.tsx` | 活动卡计时、isToolExpandable、reduced-motion |
| `tui/FullScreenApp.tsx` / `App.tsx` | 滚动键收敛、共享 StatusBar、completeFiles 透传、i18n 提示 |
| `tui/i18n.ts` | t() 单例修复 + UI 键表(en/zh-CN) |
| `tui/transcript-lines.ts` / `ScrollView.tsx` | 带色行 + 兼容渲染 |
| `tui/terminal-width.ts` | truncateVisual |
| `tui/session-stats.ts` / `theme.ts` / `keybindings/defaults.ts` | 窗口表 / modeLabel / ctrl+r 默认绑定 |
