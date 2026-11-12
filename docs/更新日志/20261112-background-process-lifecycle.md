# 真实进程树与后台生命周期

> 日期：2026-11-12
> 类型：fix / test
> 模块：Bash / Job Store / Agent / CLI / TUI
> 状态：实现、全量、核心集合和发布包验收通过
> 关联 commit：本次工作区改动
> 关联文档：[核心计划](../20261111-core-engine-plan.md)、[SDK 与子代理使用](../深度使用指南.md)

## 已复现问题

首批 `job-process-tree.test.ts` 8 项中 5 项失败：

- 不带 reason 的 job_kill 没有设置 killReason，close 处理器把用户取消记为 done。
- TTL 与 killRunningJobs 发送结束请求后立即 settle；测试在 settled 后仍观察到三级 Node 的 PID 存活，不能把状态字段当成进程退出证据。
- 后台命令 exit(7) 被记为 done，job_output 没有退出码。
- 后台 StringDecoder 没有 end，末尾不完整 UTF-8 字节直接丢失，完成通知也缺少这部分诊断。

后台 Agent 新增两项回归均实际失败：手动 kill 在 provider finally 清理未完成前就发布 killed；父回合 abort 最后仍发布 done。再检查真实入口，headless 返回成功结果后仍被后台进程和 TTL 保持存活，12 秒内未退出；TUI /exit 直接保存 running 后 process.exit，跳过外层清理。行式 REPL 在加入等待后通过。

## 修改

- Bash 后台任务只在 child close/error 时结算，TTL 只请求停止；close 前冲刷 stdout/stderr decoder。非零或信号退出为 error，用户取消/TTL/输出限额为 killed。stdout+stderr 按 UTF-8 字节合计限额，超限后停止累积并终止。
- 无 reason 取消使用明确默认理由；保存首个停止原因。JobOutput 同时输出实际退出码与结构化 jobStatus/killReason；等待可随当前 AbortSignal 返回，后台工作继续。
- waitForJob 共用可取消、有限时的等待并清理计时器；killRunningJobs 并行等待真实生产者结算，未停止项保持 running 并返回给 CLI 告警，禁止伪造通知。
- 后台 Agent kill 仅取消 controller；runner 完成内层工具/生成器清理、收集报告后才结算。父回合取消同样为 killed。
- 已取消的 Bash 前/后台与 PowerShell 请求在 spawn 前返回。
- headless 正常结束、REPL 退出、TUI /exit 与正常 Ink 返回都等自有会话作业清理；terminal runtime 在清理后保存，TUI /exit 先清理再 onSave；headless 的 --no-session-persistence 仍不写 runtime。

## 验收证据

- `job-process-tree.test.ts`：14 项，包括实际 parent/child/grandchild PID 和心跳文件。取消、TTL、session cleanup 结算后 PID 不再运行且心跳停止；保留跨普通 turn 的后台 Bash、session 隔离、取消 read wait 的现有行为。覆盖失败码、解码尾部、合计输出限额、已取消请求不启动以及无法停止时保留 running。
- 一次真实取消后保存 runtime，由全新 Node/tsx 进程恢复；仍为 killed、保留诊断、不暴露 kill handle，原心跳保持停止。
- `agent-guards.test.ts`：两项新增延迟 finally 验收，清理未放行时不得结算或通知；放行后只发布一次 killed。
- `job-cli-exit.test.ts`：两项真实源码 CLI + 本地 HTTP provider，实际通过 Bash 工具启动三级进程；headless/行式 REPL 正常结束后 CLI 退出 0、三 PID 已停止，runtime 写入 killed / session exited。
- `tui-submission.test.tsx`：真实 Root 输入 /exit，延迟后台清理，观察清理→保存 killed→退出顺序；这里模拟 process.exit，进程结束本身由前述 CLI/PID 测试覆盖。
- 本轮不调用付费 provider；Windows 上实际进程树验收成立，Unix 分支保留进程组信号实现，不能把本机结果外推为已实测所有平台。

## 最终门禁

- 固定核心集合：24 文件、317 项通过。
- `npm run smoke:package` 通过：630 文件，解包体积 8.02 MiB；解包后两端 SDK、交互入口和版本说明通过。
- `npm run check`、`npm run typecheck`、`npm run docs:sync -- --check`、`git diff --check` 通过；原有 764 项警告，无错误。
- 全量：253 文件通过，3,216 项通过、1 项跳过。测试完成后复查，本轮进程 fixture 的 cmd 后台树没有残留。

## 文件与边界

后续[后台归属与切换修复](20261112-background-job-ownership.md)已覆盖下述派生会话与切换会话缺口；其余限制仍成立。

再后续 [SDK 进程树验收](20261112-sdk-process-tree.md)已覆盖 SDK 主动关闭、取消与超时强停的普通自有进程树，任意外部强杀和主动脱离的后代仍不在该证据内。

新增：`D:/AI项目/claude_personal/src/__tests__/job-process-tree.test.ts`、`D:/AI项目/claude_personal/src/__tests__/job-cli-exit.test.ts`、`D:/AI项目/claude_personal/src/__tests__/fixtures/job-tree.mjs`、本文。

修改：`D:/AI项目/claude_personal/src/tools/core/bash.ts`、`D:/AI项目/claude_personal/src/tools/core/powershell.ts`、`D:/AI项目/claude_personal/src/tools/extended/jobs.ts`、`D:/AI项目/claude_personal/src/tools/extended/agent.ts`、`D:/AI项目/claude_personal/src/tools/job-store.ts`、`D:/AI项目/claude_personal/src/cli-main.ts`、`D:/AI项目/claude_personal/src/cli-repl.ts`、`D:/AI项目/claude_personal/src/tui/run.tsx`、`D:/AI项目/claude_personal/src/types.ts`、`D:/AI项目/claude_personal/src/__tests__/agent-guards.test.ts`、`D:/AI项目/claude_personal/src/__tests__/tui-submission.test.tsx`，以及 package.json 和文档导航/指标。

本轮证明普通自有进程树的显式停止和正常会话结束。SDK/Python 强制结束 CLI 宿主、SIGKILL、主动脱离/重设进程组的后代、派生会话中的内嵌后台作业、跨会话已切换但仍活跃的作业与 OS 结束失败仍需独立验收，不能承诺任意后代都由本轮覆盖。无法停止的生产者会报告未停止而非伪造 killed；不合作的 JS 清理不能被强制取消。Shell 修改仍不进入 checkpoint。
