# SDK 强制收尾与自有进程树

> 日期：2026-11-12；类型：fix / test；模块：TS SDK、Python CCRClient、进程收尾。
> 关联 commit：工作区改动，尚未提交。
> 关联：[核心计划](../20261111-core-engine-plan.md)、[后台归属](20261112-background-job-ownership.md)、[TS 连续性](20261111-ts-sdk-continuity.md)。

## 根因与失败证据

TS `stopOwnedProcess`、输入源失败和 Node spawn 的 AbortSignal 默认处理仅终止 CLI；Python disconnect 同样只 terminate/kill 根进程。CLI 的 Shell 工具可能创建独立 Unix 进程组；杀根进程或根进程组均不能代表命令后代已退出。

使用真实源码 CLI、本地 HTTP provider 和三级 Node fixture，TS return、TS 外部取消、Python disconnect 分别覆盖前台/后台 Bash。初始六项全部失败：CLI 已退出，命令 parent/child/grandchild 三 PID 仍存活。证据保存在本机 `.review-tmp/sdk-tree-red.log`。首次编写 fixture 时遗漏 Bash 必填 description，导致工具未启动；修正 fixture 后重新运行，以上六项才构成有效的进程泄漏复现。

## 修改

- TS 增加 `terminateOwnedProcess`，Windows 使用绝对 System32 taskkill 路径和 `/T /F`，等待原生命令完成；Unix 以 `/bin/ps` 的 PID/PPID 收集该 CLI 后代，由叶到根发送 SIGKILL，不依赖单个进程组。
- TS 外部取消自行触发该收尾，避免 spawn 的默认取消先结束根进程。即使消费者暂停，取消仍会独立进行；输入生产者失败也走同一路径。重复请求合并同一个终止 Promise，消费侧仍保留 AbortError 或原始输入异常。
- Python disconnect 对未完成请求使用同样的树清理策略；async with 内任务取消也会执行收尾。Windows 辅助进程隐藏窗口，进程枚举/终止有超时。
- 已完成查询仍先用正常 EOF 让 CLI 保存并释放资源；未完成查询先请求 shutdown，超时终止自有树，避免 EOF 继续执行已排队工作。清理失败报告错误，不能以仅发送信号充当完成证据。

中途门禁暴露竞争：仅异步调用原生终止时，`sdk-session-continuity.test.ts` 的排队响应可先执行 Write（核心 345 通过/1 失败，全量 3,244 通过/1 失败/1 跳过）。因此补充本项目 `shutdown` 控制帧：SDK 关闭时立即请求取消当前回合、拒绝挂起审批、清空排队及缓冲输入，关闭输入泵；250 毫秒未退出才运行原生树终止。它是本地生命周期扩展，不宣称官方同名契约。完成 ACK 只代表请求已接受，SDK 仍等待实际进程结束。此后原连续性、输入生命周期和 headless 控制三文件 26 项通过；新增两个控制回归覆盖 idle 无 EOF 结束与 active 审批/队列/缓冲输入丢弃。

## 验收范围

新增 `sdk-process-tree.test.ts`：13 项实际进程验收，覆盖 TS return、外部取消、消费者暂停时取消、输入源失败，Python disconnect 与任务取消，分别检查前台/后台命令。每项检查 CLI 和三级 PID 结束、心跳文件停止；测试宿主另起的无关进程保持运行。Python 缺失时相应用例明确跳过。

另一路先收集后台诊断、保存首轮结果，再将下一轮 provider 请求停住；入口 shim 过滤 shutdown 以模拟不支持协作关闭的宿主，强制走原生树终止。SDK 关闭后用全新 CLI 恢复同一会话，实际调用 job_output，确认任务标为 error/中断、保留已保存的 stderr、不复活进程或心跳。它证明最后快照的恢复，不保证强停前尚未保存的新输出不会丢失。

定向首组四文件 31 项通过；扩展到 12 项进程矩阵后通过，恢复场景也已单独通过。最终核心集合 27 文件、351 项通过；发布包烟测通过（635 文件，8.03 MiB 解包体积）。

最终全量：256 文件通过、3,250 项通过、1 项跳过（217.06 秒）；Python 协议集 22 项通过对应 wrapper 验证，不另加到 Vitest 数量。`npm run typecheck`、`npm run check`、`npm run docs:sync -- --check` 与 `git diff --check` 均通过；原有 764 项警告，无错误。当前非测试源码 68,596 行、306 文件，测试 256 文件。

