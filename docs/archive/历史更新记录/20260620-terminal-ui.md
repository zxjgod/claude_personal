# 更新日志 — 终端界面对齐 Claude Code

**日期**：2026-06-20
**主题**：把 CLI 终端体验做到 Claude Code 工具级别
**测试**：196 / 196 全过（原 175 + 新增 21）

---

## 一、背景与动机

对照 `claude code终端操作界面/` 里 8 张真实 Claude Code 截图，旧版 CLI（`node:readline`
逐行输入 + `chalk` 直接 `console.log`）有四处明显落差，且 `log.txt` 真实运行记录暴露了
最刺眼的问题：

1. **AI 输出格式脏** —— assistant 文本里的 `**bold**`、`##` 标题、markdown 表格原样
   泄漏到终端（`log.txt` 第 273–364 行可见 `## 📊`、`**~35-40 / 100**`、`| 指标 | 数值 |`
   全是生文本）。
2. **没有输入框** —— 只有裸 `> ` 提示符；截图里是带边框输入框，打 `/` 弹指令补全下拉。
3. **没有思考动画** —— 截图里有 `✶ Whisking… (16s · ↑ 144 tokens)` 会颜色流动、显示
   秒数和 token 数的动画行，以及 `Thought for 10s`。旧版完全没有。
4. **工具/权限显示不符** —— 截图用 `●`/`⎿` 符号、`Bash(cmd)` 样式、长输出折叠；权限是
   带框选择菜单。旧版是 `🔧`/`✅`/`⚠️` emoji 行，且并发工具调用时权限提示会和输出交错。

**目标**：严格参考截图的符号、表格画法、配色，做出输入框 + `/` 自动补全、带颜色流动的
思考动画（计时 + token），并彻底修掉 markdown 生文本泄漏。

**三项关键取舍**（已与用户确认，均选推荐方案）：
- 输入/补全：**自研 raw-mode 渲染**（不引入 Ink/React，避免依赖与改动爆炸）
- 思考动画：**完整复刻** shimmer 流动 + 计时 + token
- Markdown：**引入 `marked`** 做完整词法分析渲染（手写正则留不住 `**`/表格）

---

## 二、参考实现来源

所有视觉与算法均比对真实 Claude Code 反编译源码（`claude test/src/src/`）：

| 能力 | 参考文件 | 取用内容 |
|---|---|---|
| 思考动词表 | `constants/spinnerVerbs.ts` | ~190 个 gerund，精选 51 个 |
| 旋转字符 | `components/Spinner/utils.ts` | win32 帧 `['·','✢','*','✶','✻','✽']` |
| 配色 | `utils/theme.ts` | `claude: rgb(215,119,87)`、`claudeShimmer: rgb(245,149,117)` |
| 状态行 | `Spinner/SpinnerAnimationRow.tsx` | `thinking`/`thought for Ns`、`↓N tokens`、宽度自适应 |
| shimmer 算法 | `bridge/bridgeStatusUtil.ts` | `computeGlimmerIndex`、`computeShimmerSegments`、`SHIMMER_INTERVAL_MS=150` |
| 符号 | `constants/figures.ts` | `●`（win32 BLACK_CIRCLE）、`✻`、`↑` |
| 表格 | `components/MarkdownTable.tsx` | 盒绘制、列宽分配、窄屏转竖排 |
| token 渲染 | `utils/markdown.ts` | `formatToken`：strong→bold、codespan→上色、list→`-`/`N.` |

---

## 三、改动明细

### 新增文件

#### `src/terminal-width.ts`
视觉宽度计算工具，替代 `string-width` / `strip-ansi`（**零新依赖**）：
- `visualWidth()` —— ANSI-aware，CJK/全角/大部分 emoji 记 2 列，组合符/零宽记 0 列，
  用 `Intl.Segmenter` 做字素聚类（emoji + ZWJ 算一个单元）。
- `stripAnsi()`、`graphemes()`（带宽度的字素迭代器）、`padAligned()`（左/中/右对齐填充）、
  `terminalColumns()`（带 80 列兜底）。
