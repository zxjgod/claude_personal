# 架构审查分册 02 — LLM 接入层与系统提示

> 审查日期：2026-09-25 · 方式：只读代码深度探查（未修改任何文件）
> 范围：`src/llm-adapter.ts`、`src/anthropic-adapter.ts`、`src/provider-profiles.ts`、`src/cloud-gateway.ts`、`src/cli-config.ts`、`src/cli-env.ts`、`src/system-prompt.ts`、`src/output-style.ts`、`src/types.ts`（消息/工具类型部分）；交叉验证了 `agent-loop.ts`、`error-recovery.ts`、`prompt-cache.ts`、`tui/effort.ts`、`token-estimator.ts`、`cli.ts`、`cli-repl.ts`、`.env.example`。
> ⚠️ 行号基于审查当日代码（v1.5.0）。后续编辑会造成漂移，引用前先用符号名 grep 重新锚定。
> 总纲见 `docs/架构分析与升级总纲-202609.md`。

> ✅ **修复标注（2026-09-26）**：本册涉及的 Top10 项已落地——#3（§5A：
> `error-recovery.ts` 提取 `CONTEXT_LENGTH_RE` 补 Anthropic 措辞 "prompt is too
> long"，`isFallbackableModelError` 对超限返回 false；`llm-adapter.ts` 的死重复
> `isContextLengthError` 已删除并留防再犯注释；基线共享函数 `providerPromptTokens`
> /`estimateContextUsed` 落 `token-estimator.ts`，`tui/run.tsx` 本地副本已删）、
> #10（§5D：系统提示工具段缩为短 description 一行式索引 + name codepoint 排序 +
> 工具集指纹 memoize；API tools 参数保留 promptDescription 全文为唯一权威）。
> 本册其余建议（默认模型保鲜、错误去字符串化、超时模型、effort 门控、缓存断点
> 升级、类型建模等）未动。正文为审查时点快照，未改写。

---

## 1. 模块清单

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `src/types.ts` | 739 | 全部核心类型。消息采用 **OpenAI 风格的统一中间格式**：`Message = UserMessage \| AssistantMessage \| ToolResultMessage \| SystemMessage`（L24）；`ToolCall.function.arguments` 是 JSON 字符串（L96-103）；`ThinkingBlock/RedactedThinkingBlock` 为 Anthropic 专用回传块（L81-91）；`StreamEvent` 统一流事件（L447-477）；`ModelCaller` 是唯一的 provider 抽象接口（L733-739）；`Tool` 接口带 `promptDescription`/`inputSchema`/`maxResultSizeChars` 等（L337-422） | `Message`, `ContentBlock`, `ToolCall`, `Tool`, `ModelConfig`, `ModelCaller`, `StreamEvent`, `LoopEvent`, `TerminalReason` |
| `src/llm-adapter.ts` | 383 | OpenAI 兼容路径的流式 caller + provider 注册表 + 工厂 + 错误分类 | `PROVIDER_CONFIGS`/`PROVIDER_DEFAULTS`（L21-53）、`createModelCaller`（L314-320）、`resolveProviderConfig`（L351-381）、`isRateLimitError` 等四个错误探测（L330-347） |
| `src/anthropic-adapter.ts` | 507 | 原生 Anthropic Messages API 路径：消息/工具/system 转换、cache_control 布点、流式解析、thinking 回传 | `anthropicCaller`（L262）、`formatSystemForAnthropic`（L42）、`convertMessagesToAnthropic`（L83）、`formatToolsForAnthropic`（L224）、`withMessageCacheBreakpoint`（L247） |
| `src/provider-profiles.ts` | 180 | `.claude/providers.json` 多端点预设（中转站热切换 `/provider`）+ 快模型侧信道解析 | `loadProviderProfiles`、`findProfile`、`applyProfile`（就地 `Object.assign` 变更共享 ModelConfig，L120-131）、`resolveFastModelConfig`（CCR_FAST_MODEL，L154-180） |
| `src/cloud-gateway.ts` | 72 | Bedrock/Vertex 的 OpenAI 兼容端点 URL 解析（仅拼 baseURL + 默认模型，不做 SigV4/ADC 签名） | `isCloudGateway`、`resolveGateway`（L50-72） |
| `src/cli-config.ts` | 195 | 从 env/settings 组装 `ModelConfig`；权限模式与策略解析；maxTurns；CLAUDE.md 读取 | `loadConfig`（L15-73）、`getPermissionMode`（L90-125）、`getPermissionPolicy`、`resolveMaxTurns`、`loadClaudeMd`（L188-195） |
| `src/cli-env.ts` | 215 | **模块级副作用**：两级 dotenv 加载（L29-30）；首跑引导；--version/--help | `getInstallDir`、`checkOrCreateEnv`、`maybeHandleInfoFlags`、`readPackageVersion` |
| `src/system-prompt.ts` | 313 | 缓存优先的系统提示构建器：静态 6 段 + `DYNAMIC_BOUNDARY` + 动态段；带审计的 memoize 注册表 | `buildSystemPrompt`（L254）、`renderSystemPrompt`（L311）、`DYNAMIC_BOUNDARY`（L240）、`systemPromptSection`/`DANGEROUS_uncachedSystemPromptSection`/`resetSystemPromptCache`/`listUncachedSections`（L134-164） |
| `src/output-style.ts` | 95 | 输出风格预设注册表（default/explanatory/learning + 自定义），纯文本注入系统提示 | `outputStylePrompt`（L87）、`registerOutputStyle`、`listOutputStyles` |

