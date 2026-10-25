# 全面代码审查修复

- **日期**：2026-10-24
- **类型**：fix / build / security
- **模块/子系统**：权限安全 / 子代理 / 持久化与调度 / 模型与 MCP / CLI·TUI·SDK / 构建与发布
- **主题**：对全仓审查确认的 P1/P2/P3 问题做一次性集中修复，并升级 MCP SDK 修复两条已披露漏洞。

## 受影响文件

### 新增

- `src/utils/windows-bin.ts`（Windows 系统二进制绝对路径解析）
- `src/__tests__/scoped-execution.test.ts`（agent hooks 信任门 + skill 作用域隔离）
- `LICENSE`（MIT 全文，随包发布）

### 修改（实现，节选）

- 权限：`src/permission-policy.ts`、`src/permissions.ts`、`src/tool-executor.ts`、`src/agent-loop.ts`、`src/tools/utils/command.ts`、`src/tools/utils/file-refs.ts`、`src/utils/input-validator.ts`、`src/hooks-config.ts`、`src/cli-config.ts`、`src/cli-main.ts`、`src/cli-repl.ts`、`src/commands/cd.ts`、`src/commands/types.ts`、`src/tui/run.tsx`、`src/tools/core/{bash,powershell,read}.ts`、`src/native-sandbox.ts`、`src/tui/open-editor.ts`
- 子代理：`src/scoped-execution.ts`、`src/subagents.ts`、`src/agents/loadAgentsDir.ts`、`src/agents/agent-mcp.ts`、`src/skills/forkSkill.ts`、`src/tools/extended/{task,agent}.ts`、`src/team.ts`、`src/types.ts`、`src/subagent-output-scan.ts`、`src/mcp/index.ts`
- 持久化/调度：`src/checkpoint.ts`、`src/audit-log.ts`、`src/session-memory.ts`、`src/tui/session-transcript.ts`、`src/telemetry.ts`、`src/read-tracker.ts`、`src/memory-approval.ts`、`src/subagent-settings.ts`、`src/agent-memory.ts`、`src/tools/job-store.ts`、`src/tools/extended/{cron-shared,scheduler,schedule-scope,jobs}.ts`、`src/session-runtime.ts`、`src/commands/clear.ts`、`src/commands/sessions.ts`
- 模型/MCP：`src/anthropic-adapter.ts`、`src/mcp/auth.ts`、`package.json` / `package-lock.json`（`@modelcontextprotocol/sdk` 1.29.0 → 1.32.1）
- CLI/TUI/SDK：`src/headless.ts`、`src/sdk.ts`、`python/ccr_sdk.py`、`src/tui/{run.tsx,Prompts.tsx,cli-interactive.ts}`
- 构建/发布：`scripts/build.mjs`、`scripts/package-smoke.mjs`、`scripts/smoke.mjs`、`scripts/evaluate.mjs`、`package.json`、`tsconfig.json`

## 根因定位（按域，代表性 file:line 见各条）

安全域六条 P1 的根因分别是：`permission-policy.ts` 的 always-allow 存储位于仓库可写目录；`loadAgentsDir.ts` / `scoped-execution.ts` 对 agent 声明的 hooks 无信任门；`subagents.ts#preloadAgentSkills` 直接展开项目 skill 的 `!`cmd``；`commandSegments` 分隔符缺 `&`/换行；`command.ts` 引号跳过未考虑 cmd.exe 语义；shell/spawn 使用裸可执行名。持久化域为读错误单态化（`checkpoint.ts#readOrNull`）、审计 `persistedCount` 在 await 后重读、durable 一次性任务 collect 即删。模型域为 SDK ≤1.31.0 的两条 OAuth 公告 + 适配器细节缺陷。

## 相关测试

新增/更新用例：`scoped-execution.test.ts`（6 项全新）；`permission-policy.test.ts`（分段 & /换行、fd 重定向、路径别名、存储迁移 4 组）；`tools.test.ts`（Windows 引号语义）；`file-refs.test.ts`（符号链接逃逸）；`input-validator.test.ts`（6to4）；`headless-protocol.test.ts`（prompt+stdin 合并/空闲管道）；`cron-shared/scheduler`（单调时钟）；`session-memory`（双写者合并语义更新）；`mcp-auth`（issuer 戳记）；`integration-mcp`（connectServer 返回布尔）。

## 验证命令与实测结果

`npm run typecheck`、`npm run check`、`npm test`（全量）、`npm run smoke`、`npm run smoke:package`、`npm audit`（高危 MCP 项消除；余 3 项 moderate 均为 vitest 4.1.11 dev 链，无 4.x 修复版，5.0 为 major 不在本次范围）。实测结果见最终回复汇总；CI 于 Linux/Windows 双腿复验。

## 关联文档

- [CHANGELOG v1.6.1](../CHANGELOG.md)
- [快速开始](../快速开始.md)（依赖数、发布包内容更新）
- [项目架构](../项目架构.md)（CI Node 版本更正）