- 表格列宽对齐、spinner 行宽裁剪都依赖它。

#### `src/cli-spinner.ts`
思考动画引擎，`SpinnerAnimationRow` 的无 React 纯字符串版：
- 常量：51 个 gerund 动词表（含 Whisking/Pondering/Simmering）、win32 旋转帧来回播放、
  `CLAUDE_ORANGE`/`CLAUDE_SHIMMER` RGB。
- 移植 shimmer 三段算法（`computeGlimmerIndex`/`computeShimmerSegments`），动词做
  before/after 暗橙 + shimmer 亮橙的扫光染色。
- `class Spinner`：`start()`（每帧 80ms，每轮换新动词）、`update({tokens})`（单调递增）、
  `setMode()`、`stop()`；用 `\r\x1b[K` 原地擦除重绘，**绝不追加换行**。
- 拼 `✶ Whisking… (Ns · ↑ N tokens)`，行宽不够时丢弃后缀。
- 非 TTY / `CCR_REDUCED_MOTION=1` 自动降级为静态，`start()` 在非 TTY 直接 no-op。
- `formatDuration`（`16s`/`2m 5s`）、`formatTokens`（`144`/`1.2k`/`15k`）。

#### `src/markdown.ts`
基于 `marked` 词法分析的渲染器：
- `renderMarkdown(content)` —— `marked.lexer()` 取 token，移植 `formatToken` 子集：
  `strong`→`chalk.bold`（**消掉 `**`**）、`em`→italic、`codespan`→青色、`heading`→bold cyan、
  `list`/`list_item`→`-`/`N.` 前缀、`blockquote`→`▎`、`code`→灰块、`link`→青色。
- `renderTable(token)` —— 移植 `MarkdownTable.tsx`：`┌┬┐├┼┤└┴┘│─` 盒绘制，列宽按
  min/ideal/按比例缩三档分配，表头居中加粗青、单元格按 `align` 对齐、多行单元格垂直居中；
  窄屏自动转竖排 key-value 格式。宽度全用 `visualWidth`，CJK 表格列也能对齐。

#### `src/cli-interactive.ts`
raw-mode 交互层（仅 TTY 启用）：
- `createRawInputReader()` —— 逐键解析（方向键/Enter/Backspace/Tab/Ctrl+C/Ctrl+D/ESC/
  可打印字符），`Region` 类做 ANSI 光标原地重绘。
- 带边框输入框（上/下 `─` + `> ` 提示符），打 `/` 弹补全下拉：列出 `COMMANDS` 名称 +
  描述（选中橙色、其余青/灰），前缀过滤，↑↓ 选择、**Tab 补全、Enter 永远提交**、Esc 关下拉。
- `promptPermissionMenu()` —— 带框 `1.Yes / 2.always / 3.No` 可选菜单，↑↓ 选 + Enter 确认、
  数字键直选、Esc/Ctrl+C 视为拒绝；底部 `Esc to cancel · ↑↓ to choose · Enter to confirm`。

### 改动文件

#### `src/cli-renderer.ts`（重写渲染逻辑）
- `StreamingRenderer` 改为**块缓冲**：流式累积，在空行/代码围栏闭合的块边界才把整块交给
  `renderMarkdown`，所以 `**`/`##`/表格不再泄漏。助手正文每段加 `●`（橙色）前缀。
- `renderToolStart` —— `● Bash(cmd)` / `● Read(path)` 形式，去掉 `🔧` emoji。
- `renderToolResult` —— `⎿` 续行符缩进，长输出折叠成 `… +N lines (ctrl+o to expand)`，
  错误用红色 `⎿`。
- `renderPermissionPrompt` —— 带框文本提示（非 TTY 回退用）。
- 新增 `renderWelcome()` —— 橙色边框欢迎框（标题 + Welcome back! + 模型/工作区 + Tips）。
- 子代理失败行也带工具名，便于定位。

#### `src/cli.ts`（接线）
- TTY/非 TTY 双路径：`isInteractive` 为真用 `createRawInputReader`（输入框 + 补全 + 菜单），
  否则回退原 `createCliInputReader`（管道/CI 行模式）。
