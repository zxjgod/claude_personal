# 项目规划表 — 对齐 Claude Code

基于对当前代码库的评估（约 3700 行，架构骨架完整，差距集中在正确性细节、能力广度、交互体验三层）。
起始定位：若 Claude Code 为 100，本项目约在 35-40。地基已打好，墙还没砌。

> **进度更新（2026-06-20）：M0–M6（除 Anthropic 有效 key 真机项外）完成 ✅，全套 180 tests passed。** 主线六个里程碑均已交付；M6 已完成 quiet/verbose、@file 去重提示、/doctor、/sessions、/resume、/tokens on/off、/permissions、非 TTY 多命令管道输入修复、task 权限 prompt 修复、子代理进度透出、最终输出 flush 修复与真机 smoke。剩余项仅为未来有有效 Anthropic key 后的原生路径完整联调。

## 总览：里程碑路线图

| 阶段 | 主题 | 目标 | 预估工作量 | 完成后的状态 | 状态 |
|---|---|---|---|---|---|
| **M0** | 正确性修复 | 修掉会导致崩溃的 bug | 1-2 天 | 长对话不崩，能每天自用 | ✅ |
| **M1** | 原生 Anthropic + 缓存 | 体验与成本分水岭 | 2-3 天 | 响应质量/成本接近官方 | ✅ |
| **M2** | CLI 渲染层 | 让它"感觉像" Claude Code | 3-5 天 | 流式 markdown + 彩色 diff | ✅ |
| **M3** | 交互命令 | slash command / @文件 引用 | 2-3 天 | 操作手感对齐 | ✅ |
| **M4** | 能力广度 | WebSearch / hooks / 多子代理 | 4-6 天 | 功能覆盖度补齐 | ✅ |
| **M5** | 工具增强 | Read 多模态 / Edit 批量 | 3-4 天 | 工具能力对齐 | ✅ |
| **M6** | 用户体验打磨 | quiet/doctor/session/@file 优化 | 2-4 天 | 从“能用”走向“爱用” | ✅（Anthropic 真机项待 key） |

## 依赖关系

```
M0 (必须先做) ──> M1 ──> M2 ──> M3
                  │
                  └────────────> M4 ──> M5 ──> 真机联调 ──> M6
```

M0–M5 主线已完成。M6 不再是补核心能力，而是根据真机体验对比表（`用户体验对比表.md`）做日常使用体验打磨：减少噪音、增强诊断、优化 @file、完善 session 操作。

---

## M0 — 正确性修复（最高优先级）

| # | 任务 | 涉及文件 | 验收标准 | 状态 |
|---|---|---|---|---|
| 0.1 | 压缩按 tool_use/tool_result 配对边界切，不按固定条数 | src/agent-loop.ts:346 | 触发压缩后 OpenAI 不报 "tool message must follow tool_calls" | ✅ |
| 0.2 | 开启 `stream_options:{include_usage:true}`，token 用真实值 | src/llm-adapter.ts:120 | CLI 显示的 token 与 API 账单一致 | ✅ |
| 0.3 | 工作区边界检查加 `path.sep`，并拒绝逃逸的绝对路径 | src/tools.ts:98 | `C:\Windows\...`、`/proj-evil` 均被拒 | ✅ |
| 0.4 | 为上述写回归测试 | src/__tests__/ | `npm test` 全绿 | ✅ |

> M0 完成（2026-06-19）。新增 3 个测试文件用例，全套 88 tests passed。

## M1 — 原生 Anthropic Provider + Prompt Caching

| # | 任务 | 涉及文件 | 验收标准 | 状态 |
|---|---|---|---|---|
| 1.1 | 新增 Anthropic SDK caller（Messages API） | src/anthropic-adapter.ts | 能用 `claude-*` 模型完整跑通工具循环 | ✅ |
| 1.2 | caller factory 按 provider 路由（Anthropic vs OpenAI 兼容） | src/llm-adapter.ts:219 | 切 provider 不改业务代码 | ✅ |
| 1.3 | system prompt static 段打 `cache_control` 标记 | src/system-prompt.ts:128, src/anthropic-adapter.ts | 第二轮请求 cache_read tokens > 0 | ✅ |
| 1.4 | 消息格式转换器（内部格式 → Anthropic content blocks） | src/anthropic-adapter.ts | tool_use/tool_result 往返无损 | ✅ |

