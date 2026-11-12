# TypeScript SDK 输入生命周期与连续会话

> 日期：2026-11-11
> 类型：fix / test
> 模块：TS SDK / Headless 验收
> 状态：实现与最终门禁已通过
> 关联 commit：本次工作区改动
> 关联文档：[核心引擎计划](../20261111-core-engine-plan.md)、[SDK 使用](../深度使用指南.md)

## 实际复现

新增输入生命周期测试首轮 4 项中 3 项失败：

1. CLI 已发 result 并退出，prompt producer 正在等待下一条输入；SDK 仍 await feeder，后续读取 1.5 秒内不结束。
2. 消费者已有等待中的 next，再调用 return；原生 async generator 会把 return 排在 next 后面，无法触发清理。放行迟到输入后，fixture 的实际文件记录为 `first\nlate\n`，证明用户停止之后仍发送了内容。
3. 已提交用户请求，CLI 直接退出 0 且没有 result；查询静默结束，原回归预期失败却得到成功。

原输入 producer 报错测试保持通过；随后增加 undefined rejection，防止读取循环的 truthy 检查再次把错误当作正常结束。

最后核验 EOF 清理时，TS 与 Python 各新增一项实际副作用验收：尚未完成的排队任务在收到 EOF 后继续执行，`queued-effect` 文件实际出现。两端均改为空闲时才允许 EOF 清理，未完成时直接终止 CLI；不能把 EOF 当成取消队列。

## 修改

- 输入循环显式持有 iterator，将 next 与本地停止信号竞速；CLI close、stdout 结束、外部 signal、query 关闭均结束输入循环。竞速后的二次检查阻止迟到输入写入。
- 提前结束时请求 iterator.return，吞掉清理错误但不覆盖查询原错误；不无限等待不合作的 producer。标准 async generator 无法强行中断任意 await，应用仍需关闭自己持有的等待资源。
- return/throw 包装器立即标记关闭、取消审批、拒绝挂起 RPC 并唤醒输出循环，再交由原生成器完成终结，能释放已等待中的 next。
- stdin 背压等待在 drain/close/error/abort 任一路径移除其他监听器；输入失败保留原始原因，读取循环使用独立失败标记，保留 undefined 等拒绝原因。
- CLI 正常退出仍核对每个已发送 prompt 的结果数量；缺失结果时失败。断开时，已发送回合均有结果才等 EOF 清理 1 秒，否则直接 terminate；仍未退出则升级 SIGKILL，每步限时等待。Python 持续客户端同步采用此规则。

## 验收

- `sdk-input-lifecycle.test.ts`：10 项真实 Node 子进程用例，覆盖三个已复现问题、producer 错误与 undefined、throw、外部 abort、不合作 return、空闲 EOF 清理标记、未完成任务不通过 EOF 继续执行。
- `sdk-session-continuity.test.ts`：真实 TS SDK → 源码 CLI → 本地 HTTP provider。第一轮 Write 审批挂起后 interrupt；同一查询的第二轮切换模型/权限、重写目标并实际落盘；正常结束后启动新 CLI 按 session_id 恢复，并通过 Read 工具读回文件。检查 session_id 一致、未批准路径不存在、恢复请求携带前轮用户/助手历史，以及最后 Read 的工具结果确有批准内容。又提交两个排队回合，等待第二轮模型请求已开始后释放其写文件响应并关闭 query；在 bypassPermissions 下验证未发生文件写入，避免审批拒绝掩盖取消行为。测试不调用付费 provider。
- SDK 相关五文件 28 项通过。Python 独立套件新增未完成队列关闭验收，当前共 21 项（Vitest 桥接仍只计一项）。两份新 TS 测试纳入固定核心集合。

## 最终门禁

- 全量 250 文件通过，3,181 项通过、1 项跳过；核心集合 20 文件、271 项通过。
- SDK 五文件 28 项通过；真实 CLI 的排队关闭场景补充后单独复验通过。Python 内部 21 项由桥接执行，不重复计入 Vitest 总数。
- `npm run check`、`npm run typecheck`、Python py_compile、`npm run docs:sync -- --check`、`git diff --check` 通过；仓库原有 764 项警告，无格式检查错误。
- `npm run smoke:package` 通过，实际打包解包 624 个文件，解包体积 8.00 MiB，验证两端 SDK 的包内默认入口。

## 边界

本轮未实现重复终止帧去重。暂停的 JS producer 内部 await 仍由调用方管理；SDK 只保证不再等待/拉取/发送其迟到输入，并请求迭代器清理。退出核对只证明协议终止完整，不能替代业务验收或真实模型效果测量。Shell 子进程树与并发会话冲突仍需继续验收。