外围强相关模块：`tui/effort.ts`（effort 档位→双 provider 参数映射）、`prompt-cache.ts`（缓存断裂检测归因）、`token-estimator.ts`（字符比率估算）、`error-recovery.ts`（重试决策）、`utils/cancellation.ts`（AbortSignal 组合）。

---

## 2. 抽象设计

**核心接口是单一函数签名**（types.ts:733-739）：

```ts
type ModelCaller = (messages, tools, systemPrompt, config, abortSignal?) => AsyncGenerator<StreamEvent>
```

- **统一中间格式 = OpenAI 形态**。`AssistantMessage` 用 `content: string|null` + `tool_calls: ToolCall[]`（function.arguments 为 JSON 字符串），`ToolResultMessage` 用 `role:"tool"` + `tool_call_id`。OpenAI 路径几乎零转换直传（llm-adapter.ts:96-101）；Anthropic 路径做**单向翻译**：assistant 的 arguments 字符串被 `JSON.parse` 回对象成为 `tool_use.input`（anthropic-adapter.ts:148-159），tool 结果转为 user 消息中的 `tool_result` 块（L168-186），相邻同角色消息合并（L193-211）。
- **路由**：`createModelCaller(cfg)` 按 `cfg.provider === "anthropic"` 二分（llm-adapter.ts:314-320），其余 6 个 provider 全走 OpenAI 兼容 caller。cli.ts:220-221 在**每次调用时**重新 dispatch，因此 `/provider` 热切换（含跨 Anthropic↔OpenAI 家族）下一轮即生效。
- **流式是唯一路径**：没有非流式 caller。两个适配器都返回 AsyncGenerator；headless `-p` 模式也消费同一个生成器。统一事件为 `text_delta | tool_use | thinking | done | error`：
  - OpenAI 路径手工缓冲 `toolCallBuffers`（按 index 累积 arguments，L184-244），在 `finish_reason` 到达时发射 tool_use，`done` 延迟到 usage chunk（`stream_options:{include_usage:true}`，L178）。
  - Anthropic 路径用官方 SDK `client.messages.stream()`，并做了**早启动优化**：tool_use 在 `content_block_stop` 边界即发射（不等 `finalMessage()`），让 `StreamingToolExecutor` 在模型还在生成时就开始跑只读工具（L349-413）；`finalMessage()` 作为权威兜底，用 `emittedToolUseIds` 去重（L431-443）。
  - 语义归一化：Anthropic `stop_reason:"max_tokens"` 映射为 OpenAI 风格 `"length"`（L477-483），使 loop 的截断恢复路径对两个 provider 一致。
