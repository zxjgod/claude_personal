# 更新日志 — /context 使用量网格与分类清单

> 日期：2026-09-30
> 类型：feature / fix
> 模块：commands / CLI
> 状态：已落地，待提交

## 用户需求

输入 `/context` 后，按参考截图显示 Context Usage：左侧彩色占用网格，右侧模型、容量与分类统计，下方显示 Memory files 和按来源分组的 Skills。

## 改动

- `src/commands/context.ts`：使用 20×10 字符网格；终端较窄时改为上下布局。按 System prompt、System tools、Memory files、Skills、Messages、Free space 六类显示估算 token 与百分比。
- 总量包含系统提示、启用工具的 API 定义和对话。修复旧实现从纯对话 token 中扣除系统提示的计数错误；注入对话的 system reminders 仍计入 Messages。
- Memory files 只列入实际已加载到系统提示的项目 `CLAUDE.md`；不会重新读取磁盘并误报尚未生效的内容。CLI 为命令提供当前提示与已加载文件快照，支持切换工作目录、输出风格和会话目标后的重新统计。
- Skills 分为 User（磁盘来源，包含项目技能）、Built-in、MCP。每项展示发现元数据的估算开销，不加载技能正文；只有目录确实包含在提示中时才计入上方 Skills 占用，避免虚构上下文开销。
- 容量优先采用 `CommandContext.contextWindow` 或模型 `options.contextWindow`，其次解析模型名 `[1m]` / `[128k]` 后缀，再复用项目已有模型容量表。未知模型明确提示采用估算的 200k 容量；不会将 150k 自动压缩阈值当作模型容量。
- 默认显示使用量、内存和技能清单；`/context --details` 显示估算说明、总量与自动压缩余量。未知容量和容量超限警告仍在默认界面保留。网格对非零类别至少显示一个格子，极小开销会有视觉取整；统计数字才是实际估算。

## 截图细节对齐（同日追加）

- 类别颜色只用于 `⛁` / `⛶` 图标与网格，不再把 Memory files、Skills、Messages 整行染成橙/黄/紫。文字使用主题的正文色 `palette.text`，数值、模型信息与分组标题使用 `palette.secondary`；System prompt 与 System tools 的图标统一为次要灰色。
- 网格、内存与技能标题统一左缩进，恢复网格后的空行、Memory files 与 Skills 之间的空行，以及来源分组前的空行。
- `src/tui/App.tsx` 的日志行包裹 `minHeight={1}`，避免 Ink 把空字符串 Text 渲染成零高度。这是截图中输出挤在一起的实际原因；控制台捕获与 store 没有删除空行。
- 额外统计移至 `--details`，默认布局更接近参考截图。只修改输出展示，不更改实际 token 估算或模型容量。

## 验证

- 新增 `src/__tests__/context-command.test.ts`，覆盖布局、系统提示与对话独立计数、system reminders、已加载内存、技能懒加载、工具启用状态、容量覆盖、窄终端、超限和压缩提示。
- `tsc --noEmit` 通过；修改的命令、类型及新增测试通过 Biome 检查。
- `context-command`、`commands`、`system-prompt`、`session-stats`、`skills` 共 5 个测试文件、107 项测试通过。
- `npm run build` 成功；通过构建后的命令模块打印预览，确认左右布局与分类清单。
- 细节对齐新增 ANSI 分段颜色、标题缩进与留白、`--details` 和 Ink 日志空行回归测试；相关命令与 TUI 测试 111 项通过。

## 使用与边界

## 同步远程主分支

- 提交时同步远程 6 个提交，保留 `model-metadata` 统一容量表及已知模型 `window × 0.85` 的自动压缩阈值（未知模型仍采用 150k），不退回固定阈值。
- 保留 Anthropic `count_tokens` API 校准总量；成功时按本地分类估算比例分配总量，并标明分类仍为估算；不可用时使用本地估算。
- 新增计数 API 校准与动态阈值回归，适配远程 App 移除 `expandedId` 属性的接口变更。同步后相关 7 个测试文件、172 项测试通过。

在项目目录运行 `npm run build`，重启 `ccr` / `npm start` 后输入 `/context`。显示的是当前会话的真实项目数据，而不是参考截图中的模型名、技能或固定数值。模型容量表沿用项目既有配置；非标准模型可通过 `options.contextWindow` 覆盖。Anthropic 总量在 API 可用时校准，其他情况下为本地估算；分类开销始终为估算。
