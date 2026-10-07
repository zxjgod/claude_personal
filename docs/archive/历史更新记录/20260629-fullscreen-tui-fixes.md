# 更新日志 — 全屏 TUI 实测修复（光标漂移/输入框/滚动）+ 模块解耦

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-06-29
> 类型：fix
> 模块：`tui/FullScreenApp`、`tui/App`、`tui/InputBox`、`tui/ScrollView`
> 主题：M25.2 全屏路径用户实测三类问题（光标到下一行、输入框变色/缩小、无法上拉回看）的根因修复，并把全屏抽成独立模块与默认路径解耦。
> 状态：已落地（默认路径零回归；全屏交互细节仍待真机继续打磨）
> 验证：`tsc --noEmit` 0 错、`biome check` 干净、`vitest run --dir src` **683/683**、`npm run smoke` PASSED
> 关联 commit：M25 初版 `7db7a98` 之后的工作树改动
> 关联文档：[`archive/20260629-M25计划表-全屏TUI.md`](../20260629-M25计划表-全屏TUI.md)、[`archive/历史更新记录/20260626-terminal-ui-fix.md`](20260626-terminal-ui-fix.md)（alt-screen 历史回退）

---

## 一、现象 / 用户反馈

`npm start -- --fullscreen` 真机实测，三类问题：

1. **输入框变色 + 缩小**：正常态输入框是橙色，AI 输出时变白（灰）且宽度变窄。
2. **光标跑到下一行闪烁**：终端真实光标不在 `>` 提示行，而在它下一行（token/状态栏行）闪。
3. **无法上拉回看**：AI 输出后只能看最底部刚好一屏的文字，PgUp 翻不动历史。

> 教训：前两轮是「头痛医头」——用户报一点改一点、且**没有真正把全屏跑起来抓帧**，只凭猜。本轮先用注入假 TTY 的驱动脚本 + ink-testing `lastFrame()` 抓到真实布局，再定位。

---

## 二、根因

| # | 缺陷 | 位置 | 后果 |
|---|------|------|------|
| 1 | `busy` 时 InputBox `disabled` → rule 变 `gray`；上轮误加的 `width={ruleWidth()}` 与 flex 冲突 | `InputBox.tsx` | 变白 + 缩小 |
| 2 | **InputBox 不是最后渲染元素**：其下有 StatusBar，且 InputBox 自带「下分隔线」在 prompt 之下 | `App.tsx` 全屏布局 | 终端真实光标停在最后渲染行 = prompt 下方 → 光标"到下一行" |
| 3 | 全屏用 `height={rows}` 固定布局 + 写死 `CHROME_ROWS`；命令面板/多行输入行数可变 → 溢出 | `App.tsx`、`ScrollView.tsx` | 布局崩、输入框被挤 |
| 4 | PgUp 在用户终端未发 `key.pageUp`；滚动键绑定单一 | `App.tsx` 滚动 handler | 翻不动历史 |
| 5 | sticky 用 ref（不触发重渲）；滚动后 UI 不即时反映 | `App.tsx` | 滚动状态不更新 |

**机制（光标漂移，最硬的一条）：** 终端把真实光标停在**最后一次渲染输出的末尾行**。全屏布局里 InputBox 之后还有 StatusBar，且 InputBox 的下分隔线又在 prompt 行之下——光标自然落到 prompt 下方。这是「光标到下一行闪烁」的精确根因，只有把 prompt 做成最后一行才能根治。

---

## 三、改动明细

### `tui/InputBox.tsx`

- 加 `keepColorWhenDisabled`（全屏传）：busy 时保持橙色不变灰；光标仍隐藏。
- 加 `hideBottomRule`（全屏传）：**去掉下分隔线**，让 prompt 行成为最后渲染行；命令面板候选改为在 prompt **上方**展开，保证 prompt 恒为最后一行。
- 撤掉上轮误加的外层 `width={ruleWidth()}`（与 flex 冲突，是"缩小"主因），恢复自然全宽。
- 两个 prop 都默认关，**默认路径行为字节级不变**。

### `tui/ScrollView.tsx`

