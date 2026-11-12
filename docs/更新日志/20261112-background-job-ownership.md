# 后台任务归属与退出清理

> 日期：2026-11-12；类型：fix / test；模块：后台作业、委派、CLI 会话切换。
> 关联 commit：工作区改动，尚未提交。
> 关联：[核心计划](../20261111-core-engine-plan.md)、[上一轮生命周期修复](20261112-background-process-lifecycle.md)。

## 问题与复现

Agent 使用独立 checkpoint sessionId，后台任务因而进入主会话看不到的桶；Task、Team 等共享 sessionId 时，子代理反而能读写父级或同级任务。`agent-loop.ts` 重建 ToolContext 的显式字段列表还会丢失派生元数据。CLI `/resume` 后退出仅清理当前 sessionId，使旧会话后台进程继续运行。

新增六项初始回归全部失败：Agent 与嵌套任务在主会话中不可见，其余四个入口未隔离同级。补齐上下文传递后六项通过。真实 CLI 切换会话回归在修复前输出恢复成功但 12 秒未退出，修复后退出 0 且三级 Node 进程均已停止。复现输出保存在本机 `.review-tmp/job-scope-red.log` 与 `.review-tmp/job-resume-red.log`。

## 行为变化

- 作业按主会话归属注册，checkpoint 标识保持原有职责。JobList/Output/Kill 按委派路径过滤：主会话可管理所有派生任务，worker 只能管理自身及下级任务。
- Agent/Task 使用同一稳定 worker key，支持同入口及交叉入口恢复；Team 连续消息保持自身路径。Workflow、Fork Skill 与嵌套派生也继承主会话归属。
- CLI 精确记录本次访问过的会话 ID，headless、REPL、TUI 退出清理该集合。没有按 ID 前缀匹配，也不清空全局作业。
- 清理后对旧 runtime 仅更新 backgroundJobs，保留目标、队列、其他字段及原 savedAt，避免刷新过期输入。缺失快照不重建，损坏快照拒绝覆盖。

## 验收

- `job-scope-ownership.test.ts` 新增 14 项：五个实际委派入口启动真实三级 Node 进程；主会话可读、父/同级隔离、嵌套祖先可读、清理后 PID 停止并保存 killed；Agent/Task 四种恢复组合和 Team 连续回合；无关会话保留；旧快照保真及缺失/损坏保护。
- `job-cli-exit.test.ts` 从 2 项扩展为 4 项：增加真实 headless→Agent→后台 Bash，以及 REPL 启动作业→切换会话→退出；本地 HTTP provider 驱动实际源码 CLI，检查进程和落盘状态。
- 六文件定向集合 90 项通过。核心集合 25 文件、333 项通过。
- 首次全量 3,231 项通过、1 项失败、1 项跳过；失败来自既有 `sub-context.test.ts` 的精确字段白名单尚未列出新归属字段。同步白名单并验证归属/路径值后，该文件 11 项通过，随后重跑全量。
- `npm run typecheck`、`npm run check` 通过；原有 764 项警告，无错误。
- `npm run smoke:package` 通过，631 文件、8.02 MiB 解包体积。

最终 `npm test`：254 文件通过，3,232 项通过、1 项跳过（151.83 秒）；`npm run docs:sync -- --check` 与 `git diff --check` 通过。完成后检查，本轮 job-tree fixture 没有存活进程。源码 68,458 行、305 文件；测试 254 文件。

## 受影响文件与定位

新增：`D:/AI项目/claude_personal/src/__tests__/job-scope-ownership.test.ts`、本文。

修改：`D:/AI项目/claude_personal/src/types.ts`、`D:/AI项目/claude_personal/src/agent-loop.ts`、`D:/AI项目/claude_personal/src/tools/job-store.ts`、`D:/AI项目/claude_personal/src/tools/core/bash.ts`、`D:/AI项目/claude_personal/src/tools/extended/agent.ts`、`D:/AI项目/claude_personal/src/tools/extended/task.ts`、`D:/AI项目/claude_personal/src/tools/extended/jobs.ts`、`D:/AI项目/claude_personal/src/team.ts`、`D:/AI项目/claude_personal/src/cli-session.ts`、`D:/AI项目/claude_personal/src/session-runtime.ts`、`D:/AI项目/claude_personal/src/cli-main.ts`、`D:/AI项目/claude_personal/src/cli-repl.ts`、`D:/AI项目/claude_personal/src/tui/run.tsx`、`D:/AI项目/claude_personal/src/__tests__/job-cli-exit.test.ts`、`D:/AI项目/claude_personal/src/__tests__/sub-context.test.ts`，以及 package.json 与当前文档导航、指标和使用说明。

根因入口（本轮源码）：`types.ts:372` 的 deriveSubContext、`agent-loop.ts:259` 的 baseContext、`job-store.ts:198` 的注册/可见性查询、`cli-session.ts:38` 的可变 session identity；旧会话定点保存见 `session-runtime.ts:24`。

## 边界

后续 [SDK 进程树修复](20261112-sdk-process-tree.md)已覆盖下述 SDK 关闭及其超时强停的普通自有进程场景；任意外部宿主强杀等其余边界保留。

本轮在 Windows 验证普通自有进程树与正常 CLI 收尾，不代表 Unix 分支或任意脱离进程已实测。强制结束宿主、SDK 超时强杀、主动脱离的后代、无法配合取消的生产者及运行状态跨文件事务仍未完成。单个后台 Agent 的 kill 不承诺清理其独立启动的所有后台任务；这些任务仍由主会话管理，CLI 退出时收集。没有调用付费 provider，不据此声明真实编码效果已与 Claude Code 等价。