- **超时/取消**：两路径都用 `combineAbortSignals`（utils/cancellation.ts:52-73）把调用方 signal 与 5 分钟硬超时组合，超时被规范化为 `TimeoutError`（llm-adapter.ts:286-290；anthropic-adapter.ts:497-501）以便 error-recovery 走 transient 重试而非当成 Ctrl+C。
- **thinking（Anthropic 独占能力）的建模**：签名块作为 `AssistantMessage.thinking` 存储，转换时 spread-copy 放在 assistant content 最前并原样回传（anthropic-adapter.ts:131-137，types.ts:36-42 明确注释"OpenAI 路径上不存在"）；默认 `thinking:{type:"adaptive"}` + `output_config.effort`（L297-317）。

**结论**：这是"以 OpenAI 格式为中立格式的单向适配"设计，而非双格式或真正的规范中间表示（IR）。代价是 Anthropic 侧承担全部翻译成本，且 OpenAI 语义（finish_reason、tool_call_id、arguments 字符串）泄漏进核心类型。

---

## 3. 系统提示构建

**6 个静态 section**（system-prompt.ts:263-272，边界之上、可缓存前缀）：

1. `identity` — 身份 + 安全红线（L28-37）
2. `coding_rules` — 先读后改、Edit 精确替换、YAGNI、并行调用（L39-54）
3. `tool_usage` — 专用工具优先于 Bash、Glob/Grep/Read 用法、并行示例（L56-76）
4. `output_style:<name>` — 按风格名 memoize，切风格只重算这一块（L267，output-style.ts 提供文本）
5. `destructive_actions` — 破坏性操作确认清单（L82-96）
6. `AVAILABLE TOOLS` — 每工具一行 `name — promptDescription`（L98-109）。**注意 L271 直接调用、未走 memoize**，字节稳定性依赖 `toolRegistry.getEnabledTools()` 的返回顺序。

随后是 `DYNAMIC_BOUNDARY` 字面量（L240-242，跨模块契约：anthropic-adapter 用它切分放 cache_control），边界之下依次：日期 `<system-reminder>`（`DANGEROUS_uncached` 强制重算 + 必填 reason 审计，L203-210）、环境信息（cwd/platform/shell/model，L178-196）、CLAUDE.md、git 快照、语言偏好、MCP instructions（uncached，L294-300）、scratchpad。`renderSystemPrompt` 以 `\n\n` join（L311-313）。

- **工具描述双通道**：系统提示只放一行摘要；完整 JSON Schema 走 API `tools` 参数（llm-adapter.ts:299-310 / anthropic-adapter.ts:224-239）。L101-106 注释明确说明不重复 schema 是省 token 的 deliberate 决策。（⚠️ 但实际 L98-109 dump 的是**完整 promptDescription**，与 tools 参数重复，见弱点 D-④ 与分册 03 §5.5-11。）
- **CLAUDE.md**：`loadClaudeMd`（cli-config.ts:188-195，仅 workspace 根一个文件）→ cli.ts:113 → `options.claudeMdContent` → 动态段 `[PROJECT CONTEXT from CLAUDE.md]`（system-prompt.ts:280-282）。`/cd` 会重载（cli.ts:165-182）。
- **记忆不进系统提示**：MemoryStore 关键词预取（cli.ts:227-229）经 `LoopOptions.prefetch`（types.ts:631-638）在下一轮边界以 `<system-reminder>` 系统消息注入；`agent-memory` 的 MEMORY.md 只供子代理（task.ts:12）。
- **每轮重建**：cli-repl.ts:314 每 turn 调 `buildTurnSystemPrompt()`；`--append-system-prompt` 追加在尾部（cli.ts:423-424）；`/goal` 追加 `[SESSION GOAL]`（cli.ts:206-208）；effort 指令由 agent-loop 经 `withEffortInstruction` 追加在最尾（agent-loop.ts:129-131，effort.ts:164-172，含 fork 去重 regex）。所有追加都在边界之下，静态前缀保持字节稳定——这是整套设计的支点。
- Anthropic 侧 `formatSystemForAnthropic`（anthropic-adapter.ts:42-72）按边界切成两块：稳定块带 `cache_control:{type:"ephemeral"}`，动态块裸文本。

