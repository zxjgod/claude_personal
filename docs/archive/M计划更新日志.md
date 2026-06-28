# M1–M6 更新日志

> 项目：Claude Code Replica / `claude_personal`  
> 时间线：2026-06-19 ~ 2026-06-20  
> 当前状态：M1–M6 主线已完成，除「有效 Anthropic key 下完整真机联调」外均已落地。  
> 最新验证：`npm run build` 通过，全套 **180 tests passed**。

---

## 总览

| 里程碑 | 主题 | 状态 | 关键成果 |
|---|---|---|---|
| M1 | 原生 Anthropic Provider + Prompt Caching | ✅ 完成 | 接入官方 `@anthropic-ai/sdk`，支持 Anthropic Messages API、prompt caching、provider 路由 |
| M2 | CLI 渲染层 | ✅ 完成 | 流式 markdown 渲染、彩色 diff、工具耗时、三档权限提示 |
| M3 | 交互命令 | ✅ 完成 | slash commands、`@file` 引用、多行输入 |
| M4 | 能力广度 | ✅ 完成 | WebSearch、Hooks、子代理注册表、子代理并发上限 |
| M5 | 工具增强 | ✅ 完成 | Read 多模态、Edit `replace_all`、MultiEdit、Read-before-Edit |
| M6 | 用户体验打磨 | ✅ 基本完成 | quiet/verbose、doctor/session 命令、token 显示切换、权限记忆、task 体验修复 |

---

# M1 — 原生 Anthropic Provider + Prompt Caching

## 目标

让项目不只依赖 OpenAI-compatible API，还能直接走 Anthropic 官方 SDK，从而支持 Claude 原生能力：Messages API、prompt caching、Claude 4.8 默认模型、adaptive thinking、真实 usage 统计。

## 已完成

### 1. 新增 Anthropic Adapter

新增文件：

- `src/anthropic-adapter.ts`

核心能力：

- 使用官方 `@anthropic-ai/sdk`
- 使用 Messages API
- 支持 `client.messages.stream()` 流式调用
- 支持 `.finalMessage()` 获取最终完整消息
- 默认模型：`claude-opus-4-8`
- 默认 thinking：`thinking: { type: "adaptive" }`
- 默认 effort：`output_config: { effort: "high" }`

### 2. Provider 路由

修改文件：

- `src/llm-adapter.ts`
- `src/types.ts`

变化：

- `ModelConfig.provider` 增加 `"anthropic"`
- `createModelCaller()` 根据 provider 自动选择：
  - `anthropic` → `anthropicCaller`
  - 其他 provider → `openAICompatibleCaller`

### 3. Prompt Caching

修改文件：

- `src/system-prompt.ts`
- `src/anthropic-adapter.ts`

变化：

- 导出 `DYNAMIC_BOUNDARY`
- Anthropic system prompt 按边界拆成 stable / dynamic 两段
- stable 段添加：

```ts
cache_control: { type: "ephemeral" }
```

目的：

- 静态 system prompt 可以被 Claude prompt cache 命中
- 动态 workspace 信息不破坏缓存前缀

### 4. 内部消息格式转换

支持内部 OpenAI-like message 转 Anthropic content block：

- user text → Anthropic text block
- user image → Anthropic image block
- assistant tool_calls → Anthropic tool_use block
- tool result → Anthropic user-side tool_result block
- 相邻同 role message 自动 merge

### 5. 配置更新

修改文件：

- `.env.example`

变化：

```env
LLM_PROVIDER=anthropic
# openai: gpt-4o | anthropic: claude-opus-4-8 | deepseek: deepseek-chat | qwen: qwen-plus
```

## 测试

新增测试：

- `src/__tests__/anthropic-adapter.test.ts`

覆盖：

- system prompt split/cache_control
- message conversion
- tool schema conversion
- provider routing

当时测试结果：**97 tests passed**。

---

# M2 — CLI 渲染层

## 目标

让 CLI 从“裸文本输出”变成更接近 Claude Code 的终端体验：流式文本、markdown-ish 高亮、工具执行状态、彩色 diff、权限提示更清楚。

## 已完成

### 1. 新增 CLI Renderer

新增文件：

- `src/cli-renderer.ts`

核心导出：

- `StreamingRenderer`
- `renderToolStart()`
- `renderToolResult()`
- `renderPermissionPrompt()`
- 后续 M6 又新增 `renderSubAgentActivity()`

### 2. 流式 Markdown-ish 渲染

`StreamingRenderer` 支持：

- 行缓冲输出
- 标题高亮
- 列表项前缀弱化
- 代码块灰/青色渲染
- 未完整换行的文本先缓冲，避免碎片化输出

### 3. 工具执行展示

工具调用时显示：

```text
🔧 read — src/file.ts
✅ read (2ms)
```

工具失败时显示：

```text
❌ edit: old_string not found
```

### 4. 彩色 diff 预览

`renderToolResult()` 对工具 formatted output 做基础着色：

- `+ ` 开头 → 绿色
- `- ` 开头 → 红色
- `Error:` → 红色
- 超长输出裁剪提示 → 灰色

### 5. 权限提示三档

权限 prompt 从原来的 `Allow? [y/N]` 升级为：

```text
y = allow once, a = always for this tool+target, n/Enter = deny
```

并在 CLI 中增加会话级 always-allow 记忆。

## 测试

新增测试：

- `src/__tests__/cli-renderer.test.ts`

覆盖：

- 行缓冲
- flush
- markdown-ish 高亮
- 工具结果展示
- diff 着色
- 权限提示

当时测试结果：**105 tests passed**。

---

# M3 — 交互命令

## 目标

补齐日常 CLI 操作手感：slash commands、`@file` 引用、多行输入。

## 已完成

### 1. Slash Command 框架

新增文件：

- `src/commands.ts`

初始命令：

- `/help`
- `/clear`
- `/model`
- `/compact`
- `/tokens`

后续 M6 扩展：

- `/doctor`
- `/sessions`
- `/resume`
- `/permissions`

特点：

- `/` 开头输入先本地处理
- 不发送给 LLM
- 命令可修改 `messages`、`modelConfig`、session 状态等

### 2. `@file` 引用

新增文件：

- `src/file-refs.ts`

能力：

- 用户输入 `@src/foo.ts` 时自动读取文件内容
- 内容以 `<file path="...">...</file>` 形式附加到 user message
- 工作区边界校验，禁止逃逸 workspace
- 去重，避免同一文件重复附加
- 跳过过大文件
- 不把邮箱误判为文件引用