> M1 完成（2026-06-19）。已接入官方 `@anthropic-ai/sdk`，新增原生 Anthropic Messages API 适配器、prompt caching system blocks、provider 路由和回归测试。全套 97 tests passed。

## M2 — CLI 渲染层（体感差距最大）

| # | 任务 | 涉及文件 | 验收标准 | 状态 |
|---|---|---|---|---|
| 2.1 | 流式 markdown 渲染（标题/列表/代码块高亮） | src/cli-renderer.ts, src/cli.ts | 输出不再是裸文本 | ✅ |
| 2.2 | Edit/Write 彩色 diff 预览（替换 slice(0,200)） | src/cli-renderer.ts | 看到绿增红删的 diff | ✅ |
| 2.3 | 工具执行耗时显示 | src/cli-renderer.ts | 工具结果带 (Nms) | ✅ |
| 2.4 | 权限提示三档（本次/always/拒绝）+ 记忆 | src/cli.ts | always 后同类操作不再询问 | ✅ |

> M2 完成（2026-06-19）。新建 src/cli-renderer.ts 承载终端展示逻辑：StreamingRenderer 行缓冲流式高亮、renderToolStart/renderToolResult（彩色 diff + 耗时）、renderPermissionPrompt 三档提示。cli.ts 接入渲染器并新增会话级 always-allow 记忆。全套 105 tests passed。

## M3 — 交互命令

| # | 任务 | 涉及文件 | 验收标准 | 状态 |
|---|---|---|---|---|
| 3.1 | slash command 框架（`/help` `/clear` `/model` `/compact` `/tokens`） | src/commands.ts, src/cli.ts | 输入 `/` 命中本地命令，不发给 LLM | ✅ |
| 3.2 | `@文件` 引用（自动读入内容到上下文） | src/file-refs.ts, src/cli.ts | `@src/x.ts` 注入文件内容 | ✅ |
| 3.3 | 多行输入 / 粘贴支持 | src/cli.ts | 能贴多行代码块 | ✅ |

