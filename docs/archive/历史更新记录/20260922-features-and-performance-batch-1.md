# 功能与性能增强 · 批次 1

> 完成时间：2026-09-22
> 方案来源：[功能与性能增强实施方案](../reports/20260922-功能与性能增强实施方案.md)（批次 1 / 共 4 批）
> 状态：✅ **全部完成** — typecheck 0 错误、vitest 1752/1752 全绿、smoke PASSED

---

## 本批内容（5 项独立小改）

### S1 · 中文记忆/技能检索修复

**问题**：`prefetch.ts` 的 `keywords()` 用 `split(/[^a-z0-9]+/)` 分词，所有中文字符被当分隔符 → 中文会话的检索词集恒为空 → **记忆与技能的自动注入在中文对话里从未生效过**。

**修复**：
- `keywords()` 重写为混合分词：ASCII 段沿用原规则（≥3 字符 + 英文停用词）；CJK 段优先 `Intl.Segmenter("zh", {granularity:"word"})` 分词，feature-detect 失败时降级 **bigram**（相邻两字组合）。
- 新增中文停用词表（纯虚词，保守收录）；`memory-extract.ts` 的意图识别正则增加中文前缀（记住/以后/始终/永远/不要/必须/偏好/注意…），`/memory extract` 现在能捕获中文持久意图行。

### P4 · 权限分类器缓存 + transient 指数退避

- `PermissionClassifier`（types.ts）增加会话级 `cache?: Map<string, ClassifierResult>`；`classifyPermissionRisk()` 按 `toolName|formattedAction` 缓存**确定性判定**（BLOCK/CONFIRM/ALLOW）。`unavailable`（超时/故障）**不缓存**——那是"没能判定"，不是判定。
- cli.ts 构造分类器时挂上 `new Map()`。效果：同一会话内重复的相似危险命令不再每次串行付 4 秒模型调用。
- `error-recovery.ts` transient 重试从固定 2000ms 改为 `1000 × 2^n ± 20% jitter`（cap 30s），与 429 路径的退避策略对齐。

### P3 · token 估算记忆化 + 注入后基线保留

- `token-estimator.ts` 拆出并导出 `estimateMessageTokens()`，按消息对象做 `WeakMap` 记忆化（消息在管线中总是以 spread 新对象替换、从不原地改写，identity 缓存安全）。全量重估算不再对每条消息重跑 ~10 个内容类型正则。
- `agent-loop.ts` 的两处**纯追加**注入（prefetch 附件、工具批摘要）不再作废 `usageBaseline`——`estimateContextTokens()` 本就把基线之后追加的消息增量估算进去，作废只会白白触发全量重算。cheap-layers **改写**消息的路径仍正确重置基线。

### F4 · Agent 工具防护（fork 深度 + 并发信号量）

- 新增 `utils/semaphore.ts`：通用 `Semaphore`（acquire 排队 + abort 感知、tryAcquire 不等待、release 直接转移持有的槽位）；task.ts 原地内联实现替换为该共享类，行为与错误文案不变。
- `agent.ts`：新增 `MAX_FORK_DEPTH = 2` 递归上限（原先 fork 可无限套 fork）；新增独立 `AGENT_MAX_CONCURRENCY`（默认 3）信号量——**顶层排队、嵌套 tryAcquire 快速失败**（嵌套 agent 排队会等持槽位的父进程，满载时整批死锁）。
- 子循环 `toolContext` 现在传递 `subagentDepth: forkDepth + 1`（原先 Agent 工具不传深度，fork 链上的深度计数断在第一层）。

### M4 · 合成注入不再消耗 checkpoint 边界

**问题**：stop-hook 错误注入、`finish_reason=length` 续写 nudge、工具结果图片附件、后台完成通知——每个都调 `beginUserTurn()`：turn 计数膨胀、每注入一次对全部跟踪文件 statSync、加速挤掉 100 个快照的 rewind 窗口。

**修复**：合成注入改走 `noTurnBoundary`（无操作，消息不打 tag）；**排队输入（真实用户键入）保留完整边界**。未打 tag 的消息在 rewind UI 里已有兜底语义（conversation-only 回退）。
另注：原方案中"快照内容共享"一项经核实**已由现有 mtime 缓存实现**——`snapshotAt()` 命中缓存时返回同一字符串引用，未变更文件跨 turn 本来就共享内存，无需重复实现。

---

## 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `npm test` | ✅ 141 文件 / **1752 用例全绿**（原 1728 + 新增 24） |
| `npx biome check`（改动文件） | ✅ 无新增 error（全仓 609 个 noNonNullAssertion 风格警告为存量） |
| `npm run smoke` | ✅ PASSED |

**新增测试**：`semaphore.test.ts`（6）、`agent-guards.test.ts`（3）、`turn-boundary.test.ts`（3）、`prefetch.test.ts` +4（中文检索 3 + bigram 降级 1）、`memory-extract.test.ts` +1（中文意图）、`integration-permissions.test.ts` +3（缓存）、`p0-tui-features.test.tsx` 更新 2（退避断言）、`token-estimator.test.ts` +3（记忆化）。

## 涉及文件

**新增**：`src/utils/semaphore.ts`、`src/__tests__/{semaphore,agent-guards,turn-boundary}.test.ts`
**修改**：`src/{prefetch,memory-extract,permissions,error-recovery,token-estimator,agent-loop,types,cli}.ts`、`src/tools/extended/{agent,task}.ts` 及对应测试。

## 下一批（批次 2）

F1 记忆闭环（MemorySave 工具 + 自动提取）、F2 RestoreContext、F5 时间微压缩接线（+删 context-snip 死代码）、M2 工具结果去重折叠、M3 grep/glob 文件列举缓存。
