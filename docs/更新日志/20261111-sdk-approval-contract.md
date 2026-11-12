# SDK 委派审批、回调生命周期与输出契约

> 日期：2026-11-11
> 类型：fix / test
> 模块：权限 / Headless / TS SDK / Python SDK / 评估器
> 状态：修复与流程验收已落地，最终门禁见下
> 关联 commit：本次工作区改动
> 关联文档：[核心引擎计划](../20261111-core-engine-plan.md)、[SDK 使用](../深度使用指南.md)

## 复现与修复

1. **委派重写失效**：真实 TS SDK → 源码 CLI → 本地 fixture provider → Agent → Write，直接审批重写能落盘，委派时 approved.txt 不存在。`createSubAgentApprover` 只传三个参数，丢了第四个 requestContext，Headless 因无法确认实际输入来源而拒绝重写。现在完整透传。
2. **子代理限制漏检**：透传后补验子代理更严格的 deny 规则，发现 SDK 将候选路径改成 child/blocked.txt 时实际写入。Headless 原来用父 context 复核。中央权限询问现在携带仅本地使用的执行 ToolContext，Headless 在该上下文下重跑权限及工具策略；该引用不进入控制帧。两层审批包装后的正常和 deny 场景均验证实际文件状态。
3. **挂起审批跨回合存活**：TS 收到结果帧后，回调 signal 尚未取消；Python 同样只在生成器最终关闭时取消任务。现在 TS 在结果帧到达时 abort 对应回调，并抑制迟到的答复；Python 取消挂起 task。两种 SDK 都有在消费者尚未继续迭代/关闭时观察取消的回归。Python 旧代码的独立复现实际失败于 `cancelled.is_set() == False`。
4. **早退进程未收尾**：消费者提前关闭 TS 查询时只发送 kill，没有等待 close，独立 CLI fixture 导致 Windows 临时目录删除 EPERM。现在等候实际关闭，1 秒后升级 SIGKILL，再等 1 秒；仍未关闭则报错，并保留原错误 cause。验收检查 query.return 完成后 PID 已退出；Unix fixture 会忽略 SIGTERM，从而覆盖升级路径。
5. **输出信封与诊断类型**：null、数组、字符串和缺 type 对象原来分别导致 TS/Python 读取崩溃；Python 非 JSON stdout 诊断还带 bytes，无法 json.dumps。现在两端产生文本诊断并继续读取合法结果；非法信封使用 `invalid_protocol_message`，Python 非 JSON 消息也保持 str。TS 控制回复仅允许 success/error，缺失或未知 subtype 立即拒绝 RPC。
6. **评估漏判异常退出**：SDK 已发出 abnormal_exit，但评估器只检查早先的成功 result。新回归实际得到 passed=1（预期 0）；现在将结果帧之后的异常退出计为失败，同时保留已有 usage。

## 验收覆盖

- `sdk-delegated-approval.test.ts`：两个真实 SDK/CLI/HTTP fixture 场景，直接与 Agent 委派审批重写均实际落盘。无需真实 API key。
- `headless-delegated-policy.test.ts`：两层受限审批包装，验证允许重写与 child deny，按实际文件状态和工具结果判断。
- `sdk.test.ts`：8 → 13 项，新增结果帧取消、进程归属收尾、非法消息信封，以及两种非法 RPC subtype。
- Python 独立协议测试：3 → 5 项，包括回调取消和可 JSON 序列化的输出诊断；Vitest 桥接仍为一个用例，不能把 Python 内部五项重复加进总数。
- `evaluation.test.ts`：12 → 13 项，新增成功 result 后 abnormal_exit 失败判定。

本轮使用真实本地进程、真实 SDK/CLI 和 HTTP fixture 验证契约，未调用付费 provider；模型任务质量测量继续沿用已有独立套件。

## 最终门禁

- 审批 / SDK / 权限 / 委派相关七文件 86 项通过；最终 SDK/CLI 四文件 18 项通过，Python 独立 5/5 通过。
- `npm run typecheck`、Python py_compile、`npm run check` 通过；格式检查仍报告仓库原有 764 项警告，无错误。
- 全量：248 个测试文件通过，3,169 项通过、1 项跳过；固定核心集合：18 文件、259 项通过。
- `npm run smoke:package` 通过，实际打包并解包验证 622 个文件，解包体积 7.98 MiB。

## 文件与边界

修改：`src/utils/subagent-security.ts`、`src/types.ts`、`src/permissions.ts`、`src/headless.ts`、`src/sdk.ts`、`python/ccr_sdk.py`、`scripts/evaluation.mjs`，相关 TS/Python 测试与文档。新增两个审批测试文件与本文。SDK 相关测试纳入固定核心验收。

TS 回调取消是协作式 AbortSignal；忽略信号的用户回调可能继续运行，但 SDK 不再发送其迟到的决策。Python 客户端当前仍为单查询 async iterator，未增加双向会话客户端。进程收尾验收覆盖 SDK 拥有的 CLI，真实 Shell 子进程树仍需独立验收。非法字节、嵌套控制信封、重复结果帧等边界还需要继续覆盖。
