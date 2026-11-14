# 分叉核心引擎推进计划

> 日期：2026-11-11。依据：[产品方向](architecture/decisions.md)、[差距评估的最新推进顺序](20261002-claude-code差距评估.md#推荐推进顺序2026-11-11-按分叉战略修正)。
> 范围：核心引擎行为与长任务可靠性；生态采用本项目自己的约定。

**总目标：在完整编码任务上达到 Claude Code 的功能深度，同时保留第三方模型支持和独立生态。** 验收覆盖完整编码闭环、长任务恢复、上下文连续性、子代理协作和自动化契约，不以功能名称或测试总数代替效果证据。

2026-11-14 收尾时暂停目标。该批改动已验证 Headless 工具批次强停恢复、Workflow 未确认步骤的重放保护、Windows CLI 强停后的后台 Bash 进程树清理，以及两次压缩后继续执行用户更正。见[后台进程监护](更新日志/20261114-background-shell-supervisor.md)、[Workflow 未确认步骤](更新日志/20261114-workflow-unconfirmed-recovery.md)和[上下文更正](更新日志/20261114-context-correction.md)。

推送前，本地 Windows 的类型检查、lint/格式检查、CLI 构建与发布包冒烟均通过。全量测试 3,276 项通过、1 项跳过，包含此前在核心套件中偶发失败的仓库迁移用例。该次偶发失败的原因仍待查。恢复目标后继续补 Linux 进程恢复验收。

## 第一阶段：建立可重复的核心行为验收

`npm run test:core` 固定运行以下 31 个测试文件。它复用真实执行路径与隔离 fixture，无需真实 API key。完整门禁仍运行 `npm test`。

| 机制 | 固定测试入口（`src/__tests__/`） | 验收重点 |
|---|---|---|
| 工具与循环 | `agent-loop.test.ts` | 工具调用/结果配对、终止、重试 |
| 权限与安全底线 | `integration-permissions.test.ts` | allow/deny/ask 与执行约束 |
| 委派 | `delegated-policy.test.ts` | Task/Agent/Team/Workflow/Fork Skill 保留父级限制 |
| 压缩 | `compaction.test.ts` | 压缩行为与失败时历史保留 |
| 流式工具 | `streaming-tool-executor.test.ts` | 早启动、串行屏障与取消 |
| 文件恢复 | `checkpoint-persist.test.ts` | 持久化与回退材料 |
| 会话生命周期 | `session-lifecycle.test.ts` | 会话切换、恢复与清理 |
| CLI 完整流程 | `cli-headless-e2e.test.ts` | JSON 输出、持久化和恢复 |
| 实时控制 | `headless-control.test.ts` | 审批、输入重写、EOF、中断与后续回合 |
| 预算 | `model-budget.test.ts` | 并发预留、释放与嵌套记账 |
| 跨进程恢复 | `runtime-process.test.ts` | 强停后恢复归属、复用已保存的 workflow 报告、阻止重放未确认的步骤 |
| CLI 强停与需求变更 | `headless-crash-recovery.test.ts` | 已完成批次、等待后续审批、快照替换前三种强停，新进程恢复后按变更要求继续 |
| 编码闭环验收 | `evaluation.test.ts` | 可执行验收、精确命令审批、失败→修复→成功证据与候选补丁 |
| 工程构建与迁移 | `repository-evaluation.test.ts` | 真正 TypeScript 编译/类型负例、源码迁移、新文件与文档补丁、干净仓库复验、真实 CLI 只读 Shell 审批 |
| 上下文连续性 | `context-continuity.test.ts` | 连续批次压缩、近期约束和更正顺序、实际文件操作、取消边界 |
| 委派结果交接 | `subagent-outcomes.test.ts` | 五入口 Terminal 判定、部分结果、通知状态、重试和完成缓存 |
| 隔离子代理恢复 | `subagent-worktree-resume.test.ts` | Agent/Task 继续原工作树、保持工作会话与主目录改动、拒绝已移动或切换分支的工作树 |
| 跨进程协作与补丁冲突 | `collaboration-evaluation.test.ts` | 新 CLI 找回审查和 agent id、同一工作树修订、两个并发 worker 的重叠补丁、保留用户改动并重放补丁 |
| TS SDK / 真实审批 | `sdk.test.ts`、`sdk-delegated-approval.test.ts` | RPC、回调取消、进程收尾、真实 CLI 直接与委派重写 |
| Python SDK | `sdk-python.test.ts` | 一次性与持续会话协议、真实 CLI 中断/继续/写入/新进程恢复 |
| 子执行者策略 | `headless-delegated-policy.test.ts` | 两层审批包装后的正常重写与更严格 child deny |
| TS 输入生命周期 | `sdk-input-lifecycle.test.ts` | CLI 退出与输入挂起、return/throw 取消、重复和乱序结果、错误保真和 EOF 清理 |
| TS 多轮恢复 | `sdk-session-continuity.test.ts` | 真实 CLI 中断审批后继续写入、新进程恢复、恢复过程超时后再次恢复 |
| 独立生态 | `ecosystem-contract.test.ts` | 配置来源与 env、扩展覆盖/命名空间/重载、MCP 关闭规则与真实子进程调用 |
| 后台进程与代理 | `job-process-tree.test.ts`、`agent-guards.test.ts` | 三级 PID/心跳终止、输出/退出码、取消等待、后台代理清理后结算 |
| CLI 后台退出 | `job-cli-exit.test.ts` | 真实 headless/REPL 正常退出，宿主强停后普通后台树停止、恢复诊断和无关进程保留 |
| 后台归属与隔离 | `job-scope-ownership.test.ts` | 五委派入口、嵌套与恢复作用域、只清理访问过的会话、旧快照定点更新 |
| SDK 强制收尾 | `sdk-process-tree.test.ts`、`owned-process.test.ts` | TS/Python 前后台进程树、暂停/输入失败/取消、无关进程保留、强停后恢复、原生部分失败核验 |

2026-11-11 首轮：10 文件、188 项通过。新增的三个用例包含两种畸形审批信封和一个跨回合取消场景；畸形信封用例修复前均实际执行了工具，修复后拒绝执行。详见[修复记录](更新日志/20261111-core-control-validation.md)。

加入跨进程恢复验收后：11 文件、195 项通过；全量 3,122 项通过、1 项跳过。恢复问题与证据见[恢复记录](更新日志/20261111-runtime-process-recovery.md)。

加入编码闭环证据验收后：12 文件、207 项通过；全量 3,126 项通过、1 项跳过。真实模型两轮完整闭环均通过，见[闭环记录](更新日志/20261111-coding-loop-evidence.md)。

加入上下文连续性验收后：13 文件、212 项通过；全量 3,131 项通过、1 项跳过。真实模型两轮强制压缩后继续修复均通过，见[上下文记录](更新日志/20261111-context-continuity.md)。

加入委派结果交接验收后：14 文件、240 项通过；全量 3,159 项通过、1 项跳过。真实 worker 两轮 worktree 交接与主控独立测试通过，见[委派记录](更新日志/20261111-subagent-outcomes.md)。

加入 SDK 审批与生命周期验收后：18 文件、259 项通过；全量 3,169 项通过、1 项跳过。真实本地 SDK/CLI 委派重写、子执行者 deny、取消和进程关闭均通过，发布包烟测通过，见[契约记录](更新日志/20261111-sdk-approval-contract.md)。

加入 Python 持续会话验收后：18 文件、260 项通过；全量 3,170 项通过、1 项跳过。Python 内部 20 项另行统计，不重复计入 Vitest 总数。真实 CLI 中断/继续/恢复和包内默认入口均通过，见[持续会话记录](更新日志/20261111-python-persistent-client.md)。

加入 TS 输入生命周期与连续会话验收后：20 文件、271 项通过；全量 3,181 项通过、1 项跳过。真实 CLI 覆盖恢复后的文件读回和停止排队回合，Python 独立协议集为 21 项，详见[TS 连续性记录](更新日志/20261111-ts-sdk-continuity.md)。

2026-11-12 加入独立生态契约后：21 文件、287 项通过；全量 3,197 项通过、1 项跳过。发布包内的格式说明和仅 settings 凭据的交互启动均通过烟测，详见[生态记录](更新日志/20261112-independent-ecosystem.md)。

2026-11-12 加入后台生命周期验收后：24 文件、317 项通过；全量 3,216 项通过、1 项跳过。Windows 实际三级进程、CLI 正常结束与后台终态恢复通过，发布包烟测通过，见[后台记录](更新日志/20261112-background-process-lifecycle.md)。

加入后台归属与切换验收后：25 文件、333 项通过；全量 254 文件、3,232 项通过、1 项跳过。五个委派入口、嵌套/恢复范围、真实 CLI 切换后退出及旧快照保真通过，发布包烟测通过，见[归属记录](更新日志/20261112-background-job-ownership.md)。

加入 SDK 进程收尾验收后：27 文件、351 项通过；全量 256 文件、3,250 项通过、1 项跳过，Python 协议集 22 项包含在对应 wrapper 验收内。Windows 普通前后台命令树、暂停消费/输入失败/取消、原生部分失败核验及强停后恢复通过，包烟测通过，见[进程记录](更新日志/20261112-sdk-process-tree.md)。

加入 TypeScript 工程修复与迁移验收后：28 文件、357 项核心测试通过；全量 257 文件、3,256 项通过、1 项跳过。候选补丁覆盖创建/移动/根文档并在干净输入上复验，固定命令审批还覆盖只读 Shell，见[工程任务记录](更新日志/20261112-repository-task-evaluation.md)。

加入工作树恢复与跨进程协作后，Windows 单 worker 核心集 30 文件、365 项全部通过。真实 `k3` 跨进程套件 1/2 完整通过，另一轮主目录测试成功后等候最终结果超时。见[跨进程验收](更新日志/20261112-collaboration-resume-evaluation.md)。

加入并发工作树冲突验收后，Windows 双 worker 全量 259 文件通过、3,265 项通过、1 项跳过。真实 `k3` 冲突套件 2/2 通过。见[冲突验收](更新日志/20261112-collaboration-conflict-evaluation.md)。

加入 SDK 结果归属后，Windows 双 worker 全量 259 文件、3,268 项通过、1 项跳过。Python 协议集 24 项由 Vitest 包装测试执行。见[结果归属](更新日志/20261112-sdk-result-ownership.md)。

加入 Headless 强停恢复后，Windows 双 worker 核心集 31 文件、369 项全部通过。定向协议测试另验收关闭持久化和保存失败。见[本轮状态](更新日志/20261112-headless-crash-recovery.md)。

加入批次中断与快照替换前强停回归后，Windows 双 worker 核心集 31 文件、371 项全部通过。见[批次中断恢复](更新日志/20261114-headless-partial-batch-recovery.md)。

这证明上述测试覆盖的行为在本机成立，不能据此推断真实编码成功率或与官方的效果等价。

真实测量扩展为 `repository-tasks-v2`：`k3` 两任务各两轮 4/4 通过，累计 318.141 秒；候选补丁在另一份初始仓库重放后，独立编译与边界验收仍通过。修复评估器遗漏暂存移动/新文件/根文档的补丁，以及只读 Shell 绕过白名单审批的问题；原型与严格配置分开记录，见[工程任务记录](更新日志/20261112-repository-task-evaluation.md)。

## 后续顺序与完成条件

1. **真实任务测量（已建立首个基线）**：已建立隔离临时 Git 仓库中的读码定位、单文件修复、跨文件修复三个任务，使用外置可执行验收；评估器记录模型、任务指纹、轮次/输出/时间限制、耗时、usage 和费用，未知费用保留 null。`k3` 首次两轮为 5/6，其中一个失败暴露了任务表述歧义；明确输出格式后升级为 `core-coding-v2`，两轮 6/6 通过，约 285 秒，详见[测量记录](更新日志/20261111-core-evaluation.md)。命令与口径见[测量说明](core-evaluation.md)。尚未进行官方效果对照，不把两轮小样本外推为稳定成功率。
2. **长任务恢复验收（跨进程与真实后台生命周期已建立首轮证据）**：七项跨进程验收覆盖 goal、延时、归属、后台诊断与 workflow 缓存，修复记录见[恢复日志](更新日志/20261111-runtime-process-recovery.md)。进一步用 Windows 上实际三级 Node 进程的 PID 和心跳验证取消、TTL、session cleanup；修复提前结算、非零退出误报完成、解码尾部丢失和后台代理取消状态。真实 headless/REPL 结束后树已停止且保存 killed，TUI 验证清理→保存→退出，见[后台生命周期记录](更新日志/20261112-background-process-lifecycle.md)。派生作业现归属主会话，五个委派入口和稳定恢复作用域已有验收；CLI 精确跟踪已访问会话，退出清理旧会话作业并仅更新后台快照，见[归属记录](更新日志/20261112-background-job-ownership.md)。仍需覆盖强制杀死宿主、主动脱离的后代、保存中断及 workflow 副作用与结果落盘窗口，不把首轮证据视为整个矩阵完成。
3. **完整编码闭环（JavaScript 与 TypeScript 首组已验证）**：`coding-loop-v1` 要求实际测试失败后修复两个源码文件，再次测试；`k3` 两轮 2/2 通过，见[闭环记录](更新日志/20261111-coding-loop-evidence.md)。后续 `repository-tasks-v2` 要求实际 TypeScript 编译失败后修复导出、解析与对象所有权，另一个任务执行模块移动、比较器抽取、消费者和 README 更新；严格审批下两任务各两轮 4/4 通过，四份 patch 在干净仓库重新编译与验收通过，见[工程任务记录](更新日志/20261112-repository-task-evaluation.md)。仍需依赖更完整的真实项目、长任务中途需求变更、取消恢复和主模型自主委派/合并；小型固定任务不代表全场景已完成。
4. **上下文连续性（首组已验证）**：修复连续工具批次无法切分、有损摘要丢失当前用户任务、取消时提交部分摘要及多余模型调用。五项确定性验收观察实际文件操作；`npm run eval:context -- 2` 的两轮真实 `k3` 测量均通过，每轮实际执行两次摘要并保留已有改动。详见[上下文记录](更新日志/20261111-context-continuity.md)。继续覆盖多模态、CLI/SDK 恢复链路与更早约束的摘要质量。
5. **子代理协作（终止与交接首组已验证）**：统一五个委派入口读取 Terminal，修复部分报告和 Stop Hook 续做上限被误报完成、Team 旧报告/错误残留、Workflow 缓存失败结果等问题。28 项确定性验收通过，真实 `k3` worker 两轮 worktree 交接和主控脚本独立测试均通过，见[委派记录](更新日志/20261111-subagent-outcomes.md)。继续扩展主模型自主分派/验收、并发冲突、共享预算与取消传播。

   `isolated-collaboration-v1` 实测两轮均通过。主模型在真实 CLI 内调用 Agent，在独立测试发现新要求后恢复同一 agent id 和工作树，再验证并应用 Git 补丁。两轮保留主目录的未暂存笔记，补丁重放通过。跨进程套件在新 CLI 中验证同样的协作行为，离线验收通过，真实 `k3` 完整通过 1/2。见[跨进程验收](更新日志/20261112-collaboration-resume-evaluation.md)。

   `worktree-conflict-v1` 验证两个独立 worker 改同一行。真实 `k3` 两轮都处理了 Git 拒绝第二份补丁的冲突，合并两条规则，并保留同文件的用户改动。离线回归用本地模型请求屏障确认两个子代理都已启动。继续覆盖共享预算与取消传播。见[冲突验收](更新日志/20261112-collaboration-conflict-evaluation.md)。
6. **自动化契约（审批、生命周期与两端多轮恢复已建立验收）**：委派输入重写按实际执行者权限复核，SDK 回调取消、非法消息诊断和异常退出评估已有回归，详见[契约记录](更新日志/20261111-sdk-approval-contract.md)。Python `CCRClient` 的持续会话、RPC 和恢复已有验收，见[持续会话记录](更新日志/20261111-python-persistent-client.md)。TS 进一步修复输入挂起导致退出等待、return 无法打断读取且发送迟到输入、缺少结果被当成正常退出等问题；10 项输入生命周期回归通过，两端关闭未完成任务都不会用 EOF 继续执行队列。真实 TS SDK/CLI 验收覆盖中断审批→同进程继续→新进程恢复并读回文件，见[TS 连续性记录](更新日志/20261111-ts-sdk-continuity.md)。重复终止帧与控制消息的剩余矩阵仍需覆盖；这些验收不构成官方全部 SDK API 的兼容承诺。
7. **独立生态整理（首轮规则清单与验收已建立）**：新增随包发布的[独立生态说明](independent-ecosystem.md)，列明根目录、设置/env 来源、指令发现、扩展字段和 MCP 顺序，区分已消费字段与未实现语义。16 项契约验收首次 7 项失败，实际复现停用 user 后 env 仍生效、显式 settings env 被忽略，以及插件内联 MCP 绕过 strict/disabled、畸形值崩溃，均已修复。正向测试实际调用 MCP 工具，包烟测覆盖仅 settings 凭据交互启动，详见[生态记录](更新日志/20261112-independent-ecosystem.md)。嵌套/扩展未知字段、同名插件整包语义、依赖/LSP/marketplace 组合和热更新仍需继续验收，不把规则清单当成整个生态已完成。

SDK 主动关闭及超时兜底的普通自有进程树现在已有证据：本项目 shutdown 控制帧取消回合、清空输入队列，超时才强停；输入失败与暂停消费时取消也覆盖。上文长任务条目剩余的宿主强杀，指任意外部终止及已失去父关系的后代，并非把本轮 SDK 场景重新列为未做。新进程恢复使用最后快照，不承诺强停后的最终保存，见[进程记录](更新日志/20261112-sdk-process-tree.md)。

每轮先选一个可观察的场景，复现失败再修复；记录验证结果后推进下一项。下一批优先扩大依赖更完整的真实项目，验证主模型自主委派、验收和合并，以及中途需求变更与取消恢复；继续补外部宿主终止、生态嵌套字段、插件组合与 SDK 重复终止帧等矩阵，不把首组验收或少量任务通过记为整个核心引擎已验收。