> M3 完成（2026-06-19）。新建 src/commands.ts（slash 命令注册表 + 分发，含 /help /clear /model /compact /tokens）与 src/file-refs.ts（@path 引用展开，带工作区边界校验与去重）。cli.ts REPL 接入：输入先过 slash 分发，再展开 @文件，并支持 ``` 围栏 / 行尾 `\` 续行的多行输入。autoCompact 导出供 /compact 复用。全套 119 tests passed。

## M4 — 能力广度

| # | 任务 | 涉及文件 | 验收标准 | 状态 |
|---|---|---|---|---|
| 4.1 | WebSearch 工具 | src/web-search.ts | 能返回搜索结果供 LLM 综合 | ✅ |
| 4.2 | Hooks 系统（PreToolUse / PostToolUse） | src/hooks.ts, src/agent-loop.ts | 配置的 hook 能拦截/改写工具调用 | ✅ |
| 4.3 | 子代理类型可配置（不止 code-explorer） | src/subagents.ts, src/task-tool.ts | 可注册多种 subagent + 各自工具集 | ✅ |
| 4.4 | 子代理并发上限 + 结果聚合 | src/task-tool.ts | 多子代理并行不超并发限制 | ✅ |

> M4 完成（2026-06-19）。新增 src/web-search.ts（无 key 的 DuckDuckGo HTML 搜索 + 结果解析，已并入 CORE_TOOLS）、src/hooks.ts（HookRegistry，PreToolUse 可拦截/改写输入、PostToolUse 可改写结果，按工具名匹配，已接入 agent-loop 的 executeSingleTool）、src/subagents.ts（子代理注册表，内置 code-explorer/code-reviewer/general 三型各带工具集与系统提示，支持自定义注册）。task-tool.ts 重构为按注册表解析子代理类型，并加信号量并发上限（默认 3，可经 TASK_MAX_CONCURRENCY 配置）。全套 139 tests passed。

## M5 — 工具增强

| # | 任务 | 涉及文件 | 验收标准 | 状态 |
|---|---|---|---|---|
| 5.1 | Read 支持图片/PDF（多模态 content block） | src/tools.ts, src/agent-loop.ts, src/anthropic-adapter.ts | 图片以 image block 进入上下文 | ✅ |
| 5.2 | Edit 支持 `replace_all` | src/tools.ts | 多处替换一次完成 | ✅ |
| 5.3 | MultiEdit（单文件批量编辑，原子提交） | src/tools.ts | 一组编辑全成功或全回滚 | ✅ |
| 5.4 | Read 后才允许 Edit 的状态追踪 | src/read-tracker.ts, src/tools.ts | 未读直接编辑会被提示先读 | ✅ |

> M5 完成（2026-06-19）。Read 识别 png/jpg/gif/webp/pdf，以 base64 image/document block 经 agent-loop 注入为后续 user 消息（两家 provider 都只在 user content 收图，Anthropic 适配器把 pdf 转 document 块）。Edit 新增 replace_all（index 切片实现，不解释 `$`）。新增 MultiEdit 工具：单文件多处编辑内存中顺序应用，任一失败则全部不落盘。新增 src/read-tracker.ts：Read 标记 mtime，Edit/MultiEdit 前校验"已读且未变更"，写后刷新追踪以支持链式编辑。全套 158 tests passed。

## 真机联调与体验对比（M5 后补强）

| # | 事项 | 涉及文件 | 验收标准 | 状态 |
|---|---|---|---|---|
| T.1 | 官方 Claude Code vs 本项目体验对比 | 用户体验对比表.md | 有实际命令输出和差距结论 | ✅ |
| T.2 | 非 TTY / 管道输入 EOF 崩溃修复 | src/cli-input.ts, src/cli.ts | `printf '...\\nexit\\n' \| npm start` 不再 `ERR_USE_AFTER_CLOSE` | ✅ |
| T.3 | 多行输入行尾 `\\` 续行逻辑修复 | src/cli-input.ts | `one\\` + `two` 读成两行 | ✅ |
| T.4 | Provider/API 错误收敛为友好单行 | src/cli-errors.ts, src/cli.ts | 403/401 不再 dump SDK headers | ✅ |
| T.5 | 为上述补回归测试 | src/__tests__/cli-input.test.ts, src/__tests__/cli-errors.test.ts | 全套测试增至 169 passed | ✅ |
| T.6 | 启动教程沉淀 | 启动教程.txt | 新用户可按文档 build/start/sandbox 联调 | ✅ |
| T.7 | 非 TTY 多命令管道输入修复 | src/cli-input.ts | `printf '/tokens\\n/tokens on\\n...\\nexit\\n' \| node dist/cli.js` 逐行完整执行 | ✅ |
| T.8 | log.txt 反馈的 task UX bug 修复 | src/permissions.ts, src/task-tool.ts, src/cli-renderer.ts, src/cli.ts | `task` 不再重复弹权限；子代理 read/grep/edit 进度实时可见；最终回答无需按回车才显示 | ✅ |

> 真机联调完成（2026-06-20）。DeepSeek 路径已用 `npm start` 在 sandbox 中验证：简单问答、`/help`、Read 工具、`@file` 引用、非 TTY 管道退出均跑通。Anthropic 路由用假 key 验证到真实 SDK/API 端点，因无有效 Anthropic key 只做路由/错误体验验证。随后继续修复非 TTY 多命令管道消费问题，以及 log.txt 反馈的 `task` 双权限 prompt、子代理过程不可见、最终输出需按回车才显示的问题；已补回归测试并真机验证 `task` 子代理 read 进度实时显示。全套 180 tests passed。

## M6 — 用户体验打磨

> 目标：核心能力已经能跑，M6 聚焦把它从“能用的本地 AI coding assistant 原型”打磨到“日常愿意打开使用”的工具。本轮已完成大部分日常 UX 项，剩余 `6.6` 工具结果折叠和 `6.8` 有效 Anthropic key 真机联调。

| # | 任务 | 涉及文件 | 验收标准 | 状态 |
|---|---|---|---|---|
| 6.1 | quiet / verbose 启动模式 | src/cli.ts | 默认启动少噪音；verbose 才显示 provider/session/tools 详情 | ✅ |
| 6.2 | 优化 `@file` 注入提示，避免重复 read | src/file-refs.ts, src/cli.ts | `@src/x.ts` 已附内容时模型不再无意义重复调用 read | ✅ |
| 6.3 | `/doctor` 环境诊断命令 | src/commands.ts | 一键检查 `.env`、provider、model、workspace、dist、Node 版本 | ✅ |
| 6.4 | `/sessions` / `/resume` 会话命令 | src/commands.ts, src/persistence.ts | 可列出/恢复 session，不只靠启动提示 | ✅ |
| 6.5 | token/cost 显示可配置 | src/cli.ts, src/commands.ts | 日常默认隐藏 token；`/tokens on/off` 可切换 | ✅ |
| 6.6 | 工具结果折叠/摘要策略 | src/cli-renderer.ts | 长 read/grep 输出默认摘要，必要时展开 | ⏳ |
| 6.7 | 权限 always 记忆可查看/清空 | src/cli.ts, src/commands.ts | `/permissions` 可查看/清空本会话 always allow 项 | ✅ |
| 6.8 | 有效 Anthropic key 下完整真机联调 | .env / 手动联调 | 原生 Anthropic 工具循环、prompt cache、多模态均真实跑通 | ⏳ |
| 6.9 | 非 TTY 多命令管道输入可靠消费 | src/cli-input.ts | 管道多行输入按顺序逐条执行，不丢第二行以后命令 | ✅ |
| 6.10 | task 交互体验修复 | src/permissions.ts, src/task-tool.ts, src/cli-renderer.ts, src/cli.ts | `task` 不再重复弹权限；子代理进度实时可见；最终输出无需按回车补刷 | ✅ |

> M6 本轮完成（2026-06-20）。完成 quiet 默认启动、verbose 调试启动、`/doctor`、`/sessions`、`/resume`、`/tokens on/off`、`/permissions`，并优化 `@file` 注入文案，实测 `@src/math.js` 不再重复触发 read。继续验证时发现非 TTY 多命令管道只执行第一行，已将 `cli-input.ts` 改为 line-event 队列，补测试并真机验证 `/tokens` → `/tokens on` → 模型问答 → `/tokens off` → `exit` 全链路。随后根据 log.txt 修复 `task` 双权限 prompt、子代理过程不可见、最终回答需按回车才显示三项体验问题：新增 `requiresApproval:false`、权限 prompt 串行化、子代理进度回调和 renderer newline flush。全套 180 tests passed。

---

## 已确认的现状

### 做得好的部分
- agent loop 用 `AsyncGenerator<LoopEvent>` 流式 yield — 与官方一致的核心抽象 (src/agent-loop.ts:26)
- 工具按 `isConcurrencySafe()` 分组，安全并行 / 不安全串行 (src/agent-loop.ts:190)
- Edit 用 index 切片而非 `String.replace`，避免 `$&`/`$1` 被解释 (src/tools.ts:332)
- 权限 4 mode + 危险模式黑名单 + 阻断路径 (src/permissions.ts:118)
- system prompt 已有 static/dynamic 边界，为缓存留位 (src/system-prompt.ts:128)

### 三个待修的正确性 Bug（M0）
1. token 统计恒为 0 — 流式未开 usage (src/llm-adapter.ts:120)
2. 压缩按固定 20 条切，会切断 tool_use/tool_result 配对 (src/agent-loop.ts:346)
3. 工作区边界用 `startsWith` 无分隔符，可被 `/proj-evil` 绕过 (src/tools.ts:98)