---

## 4. 配置体系

**加载优先级（高→低）**：
1. 真实环境变量（dotenv 不覆盖已设值）
2. workspace `.env`（cli-env.ts:29，per-project）
3. 安装目录 `.env`（cli-env.ts:30，全局；`getInstallDir` 由 `import.meta.url` 解析，全局安装也能找到）
4. `.claude/settings.json` 的 `env` 块（cli-config.ts:18-23，仅当 process.env 未定义时注入，实际最低）

**组装**：`loadConfig()`（cli-config.ts:15-73）读 `LLM_PROVIDER/LLM_API_KEY/LLM_MODEL/LLM_BASE_URL/LLM_MAX_TOKENS/LLM_TEMPERATURE` + settings.model，交给 `resolveProviderConfig`（llm-adapter.ts:351-381）补 provider 默认（baseURL/默认模型），并在此处集成云网关：`LLM_GATEWAY=bedrock|vertex` + region/project → `resolveGateway` 产出 baseURL，显式 `LLM_BASE_URL` 优先。`LLM_FALLBACK_MODELS` 成为同 provider 的降级链（cli-config.ts:64-71）。缺 `LLM_API_KEY` 时返回 `{} as ModelConfig` 哨兵（L39），cli.ts:102 用 `!modelConfig.provider` 拦截。

**模型选择/切换的三条运行时通道**：
- `/provider` 热切换：`applyProfile` 就地 `Object.assign` 变更所有持有者共享的 ModelConfig 引用（provider-profiles.ts:120-131）；配合 cli.ts:220-221 的 per-call dispatch，下一轮生效，无需重启。
- 快模型侧信道：`CCR_FAST_MODEL`（`provider/model` 或裸 model），同 provider 继承凭据、跨 provider 强制要求 `CCR_FAST_MODEL_API_KEY` 否则返回 null 回退主模型（provider-profiles.ts:154-180）——避免把请求发到错误主机。
- 故障降级：agent-loop.ts:504-521，仅对可降级错误（5xx/404/未知，排除 401/403/429/abort，error-recovery.ts:58-66）沿 `fallbackModels` 单调前进。

**cloud-gateway 做什么**：只是"URL 计算器"——把 Bedrock/Vertex 解析成 OpenAI 兼容 baseURL（`bedrock-runtime.{region}.amazonaws.com/openai/v1`；`{region}-aiplatform.googleapis.com/v1/projects/.../endpoints/openapi`），并给出默认模型。**不做** SigV4/GCP ADC 签名，要求用户把短时效 bearer token 塞进 `LLM_API_KEY`（文件头注释 L10-13 明说这是保持轻量的取舍）。

---

## 5. 弱点

**A. 抽象泄漏**
- 中间格式即 OpenAI 格式：Anthropic 路径把 `arguments` JSON 字符串 parse 回对象（anthropic-adapter.ts:148-159），OpenAI 路径又 `JSON.stringify(event.input)` 回去（agent-loop.ts:396）——同一数据每轮双向序列化两次。
- `finish_reason` 是 stringly-typed，且 Anthropic 被归一化成 OpenAI 词汇（anthropic-adapter.ts:483）；`refusal`/`pause_turn` 等 stop_reason 无任何处理分支。
- **PDF 建模为 ImageContent**（types.ts:67-75 无 document 类型）：Anthropic 路径靠 `media_type === "application/pdf"` 特判转 `document` 块（anthropic-adapter.ts:110-119），而 OpenAI 路径把 PDF 塞进 `image_url` 的 data URL（llm-adapter.ts:83-90）——对绝大多数端点必然 400。多模态实为"图像 only + Anthropic 侧 PDF 补丁"。
- **usage 语义跨路径不一致**：OpenAI 的 `input_tokens` = prompt_tokens（**含** cached，llm-adapter.ts:246-262 注释自认）；Anthropic 的 `input_tokens` **不含** cache 读/写（anthropic-adapter.ts:455-463）。同名字段两种语义，而 agent-loop.ts:409 直接 `promptTokens = event.usage.input_tokens` 作上下文基线，**没有**按 adapter 注释宣称的加上 `cache_read`——Anthropic 高缓存命中会话的上下文估算被严重低估，auto-compact 会延迟触发（即分册 01 的 H1）。
- 内部 `SystemMessage` 在 OpenAI 路径是 system 角色（llm-adapter.ts:116-121），在 Anthropic 路径降格为 user 文本块（anthropic-adapter.ts:91-99）——模型对两种角色的信任度不同，语义有差。

