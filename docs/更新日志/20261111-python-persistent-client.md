# Python 持续会话客户端

> 日期：2026-11-11
> 类型：feature / test
> 模块：Python SDK / 发布包
> 状态：实现与流程验收已落地
> 关联 commit：本次工作区改动
> 关联文档：[核心引擎计划](../20261111-core-engine-plan.md)、[SDK 使用](../深度使用指南.md)

## 缺口与实现

此前 Python 只有一次性 async iterator，不能在同一个客户端中持续提交任务或发出 interrupt / set_model / set_permission_mode。新增协议验收首先实际失败于无法导入 `CCRClient`。

新增本项目独立 `CCRClient`，以 async context manager 或显式 connect/disconnect 管理本地 CLI。query 提交用户回合，receive_response 读到一个 result，receive_messages 读到进程结束。控制方法通过独立后台读取任务应答，消费者暂停时也可以等待 RPC，不需要另开消费者。

一次性 query 复用客户端，保留原参数和结果帧之后的退出诊断。finish 表示输入结束，所有已提交回合都有结果后才关闭 stdin，审批与控制不会提前失去写通道。控制请求默认超时 60 秒，非法回复、超时和进程关闭分别拒绝对应请求；一个客户端只允许一个消息消费者，避免不同调用者互相偷取结果。

每个回合终止取消所属审批，epoch 检查抑制吞掉 CancelledError 的回调迟到答复。disconnect 取消工作、拒绝 RPC，先关闭 stdin 等待正常 EOF 清理，1 秒后仍未退出才 terminate，再过 1 秒升级 kill 并继续限时等待。新增回归曾实际复现立即 terminate 导致 CLI 的 EOF 清理标记丢失，修复后验证标记落盘。stderr 持续排空但仅保留尾部 8,000 字节；退出缺少结果时显式报错。非法嵌套控制信封成为诊断，读取继续。

## 验收证据

- `python/test_ccr_client.py`：15 项真实 Node 子进程协议验收，覆盖同进程多回合、失败后继续、控制切换、消费者暂停时中断、审批往返、吞取消后的迟到答复、RPC 超时/非法回复后恢复、非法嵌套帧、挂起 RPC 关闭、正常 EOF 清理、忽略 EOF/SIGTERM 的终止升级、排队输入结束、异常退出、缺少结果、stderr 尾部及多消费者互斥（部分场景在同一用例中联合验证）。
- 原一次性 SDK 5 项保持通过，Python 独立套件合计 20 项。Vitest 桥接计为一个测试，内部数量不重复加进全量总数。
- `sdk-python.test.ts` 新增真实源码 CLI + 本地 HTTP provider 场景：第一轮 Write 审批挂起→interrupt→取消回调→同进程下一轮切换模型和权限→SDK 重写目标并实际写入 approved.txt→关闭→新客户端按 session_id 恢复。验收检查未批准路径不存在、实际文件内容、回合 session_id 一致、provider 模型字段切换、恢复请求携带前轮用户和助手记录。未调用付费 provider。
- `scripts/package-smoke.mjs` 实际导入解包后的 Python 模块，使用默认 CLI 路径执行模型/权限控制往返和正常 EOF；没有 Python 的环境明确输出跳过。
- 相关 TS 四文件 19 项通过；发布包烟测通过（622 文件，7.99 MiB 解包体积）。最终全量和核心集合结果见下方补记。

初次并行核心门禁中，RPC 测试的 100ms 超时低于子进程启动与调度开销，非法回复断言之前先发生超时；测试改为 2 秒，仍实际验证无响应请求超时和后续会话恢复。

## 最终门禁

- Python 独立 20/20 通过；Vitest SDK/CLI 四文件 19 项通过。
- 固定核心集合 18 文件、260 项通过；全量 248 文件、3,170 项通过、1 项跳过。
- `npm run typecheck`、Python py_compile、`npm run check`、发布包烟测、`npm run docs:sync -- --check` 与 `git diff --check` 通过；格式检查有仓库原有 764 项警告，无错误。新增发布包脚本片段通过单独 Biome 检查。

## 边界

后续[TS 输入生命周期验收](20261111-ts-sdk-continuity.md)补充发现两端 EOF 都会继续执行排队回合：当前 disconnect 仅在已发送回合均有结果时允许正常 EOF 清理，未完成时直接终止；Python 内部套件因此扩为 21 项，上述 20 项是本阶段历史门禁。

本客户端不承诺官方 Python SDK 全部接口、内嵌 MCP / hooks 等未实现的控制消息。模型切换继续受当前 provider/路由配置约束。用户回调取消仍是协作式，迟到回复会被抑制；无法强行终止在 Python 代码中主动拒绝取消的任务。disconnect 管理自有 CLI，不等同于任意 Shell 后代进程树收尾。本阶段尚未覆盖的 TS 多轮输入源取消已在后续 TS 记录补齐，重复终止帧仍需继续验收。
