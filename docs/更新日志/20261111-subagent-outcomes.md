# 委派终止状态与 worktree 成果交接验收

> 日期：2026-11-11
> 类型：fix / test / evaluation
> 模块：Task / Agent / Team / Workflow / Fork Skill
> 状态：28 项确定性验收与真实 worker 首组测量通过，最终门禁见下
> 关联 commit：本次工作区改动
> 关联文档：[核心引擎计划](../20261111-core-engine-plan.md)、[测量说明](../core-evaluation.md)

## 复现与根因

新增 `subagent-outcomes.test.ts`，在真实 agentLoop 和工具执行链上注入可控模型输出。首轮 13 项中 10 项失败、3 项通过：

- worker 先产生部分文字、调用工具，随后遇到不可恢复错误，Workflow 仍返回这段文字，外层会把失败 worker 的报告缓存为完成步骤；Team 也因有文字而标记 done、发成功通知，send_message 隐去错误。
- Stop Hook 持续阻止结束并达到硬上限时，循环先发 `done(end_turn)`，随后返回 `Terminal(stop_hook_limit)`。五个委派入口只消费 yielded events，丢失 generator 返回值，因此均把该情形当正常完成。
- Team 使用整个历史提取最近助手文字，当前回合无输出的错误会返回上一回合的报告；成功重试后还残留旧错误字段。

## 实现

新增 `src/subagent-outcome.ts`：消费事件以提供进度，但使用 generator 返回的 Terminal 判断最终状态；进度回调抛错时仍关闭 generator，执行清理。`completed` 与已接受的 `stop_hook_prevented` 映射为正常结束，Stop Hook 硬上限、预算、取消和模型错误保留具体原因。

五个入口全部采用同一消费规则。正常结束还需有报告；预算耗尽的 Task/Agent 继续提供明确标为 incomplete 的部分交接，不冒充完成。Workflow 失败时抛错并带上部分输出，未完成报告不写入完成缓存。Team 对当前回合单独提取报告，错误状态与通知不受部分输出覆盖，后续成功清除旧错误。

验收扩展至 28 项：五入口分别验证 fatal+partial、正常报告、空报告、turn budget、stop-hook limit；另验证 Team 通知/重试、旧报告隔离和 Workflow 缓存。全量还识别出三个并发 fixture 用空输出模拟成功；改为返回真实报告，保持并发上限和槽位释放断言，并用新增空报告矩阵锁住新规则。

“运行正常结束”只是交接的必要条件；代码是否满足需求仍需主控独立验证。

## 真实 worktree 交接

新增 `npm run eval:subagents -- 2`，使用真实 AgentTool、模型、Read/Write 工具和 Git worktree。worker 只有文件工具，修复两个相互调用的源码文件，返回路径/分支；主控脚本再独立执行可见测试和对象、NaN、冻结数组等边界验收。主控同时检查：主工作区源码不变、测试文件不变、两个源码文件都有候选差异，成果 worktree 被保留。

本机 Node v24.16.0 / Windows，已有 `anthropic` 类型连接、模型 `k3`；每 worker 8 turn、每响应最多 2,048 tokens、180 秒超时：

| 轮次 | 结果 | 耗时（秒） | 成果保留 | 进度事件 | patch 字符数 |
|---|---|---|---|---|---|
| 1 | 通过 | 45.717 | 是 | 13 | 1,049 |
| 2 | 通过 | 31.789 | 是 | 8 | 931 |

报告：`.claude/evaluations/1794408130379-50864.json`，两轮输入指纹均为 `847afcec91ebef93c3ecd1c8e082a883acb49a18124eb91715303e11382abb6e`，保存原始工具结果、进度和候选 patch。当前 AgentTool 进度未透出 usage，本测量不编造 token 数；费用未知。测量目录在结果保存后整体清理，不操作用户项目的 worktree。

这里的父侧验收由主控脚本执行；主模型自主分派/验收、并行冲突处理、共享预算和取消传播还需要继续扩展，不能用两轮样本宣称多代理协作已经全面对齐。

## 最终门禁与文件

- `subagent-outcomes.test.ts`：28 项通过；与并发文件一起 38 项通过。
- `npm run typecheck`、`npm run check`：通过，保留既有 lint 警告。
- `npm test`：246 文件通过，3,159 项通过、1 项跳过（共 3,160 项）。
- `npm run test:core`：14 文件、240 项通过。
- `npm run smoke:package`：包含新终止消费模块的实际发布包检查通过。

新增：`src/subagent-outcome.ts`、`src/__tests__/subagent-outcomes.test.ts`、`scripts/subagent-evaluate.mjs`、本文。
修改：`src/team.ts`、`src/workflow.ts`、`src/skills/forkSkill.ts`、`src/tools/extended/{task,agent}.ts`、`src/tools/breadth/team.ts`、并发测试、package.json，以及计划/架构/维护方案/测量说明/总览/日志索引。