**B. 重试/超时/限流**
- 分类器总体不错（error-recovery.ts：429 指数退避+jitter、transient 独立预算各 3 次、context→compact_and_retry、auth→abort），但**全部基于 `status`/`message` 字符串探测**（llm-adapter.ts:328-347；error-recovery.ts:98-100 用 `message.includes("context_length")`），未用 SDK 类型化异常（`Anthropic.RateLimitError` 等）；经中转站/国产 provider 时 message 匹配非常脆弱。
- error-recovery.ts:86 `err?.retryAfter` 在两个 SDK 的错误对象上**都不存在**（真实字段是 `error.headers['retry-after']`），所以 429 退避永远落到 5000ms 兜底——读了个不存在的属性。
- 5 分钟流超时是**整流 wall-clock**上限而非空闲超时（llm-adapter.ts:160；anthropic-adapter.ts:278）：xhigh/max 档 + adaptive thinking 的长 turn 可能被误杀；且两处硬编码重复、不可配置。
- SDK 默认 `maxRetries=2` 未显式关闭，与 loop 层 3 次重试**叠乘**（429 最坏 ~12 次请求），无客户端并发/TPM 节流。
- 无 529 overloaded、无 `refusal` stop_reason 处理（529 是可重试的；当前会落入"unknown → abort"）。

**C. token 计数**
- 纯字符比率启发式（token-estimator.ts:141-150：自然语言 3.5、代码 3.0、JSON 2.5 chars/token，CJK 1:1）——全库 grep 无任何 `count_tokens` 调用。对 Claude 真实 tokenizer 误差可达 15-35%，且新 tokenizer 同文本 token 数上浮，3.5 chars/token 的偏差方向是**低估**（正是该文件 L17-19 自己说的危险方向）。
- 真实 usage 基线锚定（agent-loop.ts:869-875）部分缓解，但受 A 项 cache_read 缺失 bug 拖累。
- 图片估算 `85 + data.length*4/750`（token-estimator.ts:129-133）按 base64 长度折算，与 Anthropic 按像素计费（高分辨率下单图可达 ~4784 tokens）脱节。

**D. cache_control**
- 支持面其实相当好：三个断点（最后一个 tool、system 稳定块、消息尾块，anthropic-adapter.ts:235-237/42-72/247-258），边界契约 + `prompt-cache.ts` 两阶段断裂归因（哈希 diff + cache_read 跌幅 >5% 且 >2000 tokens 才报警），这在复刻项目里少见。
- 弱点：① 消息尾断点每轮后移 = 每轮付 1.25× 缓存写，无 1h TTL 选项，无 20-block 回看窗口的中间断点策略（一轮大批并行 tool_result 可能 >20 块导致静默 miss）；② **CLAUDE.md 和 git 状态在边界之下 → 每轮全价重刷**，而它们在会话内其实稳定，本可做 per-session 缓存段（真实 Claude Code 将 CLAUDE.md 视为可缓存内容）；③ `interleaved-thinking-2025-05-14` beta 头（anthropic-adapter.ts:325）在 adaptive thinking 下已不必要（新模型自动启用）——无害但过时；④ 工具描述 section 在可缓存前缀内却不 memoize（system-prompt.ts:271），MCP 工具中途连接/断开或注册顺序变化会击穿整个前缀。