后续 M6 优化：

- 在注入内容里加入提示：文件已经通过 `@file` 附加，模型不要无意义重复调用 `read`

### 3. 多行输入

支持：

1. 代码块围栏：

```text
```js
const x = 1
```
```

2. 行尾 `\` 续行：

```text
第一行 \
第二行 \
第三行
```

后续 M6 修复：

- 非 TTY 管道输入多命令消费问题
- EOF 时不再 `ERR_USE_AFTER_CLOSE`
- 多行中途 EOF 可返回已读内容

## 测试

新增测试：

- `src/__tests__/commands.test.ts`
- `src/__tests__/file-refs.test.ts`

当时测试结果：**119 tests passed**。

---

# M4 — 能力广度

## 目标

补齐 Claude Code 类工具的能力面：WebSearch、Hooks、多子代理、并发控制。

## 已完成

### 1. WebSearch 工具

新增文件：

- `src/web-search.ts`

能力：

- 使用 DuckDuckGo HTML 无 key 搜索
- 解析结果 title / url / snippet
- 解开 DuckDuckGo redirect URL
- 作为 `web_search` 工具加入 `CORE_TOOLS`

用途：

- 查文档
- 查近期信息
- 获取结果列表后再用 `web_fetch` 深读

### 2. Hooks 系统

新增文件：

- `src/hooks.ts`

能力：

- `HookRegistry`
- `PreToolUse`：工具执行前拦截或改写 input
- `PostToolUse`：工具执行后改写 result
- 支持按工具名匹配，也支持 `*`

接入位置：

- `src/agent-loop.ts` 的 `executeSingleTool()`

### 3. 子代理注册表

新增文件：

- `src/subagents.ts`

内置类型：

| 子代理 | 能力 |
|---|---|
| `code-explorer` | 只读探索，read/glob/grep/bash |
| `code-reviewer` | 只读审查，read/glob/grep |
| `general` | 可读写，read/glob/grep/bash/write/edit |

支持：

- `registerSubagentType()` 自定义注册
- 每个 subagent 自己的工具集和 system prompt

### 4. TaskTool 重构 + 并发上限

修改文件：

- `src/task-tool.ts`

变化：

- 从硬编码 `code-explorer` 改为按 `subagents.ts` 注册表解析
- 默认并发上限：3
- 可通过 `TASK_MAX_CONCURRENCY` 配置
- 多个 `task` 并发时通过信号量排队，避免瞬间打满 provider

## 测试

新增测试：

- `src/__tests__/web-search.test.ts`
- `src/__tests__/hooks.test.ts`
- `src/__tests__/subagents.test.ts`
- agent-loop hook 集成测试

当时测试结果：**139 tests passed**。

---

# M5 — 工具增强

## 目标

强化核心文件工具：Read 多模态、Edit 多处替换、MultiEdit 原子批量、Read-before-Edit 安全门禁。

## 已完成

### 1. Read 多模态

修改文件：

- `src/tools.ts`
- `src/agent-loop.ts`
- `src/anthropic-adapter.ts`
- `src/types.ts`

能力：

- Read 识别：
  - `.png`
  - `.jpg`
  - `.jpeg`
  - `.gif`
  - `.webp`
  - `.pdf`

返回：

- 图片/PDF 以 base64 形式进入 `ToolResult.images`
- agent loop 在工具结果后追加 user message 承载 image/document block
- Anthropic adapter 中 PDF 转为 `document` block，图片转为 `image` block

### 2. Edit `replace_all`

修改文件：

- `src/tools.ts`

能力：

```ts
replace_all?: boolean
```

行为：

- 默认仍要求 `old_string` 唯一
- `replace_all:true` 时替换所有出现位置
- 使用 index 切片实现，避免 `String.replace` 解释 `$&` / `$1` 等特殊序列

### 3. MultiEdit

新增工具：

- `multi_edit`

实现位置：

- `src/tools.ts`

能力：

- 单文件多处编辑
- edits 按顺序应用
- 所有编辑先在内存中执行
- 任一失败，文件完全不落盘
- 全成功后一次性写回

### 4. Read-before-Edit

新增文件：

- `src/read-tracker.ts`

能力：

- Read 时记录文件 `mtimeMs`
- Edit / MultiEdit 前检查：
  - 文件必须在当前 session 中读过
  - 文件没有在外部发生变化
- 写入成功后刷新 mtime，支持链式 edit

目的：

- 防止模型没读文件就盲改
- 防止外部改动后覆盖用户新内容

## 测试

新增测试：

- `src/__tests__/tools-m5.test.ts`
- `src/__tests__/read-tracker.test.ts`
- Anthropic PDF/document conversion 测试

当时测试结果：**158 tests passed**。

---

# M6 — 用户体验打磨

## 目标

核心能力已经能跑，M6 聚焦真实使用体验：少噪音、能诊断、能管理 session、权限记忆可见、task 过程可见、非 TTY 输入可靠。

## 已完成

### 1. quiet / verbose 启动模式

修改文件：

- `src/cli.ts`

默认 quiet：

```text
Claude Code Replica (deepseek/deepseek-v4-pro) — /help for commands, exit to quit
```

verbose：

```bash
npm start -- --verbose
```

或：

```bash
CCR_VERBOSE=1 npm start
```

verbose 显示：

- banner
- provider
- model
- workspace
- permission mode
- session
- tools loaded
- MCP servers

### 2. `/doctor`

修改文件：

- `src/commands.ts`

检查：

- Node 版本
- provider
- model
- API key 是否存在
- `.env` 是否存在
- workspace 是否存在
- `package.json`
- `dist/cli.js`

### 3. `/sessions` / `/resume`

修改文件：

- `src/commands.ts`
- `src/cli.ts`
- `src/persistence.ts`

能力：

- `/sessions` 列出最近 session
- `/resume <id-prefix>` 按 session id 前缀恢复
- 不再只依赖启动时提示

### 4. `/tokens on/off`

修改文件：

- `src/commands.ts`
- `src/cli.ts`

能力：

- 默认隐藏 token usage，减少日常噪音
- `/tokens on` 开启显示
- `/tokens off` 关闭显示
- `/tokens` 查看当前 message count 和显示状态

### 5. `/permissions`

修改文件：

- `src/commands.ts`
- `src/cli.ts`

能力：

- 查看本会话 always-allow 权限记忆
- `/permissions clear` 清空

### 6. `@file` 去重提示

修改文件：

- `src/file-refs.ts`

变化：

`@file` 注入的内容增加提示：

```text
The contents below were already attached from @xxx.
Do not call the read tool for this file again unless...
```

目的：

- 减少模型对已附加文件重复调用 `read`

### 7. EOF / 非 TTY / 管道输入修复

新增/修改文件：

- `src/cli-input.ts`
- `src/cli.ts`

修复问题：

- 管道输入耗尽后不再 `ERR_USE_AFTER_CLOSE`
- Ctrl+D / EOF 干净退出
- 非 TTY 多命令输入按顺序消费，不丢第二行以后命令
- 多行输入中途 EOF 返回已读内容

示例：

```bash
printf '/tokens\n/tokens on\nexit\n' | node dist/cli.js
```

现在会逐行完整执行。

### 8. Provider/API 错误友好化

新增文件：

- `src/cli-errors.ts`

能力：

- 认证错误 401/403 显示友好单行
- rate limit 429 显示建议
- context/token limit 显示 `/compact` 建议
- provider 5xx 显示 retry/switch provider 建议
- 不再 dump SDK headers / request object

### 9. `task` 体验修复（来自 log.txt 反馈）

修改文件：

- `src/types.ts`
- `src/tool-registry.ts`
- `src/permissions.ts`
- `src/task-tool.ts`
- `src/agent-loop.ts`
- `src/cli-renderer.ts`
- `src/cli.ts`

修复问题：

#### 9.1 `task` 不再重复弹权限 prompt

原因：

- `task` 是 `isReadOnly:false`
- 默认权限系统会对所有 destructive tool 弹 prompt
- 多个 task 并发时会连续弹多个 prompt

修复：

- `Tool` 增加 `requiresApproval?()`
- `createTool()` 支持 `requiresApproval`
- `TaskTool` 设置 `requiresApproval:false`
- `permissions.ts` 默认步骤只对 `requiresApproval:true` 的工具询问
- 危险模式检查仍优先执行，不被绕过

#### 9.2 权限 prompt 串行化

原因：

- 并发工具调用可能同时调用 `askUser`
- 多个 prompt 争抢同一个 readline

修复：

- `cli.ts` 中把 `askUser` 包成 promise chain mutex
- prompt 一个一个出现，一个回答只对应一个 prompt

#### 9.3 子代理过程实时可见

原因：

- `TaskTool.call()` 内部消费 sub-agent `agentLoop`
- 以前只统计 tool call 数量，不向父 CLI 转发过程

修复：

- `ToolContext` 增加 `onSubAgentProgress`
- `agent-loop.ts` 传递该 callback
- `task-tool.ts` 在 sub-agent `tool_use/tool_results/done` 时回调
- `cli-renderer.ts` 新增 `renderSubAgentActivity()`
- `cli.ts` 渲染嵌套进度

现在显示示例：

```text
🔧 task
  ↳ [code-explorer] 🔧 read — README.md
  ↳ [code-explorer] ✅ read (1ms)
  ↳ [code-explorer] done
