# 更新日志 — Prompt 缓存断裂诊断（Phase C）

> 项目：Claude Code Replica / `claude_personal`
> 日期：2026-08-14
> 类型：feature
> 模块：prompt cache 诊断（`src/prompt-cache.ts` + `anthropic-adapter.ts`）
> 主题：从 claude-code `services/api/promptCacheBreakDetection.ts` 移植「缓存断裂检测 + 根因归因」，接到 Anthropic 适配器
> 状态：已落地（纯模块 + 适配器接线 + 6 测试）
> 验证：`npx tsc --noEmit` 通过、`npx vitest run src/__tests__/prompt-cache-break.test.ts` 6/6、全量 1106/1106
> 关联 commit：待提交
> 关联文档：[参考源码移植路线图](../reports/参考源码移植路线图.md)（Phase C）

---

## 一、背景

prompt 缓存是 Claude Code 的最大成本杠杆：缓存命中时 input token 近乎免费，**缓存断裂**则让每轮都按全价重计费，且模型照常回答、用户无感。官方 `promptCacheBreakDetection.ts` 专门做「断裂检测 + 根因归因」，本项目有缓存支持（`DYNAMIC_BOUNDARY` + `cache_control` 断点）却**没有断裂诊断**。

---

## 二、移植内容

### `src/prompt-cache.ts`（新，纯模块）

两阶段技术：

1. **`recordPromptState(snapshot)`**（调用前）：哈希**可缓存前缀**（`DYNAMIC_BOUNDARY` 之上）+ **逐工具 schema** + 模型 + effort，与上一次调用 diff，命名「什么变了」（system/tools/model/effort）。
2. **`checkResponseForCacheBreak(cacheRead, cacheCreation)`**（调用后）：比对 `cache_read` token，若较上次**降幅 >5% 且 >2000 token** 判为断裂，用 pending diff 归因；无变化则归因为「TTL 过期 / 服务端驱逐」。

要点：
- **动态后缀不入哈希** —— 只哈希 `DYNAMIC_BOUNDARY` 之上的静态前缀（缓存只覆盖前缀）。
- **逐工具哈希** —— 工具集不变但某工具 schema 变了，能精确指出是哪个工具。
- `djb2Hash` 确定性哈希，无 Bun 依赖。

### `src/anthropic-adapter.ts`（接线）

- `client.messages.stream(...)` 前 `recordPromptState(...)`；
- 取到 `cache_read`/`cache_creation` 后 `checkResponseForCacheBreak(...)`，断裂时 `console.warn("[prompt cache break] <reason>")`。

### 测试 `src/__tests__/prompt-cache-break.test.ts`（6 用例）

首调用不告警、缓存稳定不告警、无变化断裂归因 TTL/服务端、模型变更归因、工具集变更归因、动态后缀变化不判 prompt 变更。

---

## 三、设计决策记录

1. **单源跟踪** —— 官方按 `querySource`/`agentId` 跟踪多源（主线程/compact/子代理）；本项目当前只跟踪主循环一个源，子代理/compact 的多源隔离留待需要时再补。
2. **阈值沿用官方** —— `>5%` 且 `>2000 token` 才告警，过滤正常波动。
3. **TTL 时间戳归因省略** —— 官方用消息时间戳区分 5min/1h TTL；本项目 Message 无时间戳，先合并为「TTL 过期 / 服务端驱逐」。
4. **命名区分** —— 已有的 `prompt-cache.test.ts` 测的是适配器工具 cache 断点（`formatToolsForAnthropic`），本次新模块 + 测试命名为 `prompt-cache.ts` / `prompt-cache-break.test.ts` 避免混淆。

---

## 四、Phase C 剩余

- C2：bash 分类器**规则层**（allow/ask/deny 提示规则）+ **投机式分类**（分类器与 pre-tool hook 并行，隐藏延迟）+ auto-mode 规则（allow/soft_deny/environment）。官方 `tools/BashTool/bashPermissions.ts`（2.6K 行）是规则 + LLM 双层的富实现，本项目目前只有单 LLM 分类器（BLOCK/CONFIRM/ALLOW）。
