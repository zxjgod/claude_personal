# M25 计划表 — 全屏 TUI（alt-screen / ScrollBox 回看 / 多行输入）

> 制定：2026-06-29
> 基线：main `698cc77`，M1–M24 完成，`tsc --noEmit` 0 错、`biome check` 干净、本地 `vitest` **665/665**、`smoke` PASSED。
> 方向：用户选定「承接 M24 的 TUI 路线、贴合『以 claude code 为目标』」——全屏贴底布局 + 应用内滚动回看 + 多行输入。
> 性质：**高风险大改**（alt-screen 历史上回退过两次，见 [终端界面bug修复-20260626.md](./终端界面bug修复-20260626.md)）。故采用**风险分层 + feature flag 隔离**：低风险自包含部分先落地，高风险范式切换单独成阶段、flag 默认关、可随时回退到现有 `<Static>` scrollback 模型。

---

## 一、关键约束（探查已取证）

| # | 约束 | 取证 | 影响 |
|---|---|---|---|
| C1 | **标准 Ink 7 无 ScrollBox** | `node_modules/ink/build/components/` 无 scroll；参考实现用自家 fork 的 `../ink/components/ScrollBox.js` | 全屏滚动视口需**自造**（基于 `measureElement` + `useStdout`），不照搬参考的滚轮物理 |
| C2 | **alt-screen 与 `<Static>` scrollback 范式冲突** | [终端界面bug修复-20260626.md](./终端界面bug修复-20260626.md)：`height={rows}` 全屏布局 + 裸 stdout 横幅互相覆盖，回退 | 两种模型不可混用；全屏路径要**整体替换** transcript 渲染，不能在 `<Static>` 上叠 alt-screen |
| C3 | **多行输入完全自包含** | InputBox 用 `useInput` 自管编辑；换行/行光标不触碰 transcript 渲染范式 | M25.1 低风险，可独立交付、独立验证 |
| C4 | **现有终端原生 scrollback 已能向上翻看** | `<Static>` 把历史打进 scrollback，终端自带滚动 | 全屏路径的**唯一净增价值**是「输入框贴底 + 应用内 PgUp/PgDn 滚动 + 不被新输出推走」；要权衡是否值得范式切换 |

---

## 二、阶段拆分

### M25.1 — 多行输入 + 行间光标（P1，低风险，先做）

> 全在 `InputBox.tsx` 内，不动 App/store 渲染范式。交付后 `/keybindings` 恢复 Ctrl+J 那条。

