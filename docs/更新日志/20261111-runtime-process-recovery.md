# 跨进程恢复验收与延时、诊断保留修复

> 日期：2026-11-11
> 类型：fix / test
> 模块：会话恢复 / 调度 / 后台任务 / workflow
> 状态：已落地，七项跨进程验收通过
> 关联 commit：本次工作区改动
> 关联文档：[核心引擎目标与计划](../20261111-core-engine-plan.md)、[运行时归属](../architecture/decisions.md)

## 验收方法与复现

新增 `src/__tests__/runtime-process.test.ts` 与 `fixtures/runtime-process.ts`。测试启动独立 Node 进程，等待保存完成标记后发送 SIGKILL，等待进程关闭，再启动另一个进程恢复。workflow 则在第一步缓存已写入、第二步尚未完成时强制结束。全部使用临时目录与离线执行器，不读取真实凭据、不调用 provider。

首次运行六项验收中四项通过、两项失败：

- `retains background diagnostics when a new process marks a job interrupted`：预期保留 `original diagnostic`，实际 stderr 只有“进程已中断”的提示。
- `delivers an overdue relative sleep without restarting its full delay`：恢复一个创建时间已过去 5 秒的 `+1` 任务，预期立即到期，实际到期列表为空。

随后补入 durable 延时恢复，固定为七项流程验收。

## 根因与修复

`src/tools/extended/cron-shared.ts` 的 `restoreSessionJobs`、`loadDurableJobs` 和磁盘合并入口把 `createdAt` 重设为当前单调时钟，却保留旧 `createdAtMs`。`collectDueCronJobs` 使用单调时钟判定相对延时，因此重启后又要等待完整时长。现在恢复时根据持久化墙上时间重建已过时长，之后继续使用单调时钟；未来时间戳按零已过时长处理，非有限会话时间戳拒绝恢复。

`src/tools/job-store.ts` 的 `restoreJobs` 在运行中任务恢复为 error 时覆盖了 stderr。现在保留原诊断尾部并追加中断提示，总长度仍限制为一百万字符；状态、settled promise 与无 kill handle 的恢复语义保持明确。

## 固定验收矩阵

| 场景 | 预期 |
|---|---|
| 已完成 goal 与运行中结构化任务 | 完成状态和检查次数保留；结构化任务恢复为 pending |
| 运行中后台 job | 恢复为 error，settled 已结束，无旧进程 kill handle，stdout/stderr 保留 |
| 会话相对延时 | 已过期等待立即到期；未到期等待保留剩余时长；八天前会话 cron 不恢复 |
| durable 相对延时 | 立即到期；待交付期间第二次收集不重复产生到期项 |
| 排队输入 | 原会话和工作区可领取；错误归属不可领取；重复恢复不复制输入 |
| workflow 中断恢复 | 已完成 worker 的缓存复用，副作用计数为 first→second |
| workflow 参数变化 | 缓存失效，副作用计数为 first→first→second |

## 验证

- 修复后相关四文件：55 项通过；新增 durable 场景后以完整门禁为准。
- `npm run typecheck`、`npm run check`：通过，保留现有 lint 警告。
- `npm test`：244 文件通过，3,122 项通过、1 项跳过（共 3,123 项），其中七项跨进程验收全部通过。
- `npm run smoke`：构建和六组启动/会话冒烟通过。
- `npm run test:core`：11 文件、195 项通过。
- `npm run smoke:package`：实际发布包检查通过；`npm run docs:sync -- --check` 与 `git diff --check` 通过。

## 文件与边界

修改：`src/tools/extended/cron-shared.ts`、`src/tools/job-store.ts`、`package.json`、计划、文档索引和总览。新增：上述两个测试文件与本文。新的跨进程测试加入 `npm run test:core`。

后台 job 在本组测试中由注册表 fixture 表示；真实 Shell 进程树终止仍由对应的进程管理回归覆盖。本组覆盖保存成功后中断的恢复；多文件事务一致性、任意 worker 副作用的恰好一次执行仍有额外边界，不能依据缓存复用测试作全面保证。
