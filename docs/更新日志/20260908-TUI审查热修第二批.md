# TUI 审查热修 第二批（2026-09-08）

> 触发：用户从审查报告待办中点名 4 项（队列幽灵行 / 排队 `!`、`#` 不执行 / `/theme` 空操作 / RewindPicker·PlanApproval·vim 三处假功能）。
> 结果：测试 1534 → 1559（新增 25 例：vim 12、queued-dispatch 4、theme 5、rewind/plan 4）；全套 116 文件全绿，tsc 零错误。

## 修复清单

| # | 严重度 | 问题 | 修复 | 文件 |
|---|---|---|---|---|
| 1 | P1 | **队列幽灵行**：busy 时消息在入队时刻就写入 transcript；↑ 取回或超限丢弃后留下"你说过但模型从未收到"的幽灵行，且 transcript 与 rewind 数据源（messages）从此不一致 | 回显移到注入时刻：drain 时才 `addUserMessage`，与注入模型的内容严格同源 | `run.tsx` |
| 2 | P1 | **排队的 `!cmd`/`#note` 永不执行**：drain 时当纯文本发给模型，shell 不跑、记忆不写 | `drainQueuedInput` 改异步，逐条经 `dispatchQueuedLine` 分派：`!` 真正跑 shell 并以 `<bash-input>/<bash-stdout>` 包裹注入；`#` 写入记忆且不产生模型回合；普通文本走 `buildUserContent`（顺带修复图片 chip 跨回合泄漏） | `run.tsx`、`agent-loop.ts`、`types.ts` |
| 3 | P1 | **`/theme light` 是空操作**：`options.theme` 无消费者，palette 是静态常量——观感层面最扎眼的假功能 | palette 改为**可变单例**：`applyTheme` 逐字段原地改写（dark/light 双套字面量取自官方 theme.ts）；组件一律渲染时读 `palette.x`（清除模块级快照常量）；启动时应用已保存主题；/theme 设置即生效（借命令自身日志输出触发重绘） | `theme.ts`（重写）、`commands/theme.ts`、`InputBox.tsx`、`PlanApproval.tsx`、`Prompts.tsx`、`run.tsx` |
| 5a | P2 | **RewindPicker "4. Never mind" 永远不可选**：渲染了第 4 行但数字键只认 1-3、箭头到不了 | 列入 ACTIONS 真选项（dim 样式保留），resolve(null) 关闭；数字键放开 1-9 | `RewindPicker.tsx` |
| 5b | P2 | **PlanApproval 超 15 行静默截断**：用户在批准看不见的内容且无感知 | 截断处追加 `… +N lines` 提示行（复用 `ui.tool.expandMoreShort` i18n） | `PlanApproval.tsx` |
| 5c | P1 | **vim `u`/`.` 空转**：transitions 调 `ctx.onUndo?.()`/`onDotRepeat?.()` 但 engine 从未提供——两个键字面无操作 | engine 内实现：① undo 快照栈（上限 50 = 官方 useInputBuffer）；normal 模式每次改动压栈、insert 会话 Escape 时压**一个**快照（`cw foo<Esc>` 单步撤销，vim 语义）；`u` 只弹不压（无 redo，连按向更旧回溯）。② `.` 经同一批 execute* 重放 `lastChange`，重放期禁用记录故可连点；离开 INSERT 时以前后锚 diff 还原键入文本记为 insert change（官方同语义） | `vim/engine.ts`（重写）、`InputBox.tsx` |

## 顺带修复

- **引擎首键腐烂（潜伏 bug）**：engine 懒创建于首个 normal 键，但其初始状态是 INSERT——该键会被当文本插入并弹回 insert 模式。改为 vim 激活即建（effect），Esc 分支先 `setText` 再 `handleKey("Escape")`（关闭 insert 会话，undo/dot-repeat 据此记录）。
- **`.` 后接 `dd`/`cc`/`yy` 官方也是空操作**：linewise 操作记录的 `motion=op[0]` 不是 motion，官方 replay 走 resolveMotion 静默 no-op；本实现显式分派 `executeLineOp`（优于官方，已注释标注）。

## 行为变更注意

- **`.` 的 insert 覆盖语义与官方一致**：`cw foo<Esc>` 后 `.` 只重放键入的 "foo"（官方 Escape 时 insert 覆盖 operator change）。undo 分组则**优于**官方：`cw foo<Esc>` 一次 `u` 全撤（官方靠 1s 防抖缓冲，时序不定）。
- **shell 注入格式**：排队的 `!cmd` 注入模型时包裹 `<bash-input>/<bash-stdout>`（输出截 4000 字符），transcript 侧显示 bash 标记 + 前 20 行输出 notice——与即时 `!` 路径一致。
- **主题切换即时生效但非全量重绘**：已提交的 `<Static>` transcript 行不重染（Ink 限制），新输出即刻使用新主题。

## 新增回归测试

- `theme.test.ts`（5 例：light 字面量 / 往返恢复 / 未知名回退 dark / palette 对象同一性）
- `vim.test.ts` +12 例（undo 6：单步/动作不压栈/多步序/insert 单单元/cw 分组/空栈；dot-repeat 6：操作符重放/连点/dd 行式/insert 重放/无记录 no-op/重放可撤销）
- `queued-dispatch.test.ts`（4 例：纯文本注入时回显一次 / `!` 真跑 shell 并包裹注入 / `#` 写记忆无模型回合 / 裸 `!`、`#` 落回纯文本）
- `state-flows.test.tsx` +4 例：Never mind 数字键与箭头两路可选且 resolve(null)；PlanApproval 溢出 "+5 lines" 提示与短计划无提示
