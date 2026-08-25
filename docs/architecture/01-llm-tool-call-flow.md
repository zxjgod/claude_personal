# 01 · LLM 接入与 Tool-Use 调用流

> 基于 Claude Code 2.1.88 恢复源码（`src/`）分析。本文回答：**API 如何被调用、工具定义如何传给模型、tool_use 如何解析/调度/拼回、loop 的终止条件、权限检查在链路中的位置。**

---

## 1. 分层架构总览

```text
REPL.tsx / print.ts / AgentTool / forkedAgent / execAgentHook
        │  （5 个入口共用同一个 loop）
        ▼
QueryEngine.submitMessage()        src/QueryEngine.ts:209   ← SDK/headless 包装：
        │                                                    会话状态、transcript 落盘、结果产出
        ▼
query() → queryLoop()              src/query.ts:219, 241    ← 核心 agent loop
        │  while(true)：compact → 组包 → 流式调模型 → 收 tool_use → 执行工具 → 拼回
        ▼
QueryDeps.callModel                src/query/deps.ts:21
  = queryModelWithStreaming        src/services/api/claude.ts:752
        ▼
queryModel()                       src/services/api/claude.ts:1017
        │  schema 构建 / 消息 normalize / system 组装 / beta 头 / 缓存断点
        ▼
withRetry(getAnthropicClient, …)   src/services/api/withRetry.ts:170
        ▼
anthropic.beta.messages.create({...params, stream: true}).withResponse()
```

**关键事实：`query()` 是整个产品唯一的 agent loop** —— 交互 REPL、SDK/headless、子代理、fork、hook agent 全部复用它。子代理 = 递归调用同一个 `query()`。

---

## 2. LLM API 调用方式

### 2.1 SDK 与流式

- 官方 `@anthropic-ai/sdk` beta 命名空间；客户端工厂按 env 在 Anthropic / Bedrock / Foundry / Vertex 四 provider 间切换（`src/services/api/client.ts:88`）。
- **SDK 自带重试被关闭（`maxRetries: 0`），重试完全由自研 `withRetry` 接管**：401 刷新 OAuth、ECONNRESET 关 keep-alive、429/529 读 Retry-After、连续 529 触发 `FallbackTriggeredError` 换 fallback 模型。
- 用 raw `Stream` 而非 `BetaMessageStream`，避免 O(n²) 的 partial JSON 解析（`claude.ts:1822`）。
- 流中途失败默认**降级为非流式重发整个请求**。

### 2.2 请求参数构造（`claude.ts:1538-1728`）

```ts
{
  model,
  messages: addCacheBreakpoints(messagesForAPI),  // 恰好一个 cache_control 打在最后一条消息
  system,                                          // TextBlockParam[]，静态段打缓存、动态段不打
  tools: allTools,                                 // 按名排序保证 prompt cache 字节稳定
  tool_choice: undefined,                          // 主循环固定 auto
  betas,                                           // interleaved-thinking 等
  max_tokens,
  thinking,                                        // 开启时不发 temperature（API 要求 temperature=1）
  temperature,                                     // 仅 thinking 关闭时
  metadata,                                        // 请求链追踪
}
```

### 2.3 system prompt 组装

三段式（`src/utils/queryContext.ts:44`）：

1. **systemPrompt**：静态段（角色/工具使用/语气等）+ `DYNAMIC_BOUNDARY` 标记 + 动态段（memory、env、output style）；发送时按边界切成最多 4 个 TextBlock，**静态部分打 `cache_control: ephemeral`**；
2. **userContext**（cwd、平台、日期、CLAUDE.md）：包成 `<system-reminder>` 的 **isMeta user 消息**插到消息头部 —— 不改 system prompt，**保 prompt cache**；
3. **systemContext**（gitStatus）：以 `key: value` 行追加为最后一个 system 块。

---

## 3. 工具定义如何传给模型

```ts
// src/utils/api.ts:119 toolToAPISchema
{
  name: tool.name,
  description: await tool.prompt(...),        // 工具自述 prompt（写得好坏直接影响调用质量）
  input_schema: tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema),  // 内建 zod / MCP 直接 JSON Schema
}
```

- 工具池组装：`getTools()` 先按 **deny 规则整工具过滤**（被 deny 的工具根本不出现在 prompt 里），再过 `isEnabled()`；内建与 MCP 工具**各自按名排序后拼接**（prompt cache 稳定）；
- schema 会话级缓存，防止实验开关翻转导致 tools 字节抖动击穿缓存。