| # | 任务 | 涉及文件 | 验收 |
|---|---|---|---|
| 25.1.1 | buffer 支持 `\n`：Ctrl+J（及 `\` + Enter）插入换行，Enter 仍提交 | `src/tui/InputBox.tsx` | 多行文本可输入；裸 Enter 提交整段 |
| 25.1.2 | 行内/行间光标：↑/↓ 在多行 buffer 内按逻辑行移动（无命令面板时）；面板打开时 ↑/↓ 仍切换候选 | `src/tui/InputBox.tsx` | 多行时 ↑/↓ 跨行移光标；单行/面板态行为不变 |
| 25.1.3 | 多行渲染：每逻辑行一个 `<Text>`，行光标落在正确行/列；分隔线宽度修正（M24.4）保持 | `src/tui/InputBox.tsx` | 多行框稳定不跳位；CursorText 跨行正确 |
| 25.1.4 | `/keybindings` 恢复 Ctrl+J | `src/commands/keybindings.ts` | 只列真实可用键位（Ctrl+J 现已实现） |
| 25.1.5 | 回归测试 | `src/__tests__/input-box.test.tsx` | Ctrl+J 换行、↑/↓ 行移、Enter 提交多段；既有 5 例不破 |

**验收**：`typecheck` 0 错、`biome` 干净、`vitest` 全绿（+~5 例）、`smoke` PASSED。不引新依赖。

---

### M25.2 — 全屏布局 + 应用内滚动回看（P1，高风险，flag 隔离）

> 自造最小 `ScrollView`（非参考的重型 ScrollBox），用 alt-screen 贴底布局。**`fullscreen` flag 默认关**，默认仍走现有 `<Static>` scrollback 路径（零回归）；开 flag 才进全屏。两条路径并存、可随时切回。

| # | 任务 | 涉及文件 | 验收 |
|---|---|---|---|
| 25.2.0 | flag 接线：`--fullscreen` / 配置项 → `TuiDeps.fullscreen`；App 按 flag 二选一渲染 | `src/cli.ts`、`src/tui/run.tsx`、`src/tui/App.tsx` | flag 关 = 现状；flag 开 = 全屏路径 |
| 25.2.1 | 终端尺寸 hook：`useTerminalSize()`（`useStdout` + `resize` 事件，含 SIGWINCH） | `src/tui/useTerminalSize.ts`（新） | resize 实时拿到 rows/cols |
| 25.2.2 | 自造 `ScrollView`：固定高度视口 + 内部 offset 窗口化渲染 + sticky-bottom（新内容自动贴底，手动滚动后解除 sticky） | `src/tui/ScrollView.tsx`（新） | 内容超高时只渲染窗口；新增内容默认贴底 |
| 25.2.3 | PgUp/PgDn / Ctrl+End 滚动：半屏翻页、回底重新 sticky | `src/tui/ScrollView.tsx`、`src/tui/App.tsx` | 翻页可回看历史；Ctrl+End 跳回底部并 sticky |
| 25.2.4 | 全屏 App：`height={rows}` 列容器 = 横幅/ScrollView（弹性填充）+ 贴底状态行/输入框 | `src/tui/App.tsx`（全屏分支） | 输入框常驻底部，不被流式输出推走 |
| 25.2.5 | alt-screen 生命周期：进入写 `\x1B[?1049h`、退出写 `\x1B[?1049l`，与 Ink 卸载/`process.exit` 路径对齐，**保证退出必复位主屏幕**（含异常/SIGINT） | `src/tui/run.tsx` | 退出后终端回到主屏幕，无残留 alt-screen |
| 25.2.6 | 横幅注入全屏视口首条（复用 M24 经验：横幅是渲染树一部分，非裸 stdout） | `src/tui/run.tsx`、`src/tui/App.tsx` | 全屏下横幅可见、随滚动上移、不被首帧覆盖 |
| 25.2.7 | 回归测试 + 真机冒烟 | `src/__tests__/scroll-view.test.tsx`（新）、`tui-banner.test.ts` | ScrollView 窗口化/sticky/翻页单测；alt-screen 进入/退出顺序锁死；smoke 非 TTY 不回归 |

**验收**：
- flag 关：与 M24 行为字节级一致（默认路径零回归）。
- flag 开：输入框贴底、PgUp/PgDn 可滚动回看、Ctrl+End 回底 sticky、退出复位主屏幕、横幅常驻。
- `typecheck` 0 错、`biome` 干净、`vitest` 全绿、`smoke` PASSED。不引新依赖（Ink7/React19/现有 `terminal-width`）。

---

## 三、明确不做（本轮边界）

- **不照搬参考的滚轮物理**（`ScrollKeybindingHandler` 的 wheel accel / 选区跟随 / OSC52 复制几百行）——超出「轻量本地」定位，PgUp/PgDn + Ctrl+End 足够。
- **不引入鼠标追踪 / 文本选区**（mode 1002/1006）——本轮只做键盘滚动。
- **不改 agent-loop 事件协议**——仅消费已有事件。
- **不删除 `<Static>` scrollback 路径**——它是默认且经过验证的回退路径。

---

## 四、风险与回退

| 风险 | 缓解 |
|---|---|
| alt-screen 第三次踩坑（横幅/布局覆盖、退出不复位） | flag 默认关；25.2.6 复用 M24 已验证的「横幅进渲染树」修法；25.2.5 在所有退出路径（正常/异常/SIGINT/exit）保证写 `EXIT_ALT` |
| 自造 ScrollView 在 CJK/宽字符下行数算错 | 复用现有 `terminal-width` 的视觉列测量；窗口化按渲染行数而非字符数 |
| 范式切换引入回归 | 两路径并存，flag 关 = 现状；CI 全绿门槛 + smoke 守 |

---

## 五、执行顺序

1. **M25.1**（多行输入）先做、独立交付验证 → 提交。
2. **M25.2**（全屏 flag）后做、flag 默认关 → 真机验证 flag 开路径 → 提交。

每阶段收尾跑：`npm run typecheck` + `biome check` + `vitest run --dir src` + `npm run smoke`。

---

## 六、执行进度（2026-06-29）

**M25.1 ✅ 完成**（多行输入 + 行间光标，全在 `InputBox.tsx`）：
- Ctrl+J（及 `\` + Enter）插入换行，裸 Enter 提交整段；buffer 现含 `\n`。
- 新增 `offsetToRowCol` / `rowColToOffset` / `splitLines` 多行光标辅助；↑/↓ 面板关闭时按逻辑行移动光标（面板开仍切候选），Ctrl+A/E / Home/End 改为**行内**首尾。
- 渲染改为每逻辑行一个 `<Box>`：首行带 `> ` 前缀、续行两空格缩进对齐；`CursorText` → `CursorLine`（只在光标所在行画反相光标）。
- `/keybindings` 恢复 Ctrl+J 那条（连同 ↑/↓ 行移说明）。
- 测试：`input-box.test.tsx` +4 例（Ctrl+J 换行不提交、`\`+Enter 换行、多行各占一行、↑ 跨行移光标）。

**M25.2 ✅ 完成**（全屏布局 + 应用内滚动，`--fullscreen` / `CCR_FULLSCREEN=1` 默认关）：
- 新增 `useTerminalSize.ts`（`useStdout` + `resize` 事件，fallback 80×24）。
- 新增 `ScrollView.tsx`：纯窗口化数学（`visibleWindow`/`clampScrollTop`/`bottomScrollTop` 可测）+ 固定高度视口 + 短内容补白。**自造**（标准 Ink 7 无 ScrollBox，不照搬参考的滚轮物理）。
- 新增 `transcript-lines.ts`：`transcriptToLines` 把 transcript + 流式文本拍平成纯文本行（全屏路径用，权衡：丢色换精确窗口化）。
- `App.tsx` 加 `FullScreenApp` 分支：`height={rows}` 列容器 = ScrollView（弹性）+ 贴底 StatusLine/InputBox/StatusBar；PgUp/PgDn 半屏翻页、Ctrl+End 回底重 sticky；sticky-follow（新内容自动贴底，PgUp 解除）。
- `run.tsx`：fullscreen 时写 `\x1B[?1049h`（进 alt-screen）、`finally`/`process.once("exit")`/`SIGTERM` 写 `\x1B[?1049l`（退出必复位，`altRestored` 防双写）；横幅注入渲染树首条（复用 M24 经验，非裸 stdout）。
- `cli.ts`：解析 `--fullscreen` / `CCR_FULLSCREEN=1` → `TuiDeps.fullscreen`。
- 测试：`scroll-view.test.tsx`（+9：窗口化/clamp/sticky 数学 + 渲染窗口 + 补白 + `transcriptToLines`）、`tui-banner.test.ts`（+2：alt-screen 进入/退出/复位源码回归）。

**验收结果**：`tsc --noEmit` 0 错、`biome check` 干净、`vitest run --dir src` **680/680**（665 → 680，+15）、`npm run smoke` PASSED。非 TTY 下 `--fullscreen` 优雅降级（不写 alt-screen、退出码 0）。flag 关 = M24 行为零回归。

**已知限制**：fullscreen 仅在真 TTY 生效（`isInteractive` 门控），无法用管道端到端验证；alt-screen 进入/退出/复位契约由源码回归测试锁住。全屏滚动区为纯文本（丢色），默认路径保留全色。

