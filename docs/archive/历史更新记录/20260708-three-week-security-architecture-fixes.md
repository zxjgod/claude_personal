# 更新日志 — 三周安全与架构优化

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-07-08
> 类型：fix | feature
> 模块：BashTool、agent-loop、team.ts、MCP、web-fetch、session-memory
> 主题：安全修复、usage 口径统一、Web 工具验证增强、会话 I/O 异步化
> 状态：已落地
> 验证：`npm run build` 通过、`npx vitest run` 994/994 全过
> 关联文档：项目审查报告 (20260708)

---

## 一、现象 / 用户反馈

本次更新来自项目全面审查（ultracode 模式），发现以下问题：

| # | 问题 | 影响范围 |
|---|------|----------|
| 1 | Team 子代理权限链路缺失 | S-2: 子代理可绕过权限执行危险操作 |
| 2 | usage 口径不一致 | S-4: Anthropic cache token 双重计数导致 autoCompact 判断偏差 |
| 3 | Web 工具 SSRF 防护分散 | P1-1: web-fetch 独自实现验证逻辑，与 InputValidator 不统一 |
| 4 | MCP schema 缺少类型安全 | P1-4: `as any` 类型断言导致恶意 schema 注入风险 |
| 5 | 会话加载使用同步 I/O | M-7: 大型会话文件阻塞事件循环 |

---

## 二、根因

| # | 缺陷 | 位置 | 后果 |
|---|------|------|------|
| 1 | Team 使用 `ctx.askUser` 直接传递，未通过 `createSubAgentApprover()` 包装 | `src/team.ts:237-240` | 无父级 approver 时全放行 |
| 2 | agent-loop 在 `promptTokens` 计算中额外加 `cache_creation_input_tokens` | `src/agent-loop.ts:407-410` | Anthropic 路径双重计数 |
| 3 | web-fetch 有独立的 `BLOCKED_HOSTS` + `isBlockedHost()` | `src/tools/extended/web-fetch.ts:20-31, 43-47` | 代码重复，维护成本高 |
| 4 | `typeof rawSchema.properties === "object"` 无法防止函数/数组注入 | `src/mcp.ts:218` | 恶意 schema 可注入非对象类型 |
| 5 | `fs.readFileSync` / `fs.writeFileSync` 阻塞事件循环 | `src/session-memory.ts:121, 150-151` | 大文件会话加载卡 UI |

---

## 三、改动明细

### `src/team.ts` — S-2 子代理权限继承

**问题**：`runAgentTurn()` 直接使用 `ctx.askUser`，当无父级 approver 时危险工具被全放行。

**修复**：使用 `createSubAgentApprover()` 包装：

```diff
+ import { createSubAgentApprover } from "./utils/subagent-security.js";

  const coreTools = await getCoreToolsForSubagents();
  const tools = resolveSubagentTools(role, coreTools);
+ 
+ // P0 Security Fix: Use restricted approver to prevent sub-agents
+ // from bypassing permissions on dangerous tools (bash/write/edit)
+ const subApprover = createSubAgentApprover(ctx.askUser, true);
+
  const loop = agentLoop(agent.messages, tools, caller, ctx.modelConfig, {
    ...
    toolContext: {
      ...
-     askUser: ctx.askUser,
+     askUser: subApprover,
    },
-   askUser: ctx.askUser,
+   askUser: subApprover,
  });
```

现在与 `task.ts` (fork 模式) 保持一致，危险工具（bash/write/edit）需要父级确认。

---

### `src/agent-loop.ts` — S-4 usage 口径统一

**问题**：Anthropic 适配器已正确将 `input_tokens` 设为不含 cache 的值，但 agent-loop 又额外加上了 `cache_creation_input_tokens`，导致双重计数。

**修复**：

```diff
- const promptTokens =
-   event.usage.input_tokens +
-   (event.usage.cache_read_input_tokens ?? 0) +
-   (event.usage.cache_creation_input_tokens ?? 0);
+ // S-4 fix: use input_tokens as-is — it's the authoritative live context
+ // size from the provider.
+ const promptTokens = event.usage.input_tokens;
```

`input_tokens` 现在直接使用 provider 报告的值，避免了 Anthropic 路径的 cache token 双重计数。

---

### `src/mcp.ts` — P1-4 MCP schema 类型安全

**问题**：`typeof rawSchema.properties === "object"` 检查过于宽松，无法防止恶意 schema 注入。

**修复**：

```diff
- const inputSchema: Tool["inputSchema"] = {
-   type: "object",
-   properties:
-     rawSchema.properties && typeof rawSchema.properties === "object"
-       ? rawSchema.properties
-       : {},
-   required: Array.isArray(rawSchema.required) ? rawSchema.required : [],
- };
+ // P1-4: Build input schema with type-safe validation
+ const rawProperties = rawSchema.properties;
+
+ // Validate properties is a plain object (not an array, function, etc.)
+ if (rawProperties !== null && (typeof rawProperties !== "object" || Array.isArray(rawProperties))) {
+   console.warn(`MCP tool "${remoteTool.name}": invalid schema.properties type, skipping`);
+   return null;  // Filter out invalid tools
+ }
+
+ const inputSchema: Tool["inputSchema"] = {
+   type: "object",
+   properties: rawProperties ?? {},
+   required: Array.isArray(rawSchema.required) ? rawSchema.required : [],
+ };
```