### 工具接口最小形状（`src/Tool.ts:362` 提炼）

```ts
type Tool = {
  name: string
  inputSchema: zod | JSONSchema        // 执行前 safeParse 再校验一次（模型常生成非法输入）
  prompt(): Promise<string>            // → API description
  call(input, ctx, canUseTool, parentMessage, onProgress): Promise<{ data }>
  isConcurrencySafe(input): boolean    // 并发调度唯一依据
  isReadOnly(input): boolean
  checkPermissions(input, ctx): Promise<PermissionResult>  // 工具自带权限逻辑
  mapToolResultToToolResultBlockParam(data, toolUseID): ToolResultBlockParam
  maxResultSizeChars: number           // 超限结果落盘、模型拿预览
}
```

---

## 4. tool_use 的解析、调度与拼回

### 4.1 流内解析（不信任 SDK 可变 block，手工累加）

- `input_json_delta` → **字符串拼接** `input += delta.partial_json`；
- `content_block_stop` → `JSON.parse` input（失败兜底 `{}`）→ **每个 block 各 yield 一条独立 AssistantMessage**（共享同一 `message.id`，下游按 id 合并）；
- `message_delta` → 真实 `usage`/`stop_reason` **直接 mutate** 到最后一条 assistant 上（transcript 队列持有引用，必须原地 mutation）。

### 4.2 调度：两条路径

**路径 A · StreamingToolExecutor（边下边跑）**：assistant 每到达一个 tool_use 块立即入队尝试执行：

- `canExecuteTool`：无执行中工具，或全部 `isConcurrencySafe`（读类）才可并发；非安全工具独占且保序；
- 每工具挂**子 AbortController**；Bash 出错级联取消兄弟工具，未跑的兄弟收**合成 error tool_result**；
- 结果按到达顺序缓冲，progress 消息走独立通道即时 yield。

**路径 B · runTools（流完统一跑，`toolOrchestration.ts:19`）**：`partitionToolCalls` 把序列切成批 —— 连续只读工具合并为并发批（默认上限 10），其余每工具单独串行批。

**最小实现选路径 B 的串行子集即可**（见 `tool/mini-agent/src/agent.js`）。

### 4.3 拼回与下一轮

```ts
// query.ts:1715-1727 —— 循环接续方式
state.messages = [...messagesForQuery, ...assistantMessages, ...toolResults]
```

每个工具产出一条 user 消息，content 为 `[{type:'tool_result', tool_use_id, content, is_error?}]`。assistantMessages 存**未克隆的原始对象**保 prompt cache 字节一致。

---

## 5. 终止条件与最高不变量

**唯一循环退出信号：本轮流里是否出现过 tool_use 块**（`needsFollowUp`）。注释明确说 `stop_reason === 'tool_use'` 不可靠，不采信。

| 终态 reason | 语义 |
|---|---|
| `completed` | 正常 end_turn，stop hooks 通过 |
| `aborted_streaming` / `aborted_tools` | 流期间 / 工具期间被 abort |
| `model_error` / `prompt_too_long` / `blocking_limit` | API 错误 / 上下文溢出 |
| `stop_hook_prevented` | Stop hook 阻止继续 |
| `max_turns` | 轮数护栏 |

**最高不变量：任何路径退出前，已发出的每个 tool_use 都必须有配对 tool_result**。abort/异常/fallback/权限拒绝时合成 `is_error` tool_result 补齐（`yieldMissingToolResultBlocks`，query.ts:123）；发送前再做一次 `ensureToolResultPairing` 兜底。违反它 API 直接 400 且会话死锁。

权限拒绝**不终止 loop** —— 变成 error tool_result 回喂，由模型自行应对。

---

## 6. 权限检查在链路中的精确位置

单工具执行链 `runToolUse` → `checkPermissionsAndCallTool`（`toolExecution.ts:599`）：

```
0. abort 检查 → 合成 cancel tool_result
1. zod safeParse(input)            失败 → tool_use_error 回喂
2. tool.validateInput?.()
3. PreToolUse hooks                可产出 allow/deny/ask/updatedInput/preventContinuation
4. canUseTool 判定顺序：
     deny 规则 → ask 规则 → 工具自身 checkPermissions
     → 模式（bypass/plan/auto/dontAsk）→ allow 规则 → 默认 ask
   （hook allow 不能绕过 deny 规则）
5. deny → is_error tool_result 回喂，不执行，不中断 loop
6. allow → tool.call(updatedInput ?? input)
7. 成功 → mapToolResultToToolResultBlockParam → PostToolUse hooks
8. 异常 → PostToolUseFailure hooks + is_error tool_result
```