- 权限回调：TTY 走 `promptPermissionMenu`，并用 `askUserGuarded` 在弹菜单前 `stop()` spinner、
  确认后恢复 —— 修掉权限与输出交错。
- 事件循环接 spinner 生命周期：`thinking`→start；首个 `text_delta`→打印 `Thought for Ns` 后转
  responding；`tool_use`→stop 后画工具行再重启；`usage`/`text_delta`→`update({tokens})`；
  `done`/`aborted`/`error`→stop。
- 开场画橙框欢迎屏（仅 TTY 且非 quiet）。
- 清理：`rl` 可空，cleanup 改 `closeInput()`。

#### `package.json`
新增 `marked: ^12.0.0`。

---

## 四、测试

| 文件 | 内容 |
|---|---|
| `__tests__/cli-renderer.test.ts`（重写） | 块渲染、`**`/`##` 不泄漏、表格盒线、`●`/`⎿`、折叠文案、带框权限提示 |
| `__tests__/cli-spinner.test.ts`（新增） | 动词表（全 `-ing`）、`formatDuration`/`formatTokens`、shimmer 三段切分可重组、非 TTY no-op、token 单调 |
| `__tests__/cli-interactive.test.ts`（新增） | Enter 提交、Tab 补全 `/clear `、下拉前缀过滤、权限菜单 Enter→yes / Esc→no / 数字键→always |
| `__tests__/cli-input.test.ts`（保留） | 非 TTY 管道/EOF/多行用例继续全过 |

---

## 五、验证结果

- `npm run build` 通过，`npm test` **196 / 196 全过**。
- **markdown 实测**：`## 标题`→加粗青、`**~35-40 / 100**`→加粗（无 `**`）、`` `6/6` ``→青色、
  表格画出 `┌┬┐├┼┤└┴┘│─` 盒线且 CJK 列对齐、`-` 列表项加粗无 `**`。
- **spinner 实测**：`* Schlepping… (1s · ↑ 144 tokens)`，橙色旋转字符、动词扫光、计时递增、
  token 增长、`\r\x1b[K` 原地重绘不刷屏。
- **欢迎屏实测**：橙色边框框，标题/模型/工作区/Tips 对齐。
- **管道兼容**：`printf '/help\nexit\n' | node dist/cli.js` 仍走行模式、无 raw-mode 转义泄漏。

---

## 六、设计决策记录

1. **不引入 Ink/React** —— 真实 CC 用 React/Ink TUI，但对本项目是巨大依赖与改动。改为
   raw-mode + ANSI 转义自绘，视觉等价、零 UI 框架依赖。
2. **Enter 永远提交、Tab 才补全** —— 与真实 Claude Code 一致。修掉了「buffer 恰好等于
   命令名时 Enter 反复补全无法提交」的死循环。
3. **块缓冲而非逐行渲染** —— markdown 的 `**`/表格跨行，必须拿到完整块才能正确解析。
   接受「块内流式纯文 → 块尾整体重排」的取舍（终端 scrollback 不可回改，与真实 CC 行内
   流式同理）。
4. **自写 `visualWidth` 而非装 `string-width`** —— 保持极简依赖（项目核心卖点），用
   `Intl.Segmenter` + 全角码点表覆盖 CJK/emoji。
5. **所有原地重绘 TTY-gated** —— 非 TTY（管道/CI）自动退回纯行输出，保证可脚本化。

---

## 七、受影响文件汇总

**新增**
- `src/terminal-width.ts`
- `src/cli-spinner.ts`
- `src/markdown.ts`
- `src/cli-interactive.ts`
- `src/__tests__/cli-spinner.test.ts`
- `src/__tests__/cli-interactive.test.ts`

**修改**
- `src/cli-renderer.ts`（markdown + 表格 + 工具/权限渲染 + 欢迎屏）
- `src/cli.ts`（双路径输入、spinner 生命周期、权限菜单、欢迎屏）
- `src/__tests__/cli-renderer.test.ts`（重写断言）
- `package.json`（加 `marked`）