✅ task
```

#### 9.4 最终回答不再需要按回车才显示完整

原因：

- `StreamingRenderer.flush()` 对未换行 buffer 不补 `\n`
- Windows TTY 有时要等下一个输入事件才刷出来

修复：

- `flush()` 输出末尾补 `\n`
- 每轮结束后 drain stdout

## M6 测试

新增/扩展测试：

- `src/__tests__/cli-input.test.ts`
- `src/__tests__/cli-errors.test.ts`
- `src/__tests__/commands.test.ts`
- `src/__tests__/file-refs.test.ts`
- `src/__tests__/permissions.test.ts`
- `src/__tests__/cli-renderer.test.ts`
- `src/__tests__/agent-loop.test.ts`
- `src/__tests__/new-tools.test.ts`

当前最新验证：

```text
20 test files passed
180 tests passed
npm run build passed
```

## M6 真机 smoke

已用 DeepSeek + sandbox 验证：

```text
Use the task tool with subagent_name code-explorer to inspect README.md in the workspace and summarize briefly.
```

结果：

- `task` 没有再弹权限 prompt
- 子代理 `read` 过程实时显示
- 最终回答直接显示
- 程序正常 `Goodbye!`

---

# 剩余事项

## 1. M6.6 工具结果折叠/摘要策略

状态：未做 / 可选优化

目标：

- 长 read/grep 输出默认摘要
- 必要时展开完整内容
- 减少终端刷屏

当前已有基础裁剪：

- `renderToolResult()` 最多预览 24 行
- 超长输出显示 clipped 提示

后续可继续增强为真正的折叠 UI。

## 2. M6.8 有效 Anthropic key 下完整真机联调

状态：待有效 key

当前已验证：

- Anthropic provider 路由正确
- 使用假 key 能打到真实 SDK/API 端点
- 403 错误被友好格式化

未验证：

- 有效 Anthropic key 下的完整工具循环
- prompt cache 真实 `cache_read` tokens
- 多模态图片/PDF 真实 Claude 输入

---

# M7 — Slash 命令补齐（2026-06-20）

## 目标

把命令从 9 个扩到 17 个，操作手感向官方 Claude Code 对齐。

## 新增命令

| 命令 | 作用 |
|---|---|
| `/status` | session/provider/model/workspace/权限模式/消息数/工具数/MCP/累计 token/运行时长/改动文件数 |
| `/cost` | 累计 token 用量 + 基于价格表的成本估算（未知模型显示 unknown，不臆测） |
| `/tools` | 列出已加载工具，按 core / MCP 分组，标注 read-only / mutating |
| `/context` | 估算上下文构成：system / user / assistant / tool 各段 token 占比（~4 字符/token） |
| `/config` | provider/model/baseURL/maxTokens/temperature/workspace/权限模式 |
| `/diff` | 汇总本会话被 Write/Edit/MultiEdit 改动的文件（created/modified + 次数） |
| `/memory` | 查看 CLAUDE.md；`/memory add <text>` 追加一条项目记忆 |
| `/init` | 扫描 workspace 生成 CLAUDE.md 脚手架；`/init force` 覆盖 |

## 新增模块

- `src/session-stats.ts` — 跨轮累计 token/成本/工具调用；价格表 + 成本估算
- `src/change-tracker.ts` — 按 sessionId 隔离的文件改动日志

## 接线

- `cli.ts`：实例化 `SessionStats`，`usage` 事件累计 token、`tool_results` 累计工具调用；区分 core/MCP 工具来源注入 `CommandContext`
- `tools.ts`：Write/Edit/MultiEdit 写盘成功后 `recordChange`
- 7.8（`/` 自动补全）在 M6 的 `cli-interactive.ts` 已实现，本里程碑核实归档

## 测试

新增/扩展：

- `src/__tests__/session-stats.test.ts`（10）
- `src/__tests__/change-tracker.test.ts`（6）
- `src/__tests__/commands.test.ts`（扩充 11 个 M7 用例）

验证：`tsc --noEmit` 通过；`vitest run` → 24 文件 / **223 passed**（M6 为 196）。

---

# M8 — 工具广度补齐（2026-06-20）

## 目标

把核心工具从 11 个扩到 19 个，覆盖结构化提问、规划模式、Notebook、诊断、工具检索、MCP 资源。

## 新增工具

| 工具 | 作用 |
|---|---|
| `ask_user_question` | 结构化单/多选提问，阻塞等待用户选择（TTY 弹方向键菜单，非 TTY 走编号文本） |
| `enter_plan_mode` | 切入只读规划态，破坏性工具被拦截 |
| `exit_plan_mode` | 退出规划态，可选 `to=acceptEdits` |
| `notebook_edit` | .ipynb 单元格 replace / insert / delete，复用 read-before-edit |
| `lsp_diagnostics` | 轻量 TS 诊断（`tsc --noEmit` 解析），可按文件过滤 |
| `tool_search` | 按关键词检索可用工具（name+描述打分） |
| `mcp_list_resources` | 列出已连接 MCP server 的资源 |
| `mcp_read_resource` | 按 uri 读取 MCP 资源内容 |

## 新增/修改模块

- `src/tools-m8.ts` — NotebookEdit、LSPTool、ToolSearch 工厂、MCP 资源工具工厂
- `src/tools-m8-interactive.ts` — EnterPlanMode / ExitPlanMode / AskUserQuestion
- `src/lsp.ts` — tsc 输出解析为结构化诊断（`parseTscOutput` / `filterByFile` / `formatDiagnostics`）
- `src/types.ts` — `ToolContext` 加 `askUserQuestion` 回调；新增 `UserQuestion` 类型
- `src/cli-interactive.ts` — 新增 `promptSelectMenu`（单/多选菜单）
- `src/cli.ts` — 注入 `askUserQuestion`（spinner 暂停 + 串行化）；注册 ToolSearch（持有完整工具表）与 MCP 资源工具
- `src/mcp.ts` — MCPManager 加 `listResources` / `readResource`
- `src/tools.ts` — 导出 `resolveInWorkspace` / `relForDisplay` / `statMtimeMs` 供复用；CORE_TOOLS 纳入 5 个静态新工具

## 设计取舍

- 8.4 用 `tsc --noEmit` 轻量诊断，避免 ts-server 长连接的进程生命周期负担；`lsp.ts` 的 `Diagnostic` 形状稳定，M11 可平滑换真 LSP
- plan 模式工具直接 mutate `context.permissionMode`：agent loop 单次调用内复用同一 `ToolContext`，故「进入规划→只读调查→退出→落地」在一次循环内闭环
- ToolSearch / MCP 资源工具用工厂注入（registry getter / MCPManager），避免与 tools.ts 形成强耦合，便于用假对象测试

## 验收

- `tsc --noEmit` 通过；`vitest run` → 25 文件 / **248 passed**（M7 为 223，新增 25：tools-m8 25 个用例）
- 真机冒烟：`/tools` 显示 **19** 个工具，8 个新工具全部正确加载

---

# M9 — TUI 渲染层升级（2026-06-20）

## 目标

把 line-based 输出升级为真 Ink (React 19 + ink 7) 全屏 TUI，对齐官方交互体验；非 TTY 保留 line 模式 fallback。

## 架构

命令式 agent loop ↔ 声明式 React 的桥接用一个**可观察 store**（`TuiStore`，纯 pub/sub 无 React 依赖）：REPL 编排把 `LoopEvent` 写进 store，Ink `<App>` 经 `useSyncExternalStore` 订阅重渲染。已完成 transcript 进 `<Static>`（打印一次、滚入历史、不重绘 → 流式无闪烁），活跃区显示流式文本 + 工具卡片 + spinner。

## 新增模块（src/tui/）

| 文件 | 职责 |
|---|---|
| `store.ts` | 可观察状态容器：transcript / 流式文本 / 活跃工具 / token / overlay（含 askPermission、askQuestion 返回 Promise） |
| `App.tsx` | 根组件：Static 历史区 + 实时流式区 + spinner + 状态栏 + overlay/输入框切换 |
| `ToolCard.tsx` | 活跃工具卡片（spinner）+ 完成卡片（9.3）；长结果折叠/展开（9.4，预览 12 行 + ctrl+r 提示） |
| `Prompts.tsx` | 权限菜单 + 单/多选提问 overlay，方向键选择（9.5） |
| `InputBox.tsx` | useInput 输入框 + `/` 命令自动补全下拉，busy 时禁用 |
| `run.tsx` | Ink render + 每轮 agent loop 编排：事件→store；slash 命令 console.log 捕获进 transcript；每轮 AbortController + SIGINT 中断（9.6） |

## 接入与降级（9.1 / 9.7）

- `cli.ts`：`isInteractive && !--no-tui` → `await import("./tui/run.js")` 动态加载并 `runTui(...)`，结束后保存 session + 断开 MCP 后 return；否则 fall through 到原 line-based REPL
- `tsconfig.json`：加 `"jsx": "react-jsx"`（对现有 .ts 零影响）
- 依赖：ink@7.1.0 / react@19.2.7 / ink-spinner@5.0.0；devDep @types/react、ink-testing-library@4.0.0
  - 注：M23 已移除未用 `ink-spinner`，改为共享 `spinner-core.ts` + TUI `StatusLine`/`SpinnerGlyph`。

## 验收

- `tsc --noEmit` 通过；`npm run build` 编译 .tsx → dist/tui/
- `vitest run` → 27 文件 / **265 passed**（M8 为 248，新增 17：tui-store 9 + tui-components 8，用 ink-testing-library 渲染断言）
- 运行时冒烟：dist/tui/run.js 模块图（含 ink/react ESM）干净加载
- fallback 实测：管道输入仍走 line 模式，`/tools` 正常、`Goodbye!` 正常退出

## 设计取舍

- slash 命令仍用 console.log，TUI 下临时捕获 console.log 收集为 transcript log item，避免重写 commands.ts 全部输出
- 输入框用 ink `useInput` 自实现，不引入 ink-text-input，复用已有输入逻辑经验、零额外依赖
- React 组件层用 ink-testing-library 渲染到虚拟终端断言，弥补 store 之外的 UI 覆盖

---

# M10 — 多代理协作（2026-06-20）

## 目标

从「一次性 task 子代理」升级到「有状态的具名团队」：主 agent 可创建多个保留各自历史的协作 agent，点对点发消息续聊。

## 架构

独立 `src/team.ts` 有状态层，按 sessionId 隔离（同 read-tracker/change-tracker 模式）。每个 `TeamAgent` 持有自己的 `messages` 历史 + 状态机（idle/running/done/error/stopped）。`runAgentTurn` 复用 agentLoop——它原地 mutate messages 数组，所以多次 send_message 历史自然累积、可续聊。角色复用现有 subagents 注册表（code-explorer/code-reviewer/general）。

## 新增工具（5 个，src/tools-team.ts）

| 工具 | 作用 | 对应 |
|---|---|---|
| `team_create` | 创建一组具名 agent（{role, name?}[]） | 10.1 |
| `send_message` | 向指定 agent 发消息，跑一轮返回回复；`background:true` fire-and-forget | 10.2 / 10.4 |
| `task_list` | 列出全部 agent 的 id/role/状态/工具调用数/输出预览 | 10.3 |
| `task_get` | 查询单个 agent 状态 + 完整最新输出（后台轮询用） | 10.3 / 10.4 |
| `task_stop` | 终止 agent（运行中则 abort，历史保留） | 10.3 |

## 接线

- `src/tools.ts`：`...TEAM_TOOLS` 加入 CORE_TOOLS；team.ts 用 lazy import 取核心工具，避免与 tools.ts 循环依赖
- agent 间通信走主 agent 点对点编排（非全自主群聊），简单可控可测试
- 10.4 轻量后台：`send_message background` 不 await、状态置 running，完成后回写 done + lastOutput，`task_get`/`task_list` 反映——不改 agent-loop 核心

## 验收

- `tsc --noEmit` 通过；`vitest run` → 28 文件 / **280 passed**（M9 为 265，新增 15：team 状态 + runAgentTurn + 5 工具全链路，用 vi.mock 假 model）
- 真机冒烟：`/tools` 显示 **24** 个工具，5 个 team 工具全部加载

## 设计取舍

- 复用 subagents 注册表角色而非新建角色体系，保持一致
- 后台并发未加信号量上限（主 agent 通常串行点对点），留作后续；如需大规模 fan-out 可复用 task-tool 的 semaphore 思路

---

# M11 — 生态与集成（2026-06-20）

## 目标

把生态深度补齐到接近官方：MCP 不再只支持 stdio，新增 SSE/WS/HTTP 三路传输与 OAuth 鉴权；模型侧支持云厂商网关（Bedrock/Vertex）；并提供默认关闭、纯本地的遥测开关。

## 11.1 MCP 多传输

`src/mcp.ts` 的网络传输按 type 正确分发（此前 sse/http 都误用了 StreamableHTTP）：

| type | transport | 说明 |
|---|---|---|
| `stdio` | StdioClientTransport | 本地子进程（原有） |
| `http` | StreamableHTTPClientTransport | 当前标准，支持 OAuth |
| `sse` | SSEClientTransport | 旧式但仍常见，支持 OAuth |
| `ws` | WebSocketClientTransport | 新增；SDK 不支持 per-request header/auth |

抽出 `createNetworkTransport()` 统一构造，`MCPTransportType` 加入 `ws`，config 新增可选 `oauth` 块。

## 11.2 MCP OAuth 鉴权

新增 `src/mcp-auth.ts` — `FileTokenOAuthProvider` 实现 SDK 的 `OAuthClientProvider`：

- 文件态持久化（`~/.claude/mcp-auth/<server>.json`，mode 0600/0700），跨运行保留 token / 注册的 client / PKCE verifier
- 支持静态 clientId/secret 或动态注册；PKCE 由 SDK 驱动
- 首次 `connect` 抛 Unauthorized → 触发一次性交互授权：打印授权 URL + 起 127.0.0.1 本地回调服务器捕获 code → `finishAuth` 换 token → 重连
- 安全：从不打印 token 值；回调服务器仅绑本地、拿到 code 即关；store 目录可注入（测试用）

## 11.3 云厂商网关（Bedrock/Vertex）

新增 `src/cloud-gateway.ts`，在 `resolveProviderConfig` 接线：

- Bedrock → `https://bedrock-runtime.<region>.amazonaws.com/openai/v1`
- Vertex → `https://<region>-aiplatform.googleapis.com/.../endpoints/openapi`（需 project）
- 两者均走 OpenAI 兼容面，复用现有 caller；**不打包云 SDK、不签 SigV4/GCP**，token 由用户经 `LLM_API_KEY` 提供（保持薄层）
- env：`LLM_GATEWAY=bedrock|vertex` + `LLM_GATEWAY_REGION` + `LLM_GATEWAY_PROJECT`；显式 `baseURL` 仍可覆盖