## 原生竞态与只读存活探测

并发门禁进一步发现：原生树终止的等待可能超过旧的 1.5 秒测试预算；Windows taskkill 在目标自行退出时可能返回 128，单凭退出码会误报清理失败。SDK 输入生命周期用例现在允许 8 秒等待，覆盖原生终止和实际退出的有界期限，仍会拒绝无限挂起的输入源；它没有取消进程存活断言。

对 taskkill 的非零结果逐行提取首个行动目标 PID，父级 PID 仅供诊断，不能拿 SDK 宿主作为终止目标；根进程已消失时还核验诊断中引用的根 PID。只有已报告目标均不再运行，才将部分失败判作已收尾；仍活着或无可核验目标时报告错误。`owned-process.test.ts` 三项使用模拟的原生诊断与真实存活/退出进程，覆盖根进程竞争、父 PID 排除和仍存活目标不得被成功掩盖。

中途 Python 探测暴露平台差异，已改用只读 Win32 进程句柄和零超时 WaitForSingleObject。不能把 Python 的 `os.kill(pid, 0)` 当成 Windows 存活查询，其 Windows 分支使用终止 API，见 [Python os.kill](https://docs.python.org/3/library/os.html#os.kill)。进程对象结束后会进入 signaled 状态，零超时等待立即返回，见 [WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)。采用进程状态而非退出码 259，避免已退出进程被误判为仍运行，相关注意见 [GetExitCodeProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess)。新 Python 回归验证探测不终止存活进程，并识别退出码 0/259；协议总集合现为 22 项，其中客户端文件 17 项已单独通过。

原生竞态修复后的五文件 29 项通过，包含 13 项 SDK 树验收与三项原生结果核验。随后完成 Windows 只读探测的状态 API 调整，客户端 17 项继续通过；最终门禁另行确认。

## 受影响文件

新增：`D:/AI项目/claude_personal/src/utils/owned-process.ts`、`D:/AI项目/claude_personal/src/__tests__/sdk-process-tree.test.ts`、`D:/AI项目/claude_personal/src/__tests__/owned-process.test.ts`、本文。

修改：`D:/AI项目/claude_personal/src/sdk.ts`、`D:/AI项目/claude_personal/src/headless.ts`、`D:/AI项目/claude_personal/src/headless-control.ts`、`D:/AI项目/claude_personal/src/__tests__/headless-control.test.ts`、`D:/AI项目/claude_personal/src/__tests__/sdk-input-lifecycle.test.ts`、`D:/AI项目/claude_personal/src/__tests__/sdk-python.test.ts`、`D:/AI项目/claude_personal/python/ccr_sdk.py`、`D:/AI项目/claude_personal/python/test_ccr_client.py`、`D:/AI项目/claude_personal/package.json`，以及核心计划、架构、维护、使用指南、局限、总览和日志索引。

定位：`src/sdk.ts:131` 的关闭请求、`src/sdk.ts:229` 的收尾与 feeder 异常路径；`src/headless.ts:201` 输入泵关闭、`src/headless-control.ts:62` shutdown handler；`python/ccr_sdk.py:325` 的树终止与 `python/ccr_sdk.py:386` 的 disconnect，Windows 探测见 `python/ccr_sdk.py:15`。

## 保留边界

后续[工程任务门禁](20261112-repository-task-evaluation.md)又复现原生 taskkill 非零返回码 255，现对非零数值返回均以实际报告目标的存活状态核验，补充 128/255 回归，避免将单次 OS 样本写成固定返回码契约。

Windows 普通自有进程树已本机实测；Unix 实现保留在相同契约路径，但不能把本机结果表述为 Linux/macOS 已实测。树枚举与终止不是原子 containment：已被外部杀掉的 CLI、主动重设父关系/脱离的后代、持续 fork 的竞争窗口以及 OS 拒绝终止仍需要更强的宿主监督机制。任意外部 SIGKILL 不在本轮保证内。

硬停止不会执行 CLI finally 或保存最终 killed；新进程将最后快照中的 running 标为中断。正常结束仍使用清理后保存的 terminal 记录。Shell 修改仍不进入 checkpoint；本轮没有调用付费 provider，不构成编码效果等价证明。
