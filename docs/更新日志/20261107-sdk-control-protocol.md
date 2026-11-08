# 2026-11-07 SDK 控制协议与权限审批通道

## 背景

差距评估（20261002）第三批"自动化契约"方向：headless 的 stream-json 输入原先
由 turn 循环逐条拉取，turn 运行期间不读 stdin，无法中断或应答审批；权限询问一律
自动拒绝；TS/Python SDK 没有任何控制协议。本轮补齐官方 Agent SDK 形状的核心
控制协议子集。

## 实现

### CLI（`--permission-prompt-tool stdio`）

- 新增 `--permission-prompt-tool`（官方同名 flag）。仅支持 `stdio`；MCP 权限工具
  点名拒绝。要求 input/output 均为 stream-json，否则启动即报错（走 failFast，
  仍有终帧）；交互模式（非 `-p`）传入直接报错退出（该 flag 在 TUI 是死配置，
  不静默忽略）。不设该 flag 时审批自动拒绝，行为与旧版完全一致。
- stream-json 输入改为独立泵（`headless.ts` 的 `streamJsonPrompts`）：读任务
  持续运行，控制帧在 turn 执行中即时处理，用户消息排队按序成 turn。EOF 关闭
  队列并把挂起审批全部拒绝（fail-closed，不会挂死）。
- 新增 `headless-control.ts` 控制通道：
  - CLI→对端：`control_request{can_use_tool}`（tool_name/input/
    permission_suggestions/decision_reason），等待匹配 `control_response`。
  - 对端→CLI：`initialize`（应答 commands/models）、`interrupt`（中止当前
    turn 的 AbortController，仍发 result 终帧）、`set_model`（改配置并重解析
    已知单价）、`set_permission_mode`（校验六模式并热切换）；未知 subtype 应答
    error 帧而不是崩溃。
- 审批应答支持 `updatedInput`：先经工具 `validateInput`、工具权限与全局权限策略
  复查，再就地改写执行输入（checkPermission 与执行器共享同一对象引用）。
  中央权限询问（Step-6 标准审批与危险模式安全底线）都支持改写，两条路径都会对
  改写后的输入重跑完整权限复查；工具内部审批的改写应答按拒绝处理，避免原参数
  未经复查继续执行。
  `deny.interrupt:true` 会同时中止当前 turn。审批等待无超时；EOF/会话结束拒绝。

### TypeScript SDK（`src/sdk.ts`）

- `QueryOptions.canUseTool(toolName, input, {signal, suggestions})`：设置时自动
  传 `--permission-prompt-tool stdio`；回调抛错应答 error 帧（CLI 侧拒绝）。
- `query()` 返回 `Query`（AsyncGenerator 附加方法）：`interrupt()`、
  `setPermissionMode(mode)`、`setModel(model)`，60s 超时，进程退出/生成器关闭
  时拒绝挂起请求。迭代开始前调用控制方法报明确错误。
- 读取循环改为独立读任务 + 消息队列：消费者在消息循环里 `await q.interrupt()`
  不会死锁（控制应答由读任务独立处理）。控制帧不作为消息 yield。
- stdin 生命周期：输入耗尽且每个已发 prompt 都收到 result 帧后才关闭（CLI
  保证每 turn 一个 result 帧），运行中控制方法因此可用。
- spawn 保持懒加载（首次迭代才启动子进程），未消费的 query 不泄漏进程。

### Python SDK（`python/ccr_sdk.py`）

- 修复一个**先于本轮存在**的语法错误：原文件 try 块主体被错误去缩进，
  `py_compile` 从未通过——该 SDK 此前实际上无法运行。
- 新增 `can_use_tool` 异步回调（审批应答逻辑与 TS 一致，回调在独立 task 中
  执行不阻塞读循环）与 `cli` 入口覆盖参数（对应 TS `cliModule`）。
- 有回调时 stdin 保持到 result 帧；消费端退出时取消挂起的回调 task。

## 明确偏差

- `can_use_tool` 帧的 `permission_suggestions` 恒为空（本项目没有规则建议
  生成器）；`decision_reason` 携带的是风险说明文本；无 `tool_use_id`/
  `agent_id`（AskUserFn 签名不含）。
- 未实现官方其余控制消息：`hook_callback`、SDK 内嵌 MCP 服务器
  （`mcp_message`）、`rewind_files`、`seed_read_state` 等；收到不支持的
  subtype 应答 error 帧。
- Python `query()` 仍无 `interrupt()` 方法（官方 Python SDK 同样由独立的
  ClaudeSDKClient 类承担双向会话；本轮未新增该类）。
- `set_model` 的"省略 model 字段 = 重置默认模型"语义未实现：CLI 应答 error 帧
  （不是静默成功），TS SDK 需传显式模型名；空/空白模型名同样应答 error。
- `initialize` 应答的 `commands` 恒为空、`models` 仅含当前模型单元素（官方语义是
  可用命令/模型列表，本项目没有对应的清单来源），对端不应按列表语义消费。

## 验证

- `src/__tests__/headless-control.test.ts`（10 例）：allow/deny/updatedInput、
  EOF 拒绝、flag 门控与非法值、interrupt 中断运行中 turn、initialize/
  set_model/set_permission_mode/未知 subtype、多 prompt 顺序成 turn。
- `src/__tests__/sdk.test.ts`（新增 5 例）：fixture CLI 上的 can_use_tool
  往返、回调抛错 fail-closed、运行中 interrupt、setModel/setPermissionMode、
  迭代前控制方法报错。
- `src/__tests__/cli-control-e2e.test.ts`：真实 CLI（tsx）+ 本地 HTTP fixture
  provider，模型调用 Write → 默认模式挂起 → 控制协议批准 → 文件落盘、
  result 成功、进程退出 0。
- `python/test_ccr_sdk.py`（3 例，Node fixture 无需 provider）；由
  `sdk-python.test.ts` 接入 vitest（无 Python 环境时跳过）。