## 11.4 本地遥测开关

新增 `src/telemetry.ts` — **默认关闭、纯本地、绝不外发**：

- 开关优先级：`CCR_TELEMETRY`/`LLM_TELEMETRY` env（1/0）> `.claude/settings.json` `{telemetry:{enabled}}`
- 开启后追加 JSONL 到 `.claude/telemetry/events.jsonl`，只记事件名/计数/粗粒度元数据（provider/model/token 总数），**不记 prompt/响应内容**
- cli.ts 接线 session_start / tool_results / turn / session_end；关闭时全是廉价 no-op，且永不抛错打断会话

## 验收

- `tsc --noEmit` 通过；`vitest run` → 31 文件 / **304 passed**（M10 为 280，新增 24：cloud-gateway 8 / telemetry 8 / mcp-auth 8）
- 构建通过；运行时冒烟：Bedrock URL 解析正确、`isCloudGateway` 正确、Telemetry 关态 no-op、MCPManager 含 ws 传输

## 设计取舍

- 云网关走「薄路由层」而非内嵌 AWS/GCP SDK：避免重依赖与凭证签名复杂度，token 交给用户提供；后续若要原生 SigV4/ADC 可再加
- WS 传输不带 OAuth：SDK 的 WebSocketClientTransport 不接受 header/authProvider，OAuth 仅对 http/sse 生效
- 遥测刻意「内容零采集」：隐私优先，只够本地排查用量，不向官方那样上报

