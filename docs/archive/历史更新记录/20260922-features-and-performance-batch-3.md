# 功能与性能增强 · 批次 3

> 完成时间：2026-09-22
> 方案来源：[功能与性能增强实施方案](../reports/20260922-功能与性能增强实施方案.md)（批次 3 / 共 4 批）
> 状态：✅ **全部完成** — typecheck 0 错误、vitest 1788/1788 全绿、smoke PASSED

---

## 本批内容（4 项结构性改动）

### P1 · Anthropic 适配器逐 block 发 tool_use（本批核心收益）

**问题**：适配器流循环只 yield `text_delta`/`thinking`，tool_use 全部等 `finalMessage()` 之后枚举——`agent-loop` 的 `StreamingToolExecutor`（专为"把工具延迟藏进模型剩余流式时间"设计）在 Anthropic 主路径上的早启动窗口 ≈ 0。

**实现**（`anthropic-adapter.ts`）：
- 流循环按 **stream index** 维护 per-block 累积器：`content_block_start`(tool_use) 登记 `{id, name, jsonBuf}`，`input_json_delta` 追加，`content_block_stop` 时 `JSON.parse` 立即 `yield tool_use`——参数此时已完整。
- `finalMessage()` 后按 **id 去重**，只补发流边界漏掉的块（畸形 JSON 容错回退）；thinking/redacted 仍走 finalMessage（签名只在最终消息存在）。
- 效果：Read/Grep 等安全工具与模型剩余输出并行执行，每 turn 省秒级延迟；OpenAI 路径本就在 finish chunk 提前发，不动。

### F3 · 后台子代理（run_in_background 兑现）

**问题**：`agent.ts` schema 声明 `run_in_background` 但 `call()` 从未读取；`job-store` 的 `kind: "agent"` 有完整消费侧（JobOutput/JobKill/JobList、M41 完成通知）却无生产者。

**实现**：后台分支**剥掉标志位重入 `AgentTool.call` 自身**——槽位、审批、worktree 清理、abort 级联全部复用唯一的前台代码路径，零逻辑复制：
- `createJob({kind: "agent"})` + 独立 `AbortController`（链到父信号）；
- `job.kill` 自包含 settle（abort + `settleJob("killed")`，幂等）；
- 报告写入 `job.stdout`、错误写入 `job.stderr`，settle 时自动推 M41 通知（模型无需轮询）。

### S3 · 子代理可用 MCP 工具

**问题**：`resolveSubagentTools` 只对 core 集合按名精确匹配，MCP 工具对类型子代理整体不可见。

**实现**：
- `resolveSubagentTools` 支持**前缀通配**：`mcp__*` 授予全部 MCP 工具，`mcp__github__*` 授予单 server 的工具（磁盘 agents 的 `tools:` frontmatter 同样受益）；结果去重。
- cli-tools 在 MCP 发现完成后重设 `setCoreToolsForSubagents([...CORE_TOOLS, ...mcpTools])`。
- 内置 `general` 类型的 toolNames 加入 `"mcp__*"`。

### S5 · enter_worktree 真正切换会话 cwd

**问题**：工具只建/删 worktree 并报告路径，会话 cwd 不动——后续 shell 命令实际落在主工作树。

**实现**：复用 bash `cd` 的同一机制（`session-cwd` 模块）——enter 后 `setCwd(sessionId, wtPath)`，exit 后恢复到外层 worktree（嵌套时）或 `clearCwd` 回落 workspace root；结果文案明确告知 shell 已切换、文件工具仍按 root 解析需传 worktree 内路径。

---

## 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `npm test` | ✅ **1788 用例全绿**（批次 2 后 1776 + 新增 12） |
| `npm run smoke` | ✅ PASSED |
| `npx biome check`（改动文件） | ✅ 无 error（存量风格警告） |

**新增测试**：`anthropic-early-tooluse.test.ts`（4：边界早发/交错按序/畸形回退/空参数）、`agent-guards.test.ts` +3（后台 settle/错误路由/kill）、`subagents.test.ts` +3（通配解析）、`tools-orchestration.test.ts` +2（cwd 切换/嵌套恢复）。

## 涉及文件

**修改**：`src/anthropic-adapter.ts`、`src/tools/extended/agent.ts`、`src/subagents.ts`、`src/cli-tools.ts`、`src/tools/breadth/orchestration.ts` 及对应测试。

## 下一批（批次 4，最后一批）

M5（快模型独立配置，S6 前置）、S6/S7（web 工具补深）、M1（续写式重试）、S2（MCP 动态发现）、S4（LSP 项目诊断）、P2（会话保存增量化，两步走）。
