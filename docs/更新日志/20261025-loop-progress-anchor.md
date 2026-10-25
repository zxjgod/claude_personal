# /loop 进度锚定与交付物落盘

- **日期**：2026-10-25
- **类型**：feature
- **模块/子系统**：受控循环（loop-runtime / loop-settings / loop 命令与菜单）
- **主题**：让多轮迭代的质量不随聊天历史自动压缩而衰减——累计状态锚定在工作区文件，最终交付结论落盘，并在无客观验收时主动引导配置。

## 背景与根因

用户目标是"模型按任务目标多轮迭代、最终高质量完成工作"。现有实现的两处差距：

1. 循环与所在会话共享聊天历史，历史超过模型窗口 85% 即自动压缩为摘要（`agent-loop.ts` 的 autoCompact 阈值），早期轮次细节丢失，长循环质量衰减；此前只能靠用户在任务目标里手写"维护进度文件"来缓解，属于使用技巧而非机制。
2. 未配置完成检查（commands/files）时，循环只能以模型自评结束——正是完成判定门要防的"宣称胜利"失败模式，但启动时没有任何提示。

## 受影响文件

### 修改

- `src/loop-settings.ts`（配置新增 `progressFile: boolean`，默认 true）
- `src/loop-runtime.ts`（进度文件路径/读取/模板初始化/备注追加；`loopInput` 每轮注入文件内容；`loopSystemInstruction` 增加维护要求与终轮 `## Final Report` 要求；`startLoop`/`stopLoop`/`settleLoopRound` 完成分支接线；`displayLoopInput` 剥离重注入段）
- `src/commands/loop.ts`、`src/tui/loop-menu-flow.ts`（无完成检查时启动提示）
- `docs/loop-management.md`、`docs/CHANGELOG.md`（新增 "Progress File And Deliverables" 说明）
- `src/__tests__/loop-runtime.test.ts`（新增 3 项回归）

## 行为细节

- 进度文件：`.claude/loops/<session>.progress.md`；启动写模板（Objective/Status/Done/Key findings/Next iteration plan/Blockers）；每轮注入截断至约 12,000 字符，标记段 `[Loop progress file — current durable state]`；`beginLoopRound` 的首行匹配不变（轮次标记仍是首行）。
- 回放与 TUI 转录不显示重注入段（`displayLoopInput` 同时剥离 progress 与 verification 段）。
- 终轮（final wrap-up）指令额外要求在该文件写 `## Final Report`（结果对照目标、验证证据、交付物、遗留问题）。
- 停止/完成时运行时追加一行时间戳备注（best-effort）。
- `progressFile: false` 时完全不注入、不初始化、指令不含 Durable state 段（回归测试覆盖）。

## 相关测试

`src/__tests__/loop-runtime.test.ts` 新增 describe「durable progress file」：
- 启动播种 + 每轮注入当前内容 + 首行轮次标记稳定 + 回放隐藏重注入段；
- 指令含文件绝对路径与"single source of accumulated truth"，终轮含 `## Final Report`，完成后备注落盘、状态 completed；
- 停止追加原因；`progressFile:false` 全链路关闭。
通过情况：loop-runtime 18/18（原 16 + 新 3，其中 1 项合并进原有结构）。

## 验证命令与实测结果

`npx tsc --noEmit`、`npx biome check src`、`npx vitest run src/__tests__/loop-runtime.test.ts` 全部通过；全量门禁结果见本轮最终汇总（CI Linux/Windows 双腿复验）。

## 关联文档

- [Loop management](../loop-management.md#progress-file-and-deliverables)
- [CHANGELOG v1.6.1](../CHANGELOG.md)