- 从「固定 `height` prop」改为 **flex `flexGrow={1}` + `measureElement` 自测高度**，回传 `onHeight`。命令面板展开时 flex 自动重排、ScrollView 收缩，输入框始终贴底、光标不错位。
- Text 加 `wrap="truncate-end"` 防超宽折行顶乱布局；带防 setState 循环守卫与 `fallbackHeight`（ink-testing measureElement 返回 0）。

### `tui/App.tsx`（布局顺序修正 + 解耦）

- 全屏布局：StatusBar 移到 InputBox **之前**，InputBox 成为最后元素；滚动键扩展为 PgUp/PgDn + less 风格 **Ctrl+U/D（半屏）/ Ctrl+B/F（整屏）/ G·Ctrl+End（回底）**；sticky 改 state 驱动 UI；滚动时显示 `↑ scrolled` 提示替换状态行。
- **解耦**：把整段全屏逻辑抽到新模块 `FullScreenApp.tsx`；App.tsx 仅留 1 行 import + `if (fullscreen) return <FullScreenApp/>` 分支；`InteractionRegion` 回退原样、移除全屏专用 import。

### `tui/FullScreenApp.tsx`（新）

完全自包含：只依赖叶子组件（ScrollView/InputBox/StatusLine/Picker/Prompt）与 store，**不 import App.tsx**，自己内联状态行/状态栏/overlay 分发。改本文件不可能影响默认启动路径。

### `commands/keybindings.ts`

补全屏滚动键说明（PgUp/PgDn、Ctrl+U/D、Ctrl+End/G）。

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错 |
| `biome check` | 干净 |
| `vitest run --dir src` | **683/683**（scroll-view 新增"prompt 必须最后一行"+全屏 Ctrl+U/D 滚动集成回归） |
| `npm run smoke` | PASSED |
| 抓帧验证（假 TTY + lastFrame） | `> ` 是最后一行；命令面板在 prompt 上方；measureElement 真实 render 返回 19/30 |
| 默认启动（无 flag，管道） | 退出码 0、**无 alt-screen 序列**、横幅正常 → 零回归 |
| 解耦边界（grep） | App.tsx 仅引用 `FullScreenApp`；FullScreenApp 不引用 App.tsx |

---

## 五、受影响文件

**新增**
- `src/tui/FullScreenApp.tsx`（全屏独立模块，与默认路径解耦）

**修改**
- `src/tui/App.tsx`（删内嵌全屏块、回退 InteractionRegion、改为委托）
- `src/tui/InputBox.tsx`（`keepColorWhenDisabled` / `hideBottomRule`，撤固定 width）
- `src/tui/ScrollView.tsx`（flex + measureElement 自测高度）
- `src/commands/keybindings.ts`（全屏滚动键说明）
- `src/__tests__/scroll-view.test.tsx`（prompt-last + 滚动集成回归）

---

## 六、设计决策记录

1. **prompt 必须是最后渲染行** —— 终端真实光标跟随渲染末尾；这是光标漂移的物理根因，靠去掉下分隔线 + StatusBar 上移根治，而非调颜色/宽度（上两轮的错误方向）。
2. **flex + 实测高度，不用固定 `height={rows}` 强撑** —— 底部 chrome 行数可变（命令面板 8 行），固定高度必溢出，正是 06-26 alt-screen 回退踩的同一坑。
3. **全屏独立成模块、默认路径零依赖** —— 用户明确要求解耦、不影响正常启动；App.tsx 只保留一个委托分支，改全屏不触碰默认路径。
4. **滚动键多绑 + less 风格兜底** —— PgUp 在部分终端不发 `key.pageUp`，Ctrl+U/D/B/F 几乎所有终端可靠。
5. **全屏滚动区丢色换精确窗口化** —— 默认路径保留全色；这是 opt-in 路径的权衡。

> 注：全屏仍是 opt-in（`--fullscreen` / `CCR_FULLSCREEN=1`），默认关。用户表示交互细节"暂时不太满意但可接受"，后续可在独立模块内继续打磨，不影响主线。