---

# M12 — QueryEngine 深度优化（2026-06-20）

## 目标

把上下文工程与缓存逼近官方 QueryEngine：智能压缩（不再整段切）、推测预取降延迟、prompt cache 命中可观测、自动注入 git/项目记忆。

## 12.1 snip 智能压缩

新增 `src/context-snip.ts` — 在 LLM 全量摘要（autoCompact）**之前**先跑一遍廉价的按重要性裁剪：

- 保护最近 N 条消息（默认 10）、所有非 tool 消息——绝不动
- 只裁老旧、超大（默认 ≥2000 字符）的 tool result → 留 head(600)+tail(400) + `[…snipped…]` 标记
- 纯函数、不 mutate 输入、幂等（二次跑不再裁）
- 接线 agent-loop：超阈值先 snip，若仍超阈值才回退全量 compact——常常直接免掉 LLM 摘要那次往返

## 12.2 speculation 推测预取

新增 `src/speculation.ts`：

- `predictReads(grep|glob 结果)` → 预测后续会 Read 哪些文件（去重、限量）
- `SpeculationCache`：后台预取这些 Read，模型真请求时秒回；**只预取只读+并发安全工具**，每 key 单次消费，记 hits/misses/prefetched
- 猜错零成本（真工具照常跑）；默认关，`CCR_SPECULATION=1` 或 `--speculation` 开
- 接线 agent-loop：执行工具结果后预取，`executeSingleTool` 先查缓存命中再真跑