REPL 的 `ask` = 把确认项推入队列、返回挂起 Promise，用户点击后 resolve —— **工具执行生成器在此期间自然挂起**，不需要显式"等待权限"状态。

---

## 7. 流式事件的逐层 yield

```text
Anthropic SSE ──► SDK Stream<RawMessageStreamEvent>
   ▼
queryModel (claude.ts:1017)
   │  每个原始 part → yield { type:'stream_event', event, ttftMs }   ← 零加工透传
   │  每个 content_block_stop → yield 一条 AssistantMessage
   │  message_delta → 就地写回 usage/stop_reason
   ▼
query loop (query.ts:659)
   │  stream_event → 原样透传 yield 给上层（UI 逐字渲染靠它）
   │  assistant → 收集 tool_use + addTool
   │  可恢复错误（413/max_tokens）→ withhold 不 yield
   ▼
QueryEngine.submitMessage (QueryEngine.ts:675)
   │  映射为 SDKMessage；usage 记账；max_turns → result(error_max_turns)
   ▼
SDK 消费者 / print.ts / REPL
```

全链路 **async generator**，`yield*` 委托 + `for await` 天然提供背压；取消沿 generator 的 `.return()` 传播（配 `try/finally` 释放 HTTP 资源）。

---

## 8. 核心不变量清单（复刻时逐条对照）

1. **整条链路 async generator，事件即接口**：`callModel` 产出 `StreamEvent | AssistantMessage`，原始流事件零加工透传 + 每 block 完成时 yield 结构化消息。
2. **退出信号 = 本轮是否出现 tool_use 块**，不看 stop_reason。
3. **tool_use/tool_result 严格配对**：任何提前退出都要合成 error tool_result 补齐。
4. **消息追加顺序**：`[...old, ...assistant(本轮), ...toolResults]`；连续 user 消息发送前合并（Bedrock 不允许）。
5. **thinking 三规则**：含 signature 原样回传 / 不在消息末尾 / 跟随 assistant 轨迹；thinking 开启时不发 temperature；`budget_tokens < max_tokens`。
6. **权限可注入**，位于 hooks 之后、call 之前；拒绝 → error tool_result，不中断 loop。
7. **normalize 边界**：内部消息模型（isMeta/isVirtual/progress）与 API 消息模型分离，发请求前一次性 normalize。
8. **错误即消息**：API 错误、max_tokens、权限拒绝都建模为合成消息流进同一条管道。
9. **可测试性 seam**：`callModel`/compact 收进 `deps` 对象，可替换（mini-agent 的 mock 模式就靠这个）。

---

## 附：关键代码位置速查

| 主题 | 位置 |
|---|---|
| 主循环 | `src/query.ts:219`（query）、`:241`（queryLoop）、`:659`（callModel）、`:1380`（工具执行）、`:1715`（下一轮 state） |
| 会话封装 | `src/QueryEngine.ts:209`、`:675` |
| API 调用 | `src/services/api/claude.ts:1017`（queryModel）、`:1822`（create stream） |
| 请求参数 | `src/services/api/claude.ts:1538`（paramsFromContext） |
| 工具 schema | `src/utils/api.ts:119`（toolToAPISchema） |
| 工具池 | `src/tools.ts:271`（getTools）、`:345`（assembleToolPool） |
| 工具执行链 | `src/services/tools/toolExecution.ts:337`（runToolUse）、`:599`（checkPermissionsAndCallTool） |
| 并发调度 | `src/services/tools/toolOrchestration.ts:19`（runTools）、`StreamingToolExecutor.ts:40` |
| 补齐孤儿 tool_result | `src/query.ts:123`（yieldMissingToolResultBlocks） |
| normalize | `src/utils/messages.ts:1989`（normalizeMessagesForAPI）、`:5133`（ensureToolResultPairing） |
| 权限 | `src/utils/permissions/permissions.ts:473`、`:1158` |
| thinking | `src/utils/thinking.ts:10`、`src/services/api/claude.ts:1596-1630` |