**E. 类型安全**
- `{} as ModelConfig` 哨兵（cli-config.ts:39）。
- `options: Record<string, unknown>` 杂物袋（types.ts:434）：gateway/effort/thinking/output_config 全塞里面，消费点全是 `as` 断言（llm-adapter.ts:362-367；anthropic-adapter.ts:297-317）。
- anthropic-adapter 自定义 `AnthropicMessage`（content 为 `Array<Record<string, unknown>>`）再 `as unknown as Anthropic.MessageParam[]` 双重断言（L308-310）——放弃了 SDK 的判别联合类型，块结构错误只能运行时 400 才发现。
- `LLM_PROVIDER` 无运行时校验（cli-config.ts:25-29 直接 `as`），非法值在 resolveProviderConfig L355 静默落到 `custom`（localhost:11434）——拼错 provider 名会得到一个莫名的本地 Ollama 配置而非报错。
- provider 白名单三处重复维护：types.ts:428 联合类型、llm-adapter.ts PROVIDER_CONFIGS、provider-profiles.ts:37-45 VALID_PROVIDERS。

**F. 硬编码/过时值**
- `PROVIDER_CONFIGS` 默认模型陈旧：`gpt-4o`、`glm-4`、`moonshot-v1-128k`、`qwen-plus`（llm-adapter.ts:21-50）。
- **Bedrock 默认模型 `anthropic.claude-3-5-sonnet-20241022-v2:0` 已于 2025-10-28 退役**（cloud-gateway.ts:34）——按默认值发请求会直接 404/400；Vertex 默认 `google/gemini-1.5-pro` 同样过时。Vertex URL 路径 `/v1/projects/.../endpoints/openapi` 与 Vertex 公开的 OpenAI 兼容端点（`/v1beta1/openapi/`）不符，疑似未实测。
- `claude-opus-4-8` 默认值散落三处（llm-adapter.ts:24；anthropic-adapter.ts:288、305）。
- reasoning 模型检测靠模型名 regex（effort.ts:263-269），新命名会漏判/误判。
- `output_config.effort` 在 Anthropic 路径**无条件发送**（anthropic-adapter.ts:315-317），对不支持 effort 的模型（Sonnet 4.5/Haiku 4.5）会 400——OpenAI 路径有能力门控（L151），Anthropic 路径反而没有，不对称。
- `resolveEffortMaxTokens`（effort.ts:175-178）对 `LLM_MAX_TOKENS` 取 `Math.min`，**用户只能调低不能调高**；默认 high 档 8192 上限 + adaptive thinking 共享预算，截断（`max_tokens`→"length"）概率不小，而当前模型流式下支持到 128K。

**G. OpenAI 路径的具体缺陷**
- 对 o 系列/reasoning 模型仍发 `max_tokens`（llm-adapter.ts:171）——OpenAI 官方对 o1/o3 要求 `max_completion_tokens`，会 400；门控了 temperature/reasoning_effort 却漏了这个。
- 只消费 `delta.content`/`delta.tool_calls`，**忽略 `reasoning_content`**（DeepSeek R1、Qwen thinking 模式的推理流全部丢弃，UI 无 thinking 显示）——全库 grep `reasoning_content` 零匹配。

---

## 6. 可升级点（按优先级）