## 12.3 prompt cache 精修 + 指标

`src/anthropic-adapter.ts`：

- 给 **tools 末项**加 `cache_control` 断点（缓存整个稳定的 tools 前缀）
- 给**末条消息末块**加断点（`withMessageCacheBreakpoint`，缓存随轮次增长的历史前缀）
- `done` 事件透出 `cache_read_input_tokens` / `cache_creation_input_tokens`
- `StreamEvent`/`LoopEvent` 的 usage 扩展缓存字段；`SessionStats` 增 `cacheReadTokens`/`cacheCreationTokens`/`cacheHitRate`
- `/cost` 显示「Cache: X% hit (read / written)」

## 12.4 Git/CLAUDE.md 上下文注入

新增 `src/git-context.ts`：

- 采集 branch / 脏文件（porcelain，限量+截断标记）/ 近期提交（log）
- 全只读、3s 超时、非 git 目录或 git 缺失 → null（永不抛）
- `formatGitContext` 渲染为 `[GIT STATUS]` 块，cli.ts 注入 `buildSystemPrompt`（system-prompt 早已支持 gitStatus 字段，此前未接线）

## 验收

- `tsc --noEmit` 通过；`vitest run` → 35 文件 / **332 passed**（M11 为 304，新增 28：context-snip 6 / speculation 9 / git-context 5 / prompt-cache 8）
- 构建通过；运行时冒烟：snip 裁 4000 字符、predictReads 出 2 个 Read、cacheHitRate 80%、git 非仓库返回 null
- 修了 1 个既有断言（anthropic-adapter formatTools 现带 cache_control）

## 设计取舍

- snip 作为 compact 前置而非替代：保留全量摘要兜底，但优先用无损裁剪争取 headroom
- speculation 默认关：预取虽零正确性风险，但有额外 IO；交给用户/场景按需开
- cache 指标走「read/(input 含 read+creation)」口径，与 adapter 求和方式一致，命中率口径自洽
- git 注入走只读快照而非常驻 watch：简单、无副作用，开销可控

---

# M13 — Slash 命令广度二期（进行中）

## 13.7 `/effort` 推理强度滑块

对齐官方 Claude Code 的 `/effort` 滑块：`low → medium → high → xhigh → max`（Faster ▶ Smarter）外加 `ultracode`（xhigh + workflows，倾向多代理编排）。参照 6 张官方效果图（`effor效果图/`）实现为**交互式覆盖层**，而非静态打印。

新增 `src/effort.ts`：

- `EFFORT_GRADIENT` / `EFFORT_LEVELS` / `DEFAULT_EFFORT`（默认 high）+ 每档一行说明，严格对照官方语义
- `parseEffort`（大小写无关校验）/ `getEffort`（从 `options.effort` 读取，缺省回落 high）
- `anthropicEffort`（透传 gradient，`ultracode → xhigh`）/ `openaiReasoningEffort`（≥high 截断为 high）
- `modelSupportsReasoningEffort`（仅推理模型下发 `reasoning_effort`，避免对普通 chat 模型 400）
- 色彩工具：`hslToHex` / `gradientColorAt`（冷青→暖红渐变）/ `rainbowColors`（官方 voice-waveform HSL 参数 s=0.7/l=0.6，按 phase 偏移驱动 max 彩虹流动）

新增 `src/tui/ParticleSpinner.tsx`（AI 思考转圈，历史实现；M23 后已删除，替换为 `SpinnerGlyph.tsx` + `StatusLine.tsx`）：

- 当时循环官方粒子字符集 `['·','✢','✳','✶','✻','✽']`（正放+倒放，120ms/帧），替换 TUI 原 ink-spinner 的 `dots`
- 当时 CLI 行内 spinner（`cli-spinner.ts`）字符集对齐同集（原 `*` → `✳`）
- 注：当前 M23 实现已改为共享 `spinner-core.ts`，帧集按用户偏好移除 `✳`，现为 `· ✢ ✶ ✻ ✽`。

新增 `src/tui/EffortPrompt.tsx` + `src/tui/effort-fx.ts`（交互式滑块覆盖层）：