无效 schema 的工具被跳过并记录警告。

---

### `src/tools/extended/web-fetch.ts` — P1-1 URL 验证统一

**问题**：web-fetch 有独立的 SSRF 防护实现，与 InputValidator 不一致。

**修复**：删除重复实现，使用统一的 `InputValidator.validateUrl()`：

```diff
- // 删除 BLOCKED_HOSTS 数组和 isBlockedHost() 函数 (-21 行)
-
  import { InputValidator } from "../../utils/input-validator.js";

  async call(input, _context): Promise<ToolResult> {
-   // --- SSRF check ---
-   let parsed: URL;
-   try {
-     parsed = new URL(input.url);
-   } catch { ... }
-   if (!["http:", "https:"].includes(parsed.protocol)) { ... }
-   if (isBlockedHost(parsed.hostname)) { ... }
+   // P1-1: Use InputValidator for consistent URL validation
+   const validation = InputValidator.validateUrl(input.url);
+   if (!validation.valid) {
+     return { content: "", error: validation.error ?? "Invalid URL" };
+   }
  }
```

删除 45 行冗余代码，统一使用 InputValidator。

---

### `src/session-memory.ts` — M-7 会话加载异步化

**问题**：`fs.readFileSync` / `fs.writeFileSync` 在大型会话文件上阻塞事件循环。

**修复**：全部改用 `fs/promises`：

```diff
- import * as fs from "node:fs";
+ import * as fs from "node:fs";
+ import * as fsPromises from "node:fs/promises";

  async load(sessionId: string): Promise<SessionData | null> {
-   return this.loadSync(sessionId);  // 同步调用
+   const filePath = this.sessionPath(sessionId);
+   try {
+     const raw = await fsPromises.readFile(filePath, "utf-8");
+     ...
+   }
  }

  private async saveSerialized(...) {
    ...
-   fs.writeFileSync(tmpPath, json, "utf-8");
-   fs.renameSync(tmpPath, filePath);
+   await fsPromises.writeFile(tmpPath, json, "utf-8");
+   await fsPromises.rename(tmpPath, filePath);
  }
```

删除 `loadSync()` 私有方法，统一使用 async `load()`。

---

### `src/__tests__/new-tools.test.ts` — 测试更新

测试断言需要随错误消息变化更新：

```diff
- expect(result.error).toContain("internal");
+ expect(result.error).toContain("private");

- expect(result.error).toContain("Unsupported protocol");
+ expect(result.error).toContain("not allowed");
```

---

## 四、验证结果

| 验证项 | 结果 |
|---|---|
| `npm run build` | 通过，0 错误 |
| `npx vitest run` | 994 / 994 全过 |

---

## 五、受影响文件

**修改**
- `src/team.ts` — S-2 子代理权限继承
- `src/agent-loop.ts` — S-4 usage 口径统一
- `src/mcp.ts` — P1-4 MCP schema 类型安全
- `src/tools/extended/web-fetch.ts` — P1-1 URL 验证统一
- `src/session-memory.ts` — M-7 会话异步 I/O
- `src/__tests__/new-tools.test.ts` — 测试断言更新

---

## 六、设计决策记录

1. **Web 工具验证统一** — 删除 web-fetch 独立实现，统一使用 `InputValidator.validateUrl()`，保持整个项目的验证逻辑一致性。

2. **MCP schema 无效工具跳过** — 当 schema.properties 类型无效时跳过该工具而非抛出错误，保持 MCP 连接可用性，避免一个恶意工具破坏整个 MCP server。

3. **Usage 口径** — 直接使用 provider 报告的 `input_tokens`，不再手动加上 cache token。Anthropic 和 OpenAI 路径现在报告一致的含义。

---

## 七、已确认无需修复的问题

审查中发现以下问题经分析后确认无需修复：

| 问题 | 分析结论 |
|------|----------|
| S-1: Bash 审批链路 | 链路完整，`isReadOnly()` 对只读命令自动放行是设计行为 |
| S-3: MCP 工具免审批 | 已实现首次确认 + sticky `confirmedMcpTools` 集合 |
| M-2: Diff LCS | 已是 LCS 实现（之前重构完成） |
| M-4: 循环依赖 | 通过 `setCoreToolsForSubagents()` 注入解决 |
| M-5: 工具注册统一 | `CORE_TOOLS` 是唯一来源，`ToolRegistry` 用于扩展 |
| M-32: 回合预算 | 完整实现于 `token-budget.ts` + `hooks.ts` |