1. **修复 Anthropic 缓存会话的上下文低估**（正确性最高优先，=分册 01 H1）：agent-loop.ts:409 应改为 `promptTokens = input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)`，即 anthropic-adapter.ts:462-463 注释里已经写明"loop 应该这样算"但从未实现的公式。当前后果：缓存命中率越高，auto-compact 触发越晚，最终被 provider 以 context_length 硬拒。
2. **usage 语义归一**：在 `StreamEvent.done.usage` 里区分 `billed_input`（计费口径）与 `context_tokens`（窗口占用口径），让两条路径显式声明各自语义（llm-adapter.ts:246-262 vs anthropic-adapter.ts:455-463），消除同名字段双含义。
3. **429 retry-after 真读取**：error-recovery.ts:86 改从 SDK 错误对象读（`Anthropic.RateLimitError` 的 `headers` / OpenAI `APIError.headers?.get('retry-after')`），并用 `instanceof` 类型化异常替代 `status`/`message` 字符串探测（llm-adapter.ts:328-347 整组函数可退役）；补 529 overloaded 与 `stop_reason:"refusal"` 分支。
4. **超时模型改造**：把 llm-adapter.ts:160 / anthropic-adapter.ts:278 的 5 分钟整流超时改为"首字节超时 + 空闲超时"（每收到一个 chunk 重置计时器），并将数值提为可配置；顺手消除 SDK `maxRetries` 与 loop 重试的叠乘（构造 client 时显式 `maxRetries: 0`，把重试策略完全收归 error-recovery）。
5. **effort/max_tokens 能力门控与放宽**：仿照 OpenAI 路径的 `modelSupportsReasoningEffort`，给 Anthropic 路径加 effort/thinking 的模型能力表（不支持的模型不发 `output_config.effort`）；`resolveEffortMaxTokens`（effort.ts:175-178）允许用户配置**上调**（流式下 64K-128K 是安全区间），把截断-续写恢复从常态变例外。
6. **缓存断点策略升级**：为长 turn 增加中间断点（每 ~15 块）规避 20-block 回看窗口；提供 `ttl:"1h"` 选项；把 CLAUDE.md/git 快照提升为"per-session 稳定段"放在第二个 system 块并带断点（它们会话内字节稳定，现在却每轮全价，system-prompt.ts:280-285）；memoize `buildToolDescriptionsSection`（L271）并对 enabled-tools 做确定性排序，防 MCP 变动击穿前缀；移除过时的 `interleaved-thinking-2025-05-14` 头（anthropic-adapter.ts:325）。
7. **token 计数接入真值**：在 Anthropic 路径用 `POST /v1/messages/count_tokens` 校准（如 /context 命令、compact 阈值决策前的精确计数），估算器只留作离线快路径；按当前 tokenizer 重新标定比率；图片估算改按像素。
8. **类型建模**：给 `ContentBlock` 增加 `DocumentContent`（PDF 走正门，同时修掉 llm-adapter.ts:83-90 把 PDF 当 image_url 的必错路径）；`ModelConfig.options` 拆成 discriminated 的 `gateway?/thinking?/outputConfig?/effort?` 字段；anthropic-adapter 用 SDK 的 `Anthropic.MessageParam`/`TextBlockParam` 替代 `Record<string, unknown>` + 双重断言（L28-38、308-310）；provider 白名单收敛为单一常量源；`loadConfig` 失败改为抛错/返回 `null` 而非 `{} as ModelConfig`（cli-config.ts:39）；`LLM_PROVIDER` 非法值显式报错而非静默落 `custom`（llm-adapter.ts:355）。
9. **默认值保鲜**：cloud-gateway.ts:31-40 的 Bedrock 默认模型（已退役 → 现役型号）与 Vertex 默认（gemini-1.5-pro → 现役型号）+ 实测修正 Vertex baseURL 路径；`PROVIDER_CONFIGS`（llm-adapter.ts:21-50）默认模型整体更新，`claude-opus-4-8` 收敛为单一导出常量。
10. **OpenAI 兼容路径补强**：reasoning 模型改发 `max_completion_tokens`（llm-adapter.ts:171）；消费 `delta.reasoning_content` 映射为 `StreamEvent.thinking`，让 DeepSeek/Qwen 的推理流在 UI 可见且可计入 output tokens。

---

## 总评

这是一个自觉程度很高的接入层——缓存边界契约、断裂归因、thinking 原样回传、tool_use 早启动、每轮 per-call dispatch 等设计都对齐了真实 Claude Code 的工程思路，注释大量记录了"为什么"。主要短板集中在三处：统一格式以 OpenAI 为底导致的语义泄漏与 usage 双口径（并已实际造成 Anthropic 缓存会话的 compact 延迟 bug）、错误处理停留在字符串探测且 retry-after 读取失效、以及默认模型/网关端点的硬编码值已经过时。