- **布局对齐官方终端样式**：顶部全宽分割线 + 左缩进 `Effort` 标题 + **水平居中**轨道（按终端宽度算 leftPad，不偏左右）；`Faster … Smarter` 两端 + `▲` 标记 + `┆` 分隔 + `low medium high xhigh max ┆ ultracode` + `xhigh + workflows` 副标签 + 底部 `←/→ adjust · Enter · Esc` 提示
- `←/→` 切档（钳位不循环）、`1-6` 直选、Enter 确认、Esc 取消
- **max 特效**：整条轨道彩虹流动 + "max" 标签逐字符彩虹闪烁（官方 hueToRgb 流光）
- **ultracode 赛博紫像素场特效**（经多轮打磨，最终态）：
  - 全屏紫调像素**分层渐变**背景（`bgHex`），矩形**左右顶格**全宽，上沿在 Effort 上方白线**下一行**（不越界），下沿到文字上方空行
  - **以 `▲` 为圆心的同心圆水波**：`sin(dist·0.24 − phase·0.08)` —— 圆环放射状向外扩散（频率/速度均按反馈调缓）
  - **切入淡入扩散**：进入时圆从 `▲` 缓慢长大铺满矩形（`fillR = maxDist·fade²` ease-in，`FADE_FRAMES=26`），铺满后持续放射同心圆波纹
  - **竖条像素故障抖动**：列条按 hash 偶发 ±1 行偏移（赛博故障感）
  - **bloom 呼吸光晕**：全局亮度 `(sin(phase·0.08)+1)/2`
  - 配色 `violet()` = HSL 262°（电光靛紫）、饱和 0.95、亮度 0.12–0.62，鲜艳厚重（波峰约 rgb(154,58,250)）
- 帧构建抽到纯函数 `effort-fx.ts`（`buildEffortFrame({active,phase,cols,fade})` 返回 ANSI 字符串数组），EffortPrompt 只管计时+输入+fade 计数，便于单测

接线：

- TUI（run.tsx）：`/effort` 无参 → 打开交互式 overlay（store 新增 `effort` overlay + `askEffort`，App.tsx 渲染）；`/effort <level>` 仍走静态命令
- 非 TTY（commands.ts）：保留静态滑块 `renderEffortSlider`（管道/CI 无法交互）
- 写 `modelConfig.options.effort`，因 modelConfig 全程同一引用、agent loop 每轮重读，**下一轮即生效**
- Anthropic 适配器：`output_config.effort` 由硬编码 "high" 改为按档映射（显式 output_config 仍优先）
- OpenAI 兼容适配器：对推理模型注入 `reasoning_effort`
- `/status` `/config` 同步显示当前 effort

## 验收

- `tsc --noEmit` 通过；`vitest run` → 39 文件 / **367 passed**（M12 为 332，新增 35：effort 模块 11 + commands 4 + EffortPrompt 组件 3 + effort-fx 帧构建 11 + 既有补充）
- 渲染核对：6 档逐张渲染（亮度/背景字符图），布局居中对齐官方贴样；max 彩虹流动；ultracode 圆从 `▲` 扩散铺满 + 同心圆波纹 + 故障抖动 + bloom 均生效；矩形上沿不越界、文字行不下移、`▲` 无缺口
- 命令数 17 → **18**

## 迭代记录（按用户反馈逐轮收敛）

1. 初版误做成静态 `console.log` → 改为 Ink 交互式 overlay
2. ultracode 初版（能量爆发：粒子行/环形行/`✦▲✦`）会把文字挤下移、`▲` 有缺口 → 去掉多余行，行数与其它档一致、单 `▲`
3. 按用户描述重做为「以 `▲` 为圆心的紫色水波扩散填满矩形」；spinner 换粒子集；max 用官方彩虹；矩形左右顶格、圆心移到 `▲`
4. 紫色偏暗偏灰 → 提饱和到 0.95、改电光靛紫 262°，更鲜艳厚重
5. 波纹方向错（斜向条带）→ 改为放射状同心圆 `sin(dist − phase)`
6. 第二段波纹太快 → 速度系数调小（→ 0.08）
7. 波纹频率太高 → 空间频率 `0.5 → 0.24`，环更稀疏
8. 矩形上沿越界压住白线 → `RECT_TOP 0 → 1`，白线保持干净 dim 横线

## 设计取舍

- 帧构建做成纯函数模块：动画/输入与渲染解耦，特效可脱离 Ink 单测（强制 `chalk.level=3` 验证颜色）
- 交互式 overlay 复用现有权限/提问菜单的同一套 store overlay 机制：零新增渲染管线
- 特效动画仅在 max/ultracode 选中时 `setInterval`、离开 `clearInterval`：其余档位零开销，无常驻定时器
- ultracode 用「填充扩散 + 放射同心圆 + 像素故障 + bloom」分层叠加，全部画成**背景** wash（不增行、不移文字）；颜色走 ANSI truecolor
- effort 存 `modelConfig.options.effort`；OpenAI 路径按模型能力 gate `reasoning_effort`（避免严格 provider 400）；`ultracode → xhigh`（官方定义 xhigh + workflows，workflows 属行为层）

---

# M17 — TUI 启动界面布局重做（2026-06-25）

## 目标

修复用户实测 `npm start` 的三个体感问题，对齐官方 Claude Code 启动界面观感：

1. 输入框与上方 AI 回答相隔太远（ScrollBox 高度硬编码半屏，输入框另起一块，中间夹大段空白）
2. 回答超出 ScrollBox 无法下滑回看（仅滚 LIVE_WINDOW=8 条，老历史进 `<Static>` 但 alt-buffer 无原生回滚）
3. `/` 指令只显示前 8 条；输入框光标只能左右、多行无法上下换行

参照 `reference/components/FullscreenLayout.tsx`、`reference/ink/components/ScrollBox.tsx`、`reference/ink/components/AlternateScreen.tsx`。本项目 ink7/react19 无自研 reconciler，不照搬官方 imperative ScrollBox，在现有纯 React state 版 ScrollBox 上做布局重排。

## 17.1 全屏 alt-screen 进入/退出（src/tui/run.tsx）

`runTui` 启动前 `process.stdout.write("\x1B[?1049h\x1B[2J\x1B[H")` 进 DEC 1049 alt buffer；`waitUntilExit().finally()` + `process.on("exit")` 双保险写 `\x1B[?1049l` 恢复主屏（含异常退出，stdout 已关时 try/catch 兜底）；`render(..., { exitOnCtrlC:false, patchConsole:false })`。banner 仍打印进 alt buffer（在 Ink 接管前）。

## 17.2 根布局全屏贴底 + resize 监听（src/tui/App.tsx）

