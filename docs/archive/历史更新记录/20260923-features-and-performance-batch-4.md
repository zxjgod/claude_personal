# 功能与性能增强 · 批次 4（收官）

> 完成时间：2026-09-23
> 方案来源：[功能与性能增强实施方案](../reports/20260922-功能与性能增强实施方案.md)（批次 4 / 共 4 批）
> 状态：✅ **全部完成** — typecheck 0 错误、vitest 1804/1804 全绿、smoke PASSED
> **四批总计**：方案 22 项中 20 项落地（S2 的 stdio 断线重连与 M2 的 JSONL 增量格式为方案内 stretch 项，按方案保留待做）

---

## 本批内容（7 项）

### M5 · 快模型独立配置（多处成本优化的前置）

- `resolveFastModelConfig()`（provider-profiles.ts）：`CCR_FAST_MODEL=provider/model`（或裸 `model` 沿用当前 provider），继承主配置的 apiKey/baseURL/options；未设置或不可解析返回 null。
- `FastModelOption` 进入 `LoopOptions.fastModel`，`autoCompact()` 接受可选 fast 通道并**强制降级**：快模型摘要失败自动回落主模型——压缩不能因便宜端点故障而失败。
- cli.ts 的 `getFastModel()` 每次**调用时惰性解析**，/provider /model 会话内切换即时生效。消费点四处：工具批摘要（`CCR_TOOL_SUMMARY=1` 时）、autoCompact 摘要、web_fetch 提取（S6）、记忆提取（F1 退出路径与 `/memory extract --model`）。

### S6 · web_fetch 的 fetchInfo 真执行

**问题**：`fetchInfo` 只回显在输出头部，没有提取语义。

- 抓取正文后取前 20k 字符 + 指令发起一次有界模型调用（快模型优先，15s 超时，独立 AbortController）；成功则以提取结果为主体、附 1500 字符原文预览；**任何失败或无 modelConfig 降级为原样输出**（旧行为），测试/子代理零影响。

### S7 · web_search 健壮化

- **lite 端点优先**：新增 `parseDdgLiteResults`（整体 anchor 正则，snippet 按相邻 anchor 边界定界），`lite.duckduckgo.com/lite/` 表格结构比 html 端点稳定得多；html 端点降为二级，Bing 兜底不变。
- 失效闩修正：只在**网络级错误**（超时/连接拒绝）时闩住 DDG，空页（人机挑战）不再永久禁用整个引擎。
- schema 增强：`max_results`（1–20）、`domains`（≤5 个，拼 `site:` 语法）、`freshness`（week/month/year → DDG `df` 参数）。

### M1 · 续写式重试（默认关）

- `CCR_RETRY_CONTINUE=1` 时：流中断后若已积累 ≥1000 字符纯文本**且本轮无 tool_use**、provider 非 anthropic（signed thinking 不可续写）→ 把部分文本固化为 assistant 消息 + 续写 nudge（"Continue EXACTLY from where you stopped"），已生成的 output tokens 不作废。
- `model_retry` 事件增加可选 `continuation` 字段（additive）；默认关闭时行为与之前完全一致。

### S2 · MCP 动态工具发现

- `connectServer` 现在订阅 SDK 的 `ToolListChangedNotificationSchema`；工具包装逻辑抽为 `wrapRemoteTools()`（审批粘性/超时/schema 校验单一实现），`refreshServerTools(name)` 重列并广播 `onToolsChanged`。
- cli-tools 订阅变化：**保持传给 loop 的 tools 数组引用不变**，就地重建内容 + 重设子代理注入集（`mcp__*` 通配随之更新）。
- `/mcp refresh <server>` 手动刷新。stdio 断线自动重连仍为待做（方案内 stretch）。

### S4 · LSP 全项目诊断去 npx-tsc 化

**关键发现**：最初方案假设 `geterrats` 命令——实装时对照本仓库 tsserver 源码确认实际命令是 **`geterrForProject`**（单请求、以任一项目文件为锚、服务端自行枚举整个项目），实现随之简化：只 open 锚文件、发一个请求、等 `requestCompleted` 事件收尾（syntaxDiag/semanticDiag 事件流式累积），60s 硬死线返回已落地的诊断。
- `LspClient.request()` 增加可选 `sent(seq)` 回调用于配对事件；`handleMessage` 只在 sweep 进行中消费 diag 事件（零常态开销）。
- `lsp_diagnostics` 无 filePath 时先走 LSP 项目扫描，tsserver 不可用/扫描失败仍降级 `npx tsc`（保留未删）。首扫付项目图构建，后续增量。

### P2 · 会话保存降开销（第一步，格式不变）

- **去掉 pretty-print**：`JSON.stringify(data)` 无缩进，消息密集会话体积近半。
- **lastSaved 缓存**：保存不再 read-modify-write 整个文件（此前每次 save 都 `load()`+`JSON.parse` 全量历史——长会话每轮 O(n) I/O）；缓存完整的上一次 SessionData（含 version/sessionId/workspaceRoot 身份字段——初版只存元数据曾导致 load 校验失败，已修），消息按引用共享无额外拷贝；`deleteSession` 同步失效。
- **catalog 节流**：preview（首条用户消息）未变化不重写 catalog.json——会话内绝大多数保存跳过这次读写。

---

## 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `npm test` | ✅ 147 文件 / **1804 用例全绿**（批次 3 后 1788 + 新增 16） |
| `npm run smoke` | ✅ PASSED |
| `npx biome check`（改动文件） | ✅ 无 error（存量风格警告） |

**新增测试**：`web-fetch-extract.test.ts`（4：提取/降级/无模型跳过/快模型优先）、`web-search.test.ts` +2（lite 解析）、`retry-continue.test.ts`（4：续写/默认关/anthropic 排除/tool_use 排除）、`mcp-dynamic-tools.test.ts`（4：刷新广播/坏监听容错/未连接报错/调用路由）、`lsp.test.ts` +2（真实 tsserver 项目扫描/空项目）。

## 涉及文件

**修改**：`src/auto-compact.ts`、`src/provider-profiles.ts`、`src/types.ts`、`src/agent-loop.ts`、`src/{cli,cli-repl,cli-tools,session-memory}.ts`、`src/tui/run.tsx`、`src/commands/memory.ts`、`src/commands/mcp.ts`、`src/tools/extended/{web-fetch,web-search}.ts`、`src/mcp/index.ts`、`src/lsp.ts`、`src/tools/breadth/index.ts` 及测试。

## 四批总览

| 批次 | 内容 | 测试 |
|---|---|---|
| 1 | S1 中文检索、P4 分类器缓存+退避、P3 token 记忆化、F4 Agent 防护、M4 轻量边界 | 1752 |
| 2 | F1 记忆闭环、F2 RestoreContext、F5 微压缩接线、M2 去重折叠、M3 fs 缓存 | 1776 |
| 3 | P1 流中早启动、F3 后台子代理、S3 子代理 MCP、S5 worktree cwd | 1788 |
| 4 | M5 快模型、S6/S7 web 工具、M1 续写重试、S2 MCP 动态、S4 LSP 项目诊断、P2 保存降开销 | **1804** |

## 遗留（方案内 stretch，建议后续单独排期）

- **P2 第二步**：JSONL append 增量持久化（需 version bump + resume/export/share 全链路回归）。
- **S2 stdio 断线重连**：进程 exit 监听 + 指数退避。
- **M5 后续评估**：配置快模型后可将 `CCR_TOOL_SUMMARY` 默认值重新评估为开。
