# TUI 审查热修（2026-09-07）

> 触发：全量 TUI 审查（视觉/输入/编排三层）发现的已验证缺陷。本批只修**经源码级复核确认**的项，其余进入审查报告待办。
> 结果：测试 1528 → 1534（新增 3 回归 + 更新 4 旧断言），唯一失败为既有 Windows worktree 临时目录 EPERM 环境抖动（非 TUI、改动前即存在）。tsc 零错误。

## 修复清单

| # | 严重度 | 问题 | 修复 | 文件 |
|---|---|---|---|---|
| 1 | P0 | **Ctrl+G 编辑静默失效**：`openInEditor` 在 finally 先删临时文件，`editInEditor` 读回必 ENOENT，用户在 $EDITOR 的修改永远丢失（草稿编辑 + Plan 审批 ctrl+g 两链路全哑） | `openInEditor` 加 `keepFile` 选项，`editInEditor` 读回后自行删除 | `open-editor.ts` |
| 2 | P1 | **幽灵动作重放**：store `inputAction` 永不清除，InputBox 每次重挂载（权限框/Picker 关闭）重放上一次 Ctrl+G/S/R | mount 时以当前 seq 初始化已消费游标，只执行挂载后派发的动作 | `InputBox.tsx` |
| 3 | P1 | **Ctrl+R 历史搜索被全局热键重置**：搜索中按 ctrl+r，ModeHotkey 二次派发把查询清空，"连按翻旧匹配"不可用 | 搜索激活时 action 处理器视为 no-op（循环由 InputBox 内部分支负责） | `InputBox.tsx` |
| 4 | P1 | **bash 回合（`!cmd`）失控**：controller 未注册 → Ctrl+C 落入空闲路径（双击直接退出进程）、Esc 死键；一次性队列 → 期间排队消息永不送达；`askUser` 恒 true → 回应回合权限全免 | 与正常回合同构接线：注册 turnControllerRef + SIGINT、主队列 + follow-up 排空（抽 `drainFollowUpTurns` 共享）、真实 askUser、live permissionMode | `run.tsx` |
| 5 | P1 | **↑↓ 优先级与官方相反**：多行草稿+非空历史时按 ↑ 整段被历史替换（官方：光标先在多行内移动，顶/底才翻历史；方案文档"✅ 逻辑一致"自评有误） | 光标在首行/末行才进入历史；浏览历史状态中保持走历史 | `InputBox.tsx` |
| 6 | P1 | **fullscreen SIGTERM 被吞**：restoreScreen 后不退进程，`kill` 失效 | restore 后 `process.exit(143)` | `run.tsx` |
| 7 | P2 | **fullscreen 流式渲染 O(n²)**：每帧对全 transcript 重算 markdown | 按 transcript 数组引用 memo 已提交部分，每帧只算流式尾部 | `FullScreenApp.tsx` |
| 8 | P2 | **失败工具状态点恒绿**（官方三态：dim 闪→绿/红） | ToolStatusGlyph 加 isError 态（palette.error） | `ToolCard.tsx` |
| 9 | P2 | **⎿ 分支几何两路径错位**：flat 路径 `⎿+1 空格` vs Ink 路径 `⎿+2 空格`；StructuredError 再偏 1 列 | 统一 `  ⎿  `（内容列 5），续行 4 空格 | `transcript-lines.ts`、`ToolCard.tsx` |
| 10 | P2 | **markdown 嗅探只看前 500 字符**：长散文 intro 后的代码块/表格泄漏原始标记 | 全串嗅探（正则 O(n) 远低于 lexer） | `markdown.ts` |
| 11 | P2 | **Toast CJK 溢出**：居中 padding 用 `text.length`，中文 toast 破框 | 去掉手工 padding，justifyContent 单一居中 | `Toast.tsx` |
| 12 | P2 | **Spinner 12 帧端点重复**（✽/· 各停 240ms 卡顿），官方 11 帧 | 逆序去首元素 | `spinner-core.ts` |
| 13 | P3 | 行式 CLI 给普通 assistant 文本加 ● 前缀（与官方及自身 Ink 路径矛盾） | 去掉前缀 | `cli-renderer.ts` |
| 14 | P3 | "Thought for Ns"、"… +N lines" 硬编码英文 | 入 i18n 表（`ui.thinking.thoughtFor`、`ui.tool.expandMoreShort`） | `transcript-lines.ts`、`i18n.ts` |

## 行为变更注意

- **bash 回应回合恢复权限提示**：原实现 `askUser: async () => true` 导致 `!cmd` 后 Claude 的回应回合自动批准一切工具权限；现已与正常回合同构（走真实权限框）。shell 命令本身仍免门（用户显式调用）。
- **测试语义更新**：`pendingAction` 初始 prop 不再于挂载时触发（防重放）；3 个 ctrl+r 测试改为挂载后 rerender 派发。

## 新增回归测试

- `open-editor.test.ts`（3 例：读回编辑内容 / 读后删临时文件 / view-only 路径默认清理）
- `input-behaviors.test.tsx` +3 例：mount 幽灵动作不重放、↑ 多行内移动优先于历史、搜索中 ctrl+r 循环不重置