- 根 `<Box flexDirection="column" height={rows}>` 钉到终端高度。
- 新增 `useTerminalSize()`：`useSyncExternalStore` 订阅 `process.stdout` "resize"，返回 `(rows, cols)`，布局随窗口变化重渲染。
- `scrollHeight = rows - inputRows - statusBarRows`；`inputRows = 3 + (下拉打开? DROPDOWN_VISIBLE : 0)`，`DROPDOWN_VISIBLE = min(8, max(3, rows-6))`；`statusBarRows = 2`。输入框紧贴 ScrollBox 底部，无空白。
- InputBox 接收 `cols` prop，分隔线宽度随 resize（原模块级 `RULE_WIDTH` 常量改运行时 `Math.max(20, cols)`）。

## 17.3 全量历史进 ScrollBox（取消 `<Static>`）

alt buffer 无原生回滚，`<Static>` 失效。删除 `LIVE_WINDOW=8` 切分与 `Transcript` 的 `<Static>` 分支，**全部** transcript 进 ScrollBox `rows`，成为唯一滚动容器。ScrollBox 每次 render 仅 slice `h` 行渲染 O(h)，总量不影响；follow 贴底、browse 定位、PgUp/PgDn/Home/End 提供回看。`disableArrows` 改为 `!overlay`（InputBox 活跃即让出 ↑/↓，回看主推 PgUp/PgDn）。

## 17.4 `/` 命令面板全部展开 + 分页（src/tui/InputBox.tsx）

删 `MAX_SUGGESTIONS=8`，`suggestions` 全集过滤；`selected` 在全集循环；`startIndex = clamp(selected - floor(maxVisible/2), 0, len-maxVisible)` 窗口跟随（照搬 `reference/.../PromptInputFooterSuggestions.tsx:238`）；只渲染窗口内 `maxVisible=min(8,len)` 条；超窗显示 `(N/total) ↑↓ to browse` 计数；命令名列对齐 `nameWidth=floor(cols*0.3)`，用空格 padding 而非 `padEnd` slice 避免 ANSI/全宽错位。

## 17.5 输入框多行 + 上下光标（src/tui/InputBox.tsx）

- `Ctrl+J` 插 `\n`（Shift+Enter 多数终端不可靠，故选 Ctrl+J）。
- 新增纯函数 `lineStart/lineEnd/moveVertical`：按 `\n` 分行，由 `cursor` 算 (row,col)，↑/↓ 同列移动并按目标行长 clamp；无下拉时接管 ↑/↓ 走光标，有下拉时仍走选择。
- Ctrl+A/E 与 Home/End 改为行首/行尾（多行语义，非整 buffer 边缘）。
- Backspace 在 `\n` 处自然并行（删换行符 join 行）。
- `CursorText` 整串切含 `\n` 时 Ink 自然换行、inverse 光标贴字符。

## 17.6 状态栏 / `/keybindings` 同步

- StatusBar 改两行（提示行 + model/token 行），提示含 `↑↓ cursor/cmd · ←→ move · Ctrl+J newline · / commands · @path attach · PgUp/PgDn scroll`。
- `src/commands.ts` `/keybindings` 表追加 Ctrl+J（换行）、PgUp/PgDn（滚动回看）、Home/End，并细化 ↑/↓ / ←/→ / Ctrl+A/E 描述。

## 验收

- `tsc --noEmit` 干净；`npm run build` 通过。
- `vitest run` → **44 文件 / 458 用例全绿**（本轮净 +8：input-box +4 含多行光标/分页、tui-components +1 全屏贴底+全量面板、tui-scrollbox +2 大历史 follow/PgUp 回首条，外加 App 签名变更适配）。
- 真机冒烟（piped `hi\r`）：启动进 alt screen、回答在滚动区、输入框贴底、退出恢复主屏，均正常。
- 视觉冒烟（ink-testing-library 模拟 30 轮长会话 + 面板打开）：长历史 follow 贴底显示末轮、`/` 面板窗口化 + 计数 `(1/26)` 正常。

## 设计取舍

- 取消 `<Static>` 改全量 ScrollBox：长会话每次 slice O(h) 可接受；若实测卡顿再加窗口化（仅最近 N 条进 ScrollBox + 老历史落盘）。
- alt screen 无原生滚轮，PgUp/PgDn 是主回看键（状态栏已明示）。
- Ctrl+J 换行键可后续按用户偏好再调（如改 Shift+Enter 配合终端配置）。

---

# 最新项目状态

| 指标 | 当前值 |
|---|---|
| 主线里程碑 | M1–M16 完成；M17 ✅（TUI 启动界面布局重做） |
| 测试数量 | **458 passed** |
| 渲染层 | 真 Ink (React 19) TUI + 非 TTY line fallback；**全屏 alt-screen + 输入框贴底 + 全量历史 ScrollBox 回看**；思考转圈用粒子字符集 |
| 核心工具 | **24 个**（含 5 个 Team 协作工具） |
| Slash 命令 | **26 个** |
| 推理强度 | `/effort` low/medium/high/xhigh/max/ultracode 交互滑块；max 彩虹流光、ultracode 赛博紫像素水波；按 provider 映射 |
| 输入框 | 多行（Ctrl+J 换行）+ ↑/↓ 行间光标 + ←/→ 行内 + `/` 全命令面板分页 |
| 多代理 | Team 有状态协作（create/send/list/get/stop + 轻量后台） |
| MCP 传输 | stdio + http + sse + ws，含 OAuth 鉴权 |
| 模型路由 | 多 provider + 云网关（Bedrock/Vertex，OpenAI 兼容面） |
| 遥测 | 本地 JSONL，默认关、可 env/settings 开、零内容采集 |
| 上下文工程 | snip 智能压缩 + speculation 预取 + prompt cache 命中观测 + git 注入 |
| 构建 | `npm run build` 通过 |
| 当前 provider | DeepSeek / OpenAI-compatible 路径真机跑通 |
| Anthropic 路径 | SDK 路由已验证，完整真机待有效 key |
| 日常可用性 | 已具备本地 AI coding assistant 日常使用条件 |

---

# 一句话总结

M17 TUI 启动界面布局重做落地——进 alt-screen 全屏、ScrollBox 占满终端剩余高度承载全量历史（取消 `<Static>`）、输入框紧贴最底无空白、`/` 面板显示全部 26 命令可分页、输入框支持多行（Ctrl+J 换行）+ ↑/↓ 行间光标；PgUp/PgDn 回看、状态栏与 `/keybindings` 同步；tsc 干净，测试 450→458 全绿，真机冒烟 OK。

