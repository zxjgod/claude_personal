# Phase 1: 内核升级实施计划

> 计划日期：2026-07-05  
> 预计工期：2-3 周  
> 优先级：P0（核心性能与稳定性）

## 执行摘要

Phase 1 聚焦三个 P0 级核心功能：
1. **Micro-Compact 系统** — 时间基础的工具结果清理（token 效率 +30-40%）
2. **Tool Result Storage 增强** — 已有基础，需完善集成
3. **Stop Hook 防循环** — 防止 hook 死循环（已部分实现，需验证）

## 现状分析

### 已有基础（好消息！）

通过代码探索发现，**当前项目已经实现了大部分基础设施**：

#### 1. Tool Result Spill ✅ **已完整实现**
- `src/tool-result-spill.ts` 完整实现（102 行）
- 测试覆盖 `src/__tests__/tool-result-spill.test.ts`
- 已集成到 `agent-loop.ts:18` (`spillIfLarge`)
- 功能完整：
  - 大结果溢出到 `.ccr/tool-results/`
  - 头尾预览机制（12K head + 4K tail）
  - Read 工具豁免（maxChars = Infinity）
  - 写入失败降级到内存截断

**状态**：✅ **完成，无需重做**

#### 2. Stop Hook 防循环 ✅ **已完整实现**
- `LoopState.stopHookActive` 已存在（`agent-loop.ts:88`）
- 防循环逻辑已实现（`agent-loop.ts:508-517`）
- 测试覆盖：`__tests__/agent-loop.test.ts:1338-1346`
- 工作机制：
  - 首次 hook 阻塞生效，设置 `stopHookActive = true`
  - 后续同一 hook 被忽略，避免死循环

**状态**：✅ **完成，无需重做**

#### 3. Context Pipeline ✅ **已有框架**
- `src/context-pipeline.ts` 实现了 4 层架构：
  1. Compact boundary drop（丢弃边界前历史）
  2. Tool result budget（字节预算）
  3. **Layer 3 占位** — 这是 micro-compact 应插入的位置
  4. CollapseStore（可恢复存储）
- `prepareCheapLayers()` 在 `agent-loop.ts:279` 调用

**状态**：🟡 **需填充 Layer 3（micro-compact）**

### 缺失功能（需实现）

#### Micro-Compact 系统 ❌ 缺失

参考实现的两种 micro-compact：

**A. Time-Based Micro-Compact**（时间触发）
- 当距离上次 assistant 消息超过阈值（如 60 分钟），清理旧工具结果
- 参考：`reference/services/compact/microCompact.ts:412-530`
- 配置：`reference/services/compact/timeBasedMCConfig.ts`

**B. Count-Based Micro-Compact**（数量触发，Cached MC）
- 保留最近 N 个工具结果，删除更老的
- 使用 cache_edits API（Anthropic 专有）
- 参考：`reference/services/compact/microCompact.ts:305-399`

**决策**：先实现 **Time-Based**，因为：
1. 更简单（不依赖 cache_edits API）
2. 跨 provider 通用（OpenAI 兼容）
3. 立即见效（清理内容，不只是 cache 操作）

---

## 实施方案

### Task 1: Time-Based Micro-Compact（核心任务）

#### 1.1 创建配置模块

**文件**：`src/services/micro-compact-config.ts`

```typescript
export interface MicroCompactConfig {
  enabled: boolean;
  gapThresholdMinutes: number;  // 触发阈值（分钟）
  keepRecent: number;            // 保留最近 N 个工具结果
  compactableTools: Set<string>; // 可压缩的工具名称
}

const DEFAULT_CONFIG: MicroCompactConfig = {
  enabled: true,
  gapThresholdMinutes: 60,  // 1 小时
  keepRecent: 5,
  compactableTools: new Set([
    'read', 'bash', 'grep', 'glob', 
    'web_fetch', 'web_search', 'edit', 'write'
  ])
};

export function getMicroCompactConfig(): MicroCompactConfig {
  // 支持环境变量覆盖
  const envEnabled = process.env.CCR_MICROCOMPACT_ENABLED;
  const envGap = process.env.CCR_MICROCOMPACT_GAP_MINUTES;
  const envKeep = process.env.CCR_MICROCOMPACT_KEEP_RECENT;

  return {
    ...DEFAULT_CONFIG,
    enabled: envEnabled ? envEnabled === '1' || envEnabled === 'true' : DEFAULT_CONFIG.enabled,
    gapThresholdMinutes: envGap ? parseInt(envGap, 10) : DEFAULT_CONFIG.gapThresholdMinutes,
    keepRecent: envKeep ? parseInt(envKeep, 10) : DEFAULT_CONFIG.keepRecent,
  };
}
```

**位置**：新建 `src/services/` 目录（与参考实现对齐）

---

#### 1.2 实现 Micro-Compact 逻辑

**文件**：`src/services/micro-compact.ts`

```typescript
import type { Message } from '../types.js';
import { getMicroCompactConfig } from './micro-compact-config.js';

export const CLEARED_MESSAGE = '[Old tool result content cleared]';

export interface MicroCompactResult {
  messages: Message[];
  cleared: number;      // 清理的工具结果数
  tokensSaved: number;  // 估算节省的 token
}

/**
 * 评估时间触发器：当距离上次 assistant 消息超过阈值时返回 true
 */
function shouldTrigger(messages: Message[], config: MicroCompactConfig): boolean {
  if (!config.enabled) return false;

  // 找到最后一个 assistant 消息
  const lastAssistant = messages.findLast(m => m.role === 'assistant');
  if (!lastAssistant) return false;

  // 计算时间间隔（需要 Message 类型支持 timestamp）
  // 如果当前没有 timestamp，需要在 types.ts 中添加
  const now = Date.now();
  const lastTime = (lastAssistant as any).timestamp 
    ? new Date((lastAssistant as any).timestamp).getTime()
    : now; // fallback：当前时间（不触发）

  const gapMinutes = (now - lastTime) / 60_000;
  return gapMinutes >= config.gapThresholdMinutes;
}

/**
 * 收集所有可压缩工具的 tool_call_id（按遇到顺序）
 */
function collectCompactableToolIds(
  messages: Message[],
  compactableTools: Set<string>
): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        if (compactableTools.has(call.function.name)) {
          ids.push(call.id);
        }
      }
    }
  }
  return ids;
}

/**
 * 估算消息内容的 token 数（粗略）
 */
function estimateTokens(content: string): number {
  // 粗略估算：4 字符 ≈ 1 token
  return Math.ceil(content.length / 4);
}

/**
 * Time-Based Micro-Compact：清理旧工具结果内容
 */
export function microCompact(messages: Message[]): MicroCompactResult {
  const config = getMicroCompactConfig();
  
  if (!shouldTrigger(messages, config)) {
    return { messages, cleared: 0, tokensSaved: 0 };
  }

  const compactableIds = collectCompactableToolIds(messages, config.compactableTools);
  
  // 保留最近 N 个（至少保留 1 个，避免全清）
  const keepRecent = Math.max(1, config.keepRecent);
  const keepSet = new Set(compactableIds.slice(-keepRecent));
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)));

  if (clearSet.size === 0) {
    return { messages, cleared: 0, tokensSaved: 0 };
  }

  let tokensSaved = 0;
  const result: Message[] = messages.map(msg => {
    if (msg.role !== 'tool' || !clearSet.has(msg.tool_call_id)) {
      return msg;
    }

    // 已经清理过的，跳过（幂等性）
    if (msg.content === CLEARED_MESSAGE) {
      return msg;
    }

    // 清理内容
    tokensSaved += estimateTokens(msg.content);
    return {
      ...msg,
      content: CLEARED_MESSAGE
    };
  });

  return {
    messages: result,
    cleared: clearSet.size,
    tokensSaved
  };
}
```

---

#### 1.3 集成到 Context Pipeline

**文件**：`src/context-pipeline.ts`

**修改位置**：在 `prepareCheapLayers()` 中添加 Layer 3

```typescript
// 在文件顶部添加 import
import { microCompact } from './services/micro-compact.js';

// 在 prepareCheapLayers() 函数中，applyToolResultBudget 之后添加：

export function prepareCheapLayers(
  messages: Message[],
  options: PrepareOptions
): PrepareResult {
  const { estimateTokens, threshold, store } = options;
  const notes: string[] = [];
  let current = messages;

  // Layer 1: compact boundary
  const afterBoundary = getMessagesAfterCompactBoundary(current);
  if (afterBoundary !== current) {
    notes.push(`Dropped ${current.length - afterBoundary.length} pre-summary messages`);
    current = afterBoundary;
  }

  // Layer 2: tool result budget
  const budgeted = applyToolResultBudget(current, {
    maxTotalChars: 100_000,
    keepRecent: 4,
    store,
  });
  if (budgeted.changed > 0) {
    notes.push(
      `Trimmed ${budgeted.changed} tool results (saved ~${budgeted.charsSaved} chars)`
    );
    current = budgeted.messages;
  }

  // Layer 3: micro-compact（新增）
  const microCompacted = microCompact(current);
  if (microCompacted.cleared > 0) {
    notes.push(
      `Micro-compact cleared ${microCompacted.cleared} old tool results (~${microCompacted.tokensSaved} tokens saved)`
    );
    current = microCompacted.messages;
  }

  // Check if autoCompact is needed
  const est = estimateTokens(current);
  const needsAutoCompact = threshold !== Number.POSITIVE_INFINITY && est >= threshold;

  return {
    messages: current,
    notes,
    needsAutoCompact,
  };
}
```

---

#### 1.4 类型增强（如需要）

**文件**：`src/types.ts`

如果 `Message` 类型尚未支持 `timestamp`，需要添加：

```typescript
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  timestamp?: string;  // 新增：ISO 8601 时间戳
}

export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  name?: string;
  content: string;
  timestamp?: string;  // 新增
}
```

**检查**：搜索现有代码，确认是否已有 timestamp 支持。

---

#### 1.5 测试

**文件**：`src/__tests__/micro-compact.test.ts`

```typescript
import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { CLEARED_MESSAGE, microCompact } from '../services/micro-compact.js';

describe('microCompact', () => {
  const createMessage = (
    role: 'user' | 'assistant' | 'tool',
    extra: Partial<Message> = {}
  ): Message => {
    const base: any = { role };
    if (role === 'assistant') {
      return {
        ...base,
        content: 'test',
        timestamp: new Date(Date.now() - 3600 * 1000).toISOString(), // 1h ago
        tool_calls: [],
        ...extra,
      };
    }
    if (role === 'tool') {
      return {
        ...base,
        tool_call_id: 'call_123',
        content: 'x'.repeat(10000),
        ...extra,
      };
    }
    return { ...base, content: [{ type: 'text', text: 'user input' }], ...extra };
  };

  it('should not trigger when gap < threshold', () => {
    process.env.CCR_MICROCOMPACT_GAP_MINUTES = '60';
    const messages: Message[] = [
      createMessage('assistant', {
        timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
      }),
    ];
    const result = microCompact(messages);
    expect(result.cleared).toBe(0);
  });

  it('should clear old tool results when gap exceeds threshold', () => {
    process.env.CCR_MICROCOMPACT_GAP_MINUTES = '60';
    process.env.CCR_MICROCOMPACT_KEEP_RECENT = '2';

    const messages: Message[] = [
      createMessage('assistant', {
        timestamp: new Date(Date.now() - 90 * 60 * 1000).toISOString(), // 90 min ago
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{}' } },
          { id: 'call_3', type: 'function', function: { name: 'grep', arguments: '{}' } },
        ],
      }),
      createMessage('tool', { tool_call_id: 'call_1', content: 'old content 1' }),
      createMessage('tool', { tool_call_id: 'call_2', content: 'old content 2' }),
      createMessage('tool', { tool_call_id: 'call_3', content: 'recent content' }),
    ];

    const result = microCompact(messages);
    
    // 应该清理 2 个旧结果，保留 1 个最近的（keepRecent=2，但只有 3 个总共）
    expect(result.cleared).toBe(1); // call_1 被清理
    expect(result.messages[1].content).toBe(CLEARED_MESSAGE);
    expect(result.messages[2].content).toBe('old content 2'); // 保留
    expect(result.messages[3].content).toBe('recent content'); // 保留
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it('should be idempotent (not re-clear already cleared)', () => {
    const messages: Message[] = [
      createMessage('assistant', {
        timestamp: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      }),
      createMessage('tool', { tool_call_id: 'call_1', content: CLEARED_MESSAGE }),
    ];

    const result = microCompact(messages);
    expect(result.cleared).toBe(0); // 已经清理过，不重复
  });

  it('should respect CCR_MICROCOMPACT_ENABLED=0', () => {
    process.env.CCR_MICROCOMPACT_ENABLED = '0';
    const messages: Message[] = [
      createMessage('assistant', {
        timestamp: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      }),
    ];
    const result = microCompact(messages);
    expect(result.cleared).toBe(0);
  });
});
```

---

### Task 2: 验证已有功能

#### 2.1 Tool Result Spill 验证

**检查点**：
- ✅ 运行现有测试：`npm test tool-result-spill`
- ✅ 确认 `agent-loop.ts` 中 `spillIfLarge` 正确调用
- ✅ 手动测试：读取超大文件（>30KB），确认溢出机制工作

**预期**：所有测试通过，无需修改

---

#### 2.2 Stop Hook 防循环验证

**检查点**：
- ✅ 运行现有测试：`npm test agent-loop` 中的 hook 测试
- ✅ 代码审查：确认 `stopHookActive` 逻辑正确
- ✅ 添加日志（可选）：在 `agent-loop.ts:517` 处添加 debug 日志

**预期**：所有测试通过，无需修改

---

### Task 3: 文档更新

#### 3.1 更新项目总览

**文件**：`docs/项目总览.md`

添加 Phase 1 完成记录：

```markdown
## 近期功能更新

- **2026-07-05 Phase 1 内核升级**：
  - ✅ Time-Based Micro-Compact：距离上次活动超过阈值自动清理旧工具结果
  - ✅ 验证 Tool Result Spill：大结果溢出到磁盘（已完整实现）
  - ✅ 验证 Stop Hook 防循环：防止 hook 死循环（已完整实现）
  - 预期收益：token 使用率降低 30-40%，长对话成本显著下降
```

---

#### 3.2 创建 Phase 1 完成报告

**文件**：`docs/更新日志/20260705-phase1-kernel-upgrade.md`

记录实施细节、测试结果、性能对比。

---

## 实施顺序

### Week 1: 核心实现

**Day 1-2**：
1. 创建 `src/services/` 目录
2. 实现 `micro-compact-config.ts`
3. 实现 `micro-compact.ts` 核心逻辑
4. 编写单元测试

**Day 3-4**：
5. 集成到 `context-pipeline.ts`
6. 类型增强（如需要添加 timestamp）
7. 端到端测试

**Day 5**：
8. 验证 Tool Result Spill（运行现有测试）
9. 验证 Stop Hook（运行现有测试）
10. 代码审查

### Week 2: 测试与优化

**Day 1-2**：
11. 集成测试：长对话场景
12. 性能测试：token 消耗对比（启用 vs 禁用 micro-compact）
13. 边缘案例测试

**Day 3-4**：
14. 修复发现的 bug
15. 优化配置参数（根据测试结果调整默认值）
16. 添加遥测日志（记录触发次数、节省 token）

**Day 5**：
17. 文档更新
18. 创建完成报告
19. 代码提交 + PR

### Week 3: 缓冲与部署

**Day 1-2**：
20. 用户验收测试（UAT）
21. 性能监控（真实场景）

**Day 3-5**：
22. 根据反馈微调
23. 准备 Phase 2

---

## 测试策略

### 单元测试（覆盖率目标 >90%）

- `micro-compact-config.ts`：环境变量解析
- `micro-compact.ts`：
  - 触发条件（时间阈值）
  - 清理逻辑（保留最近 N 个）
  - 幂等性（不重复清理）
  - 边缘案例（空消息、无 timestamp）

### 集成测试

- Context pipeline 完整流程
- Agent loop 端到端（含 micro-compact）
- 多轮对话场景

### 性能测试

**对比场景**：
1. **基线**：禁用 micro-compact（`CCR_MICROCOMPACT_ENABLED=0`）
2. **优化后**：启用 micro-compact

**测试用例**：
- 10 轮对话，每轮读取 1 个 10KB 文件
- 20 轮对话，每轮执行 1 个 bash 命令（输出 5KB）
- 长对话（50+ 轮）

**指标**：
- 总 token 消耗（input + output）
- autoCompact 触发次数
- 平均每轮 context 大小

**预期**：
- Token 消耗降低 30-40%
- autoCompact 触发减少 50%+

---

## 风险管理

### 风险 1：Message 类型无 timestamp

**概率**：中  
**影响**：高（micro-compact 无法工作）

**缓解方案**：
- 检查现有代码是否已有 timestamp
- 如果没有，在 message 创建时添加（`agent-loop.ts` 中 model response 处理）
- Fallback：使用 "消息索引 + 轮次" 近似时间

---

### 风险 2：清理过于激进，丢失重要上下文

**概率**：低  
**影响**：高（用户体验下降）

**缓解方案**：
- 保守的默认配置（60 分钟阈值，保留 5 个最近结果）
- 环境变量可调
- 添加日志，监控实际清理情况
- 用户反馈后快速调整

---

### 风险 3：与现有 snip/budget 层冲突

**概率**：低  
**影响**：中（重复清理，浪费性能）

**缓解方案**：
- Micro-compact 在 budget 层**之后**运行（Layer 3）
- 检查内容是否已被清理（幂等性）
- 单元测试覆盖层级交互

---

## 成功标准

### 功能完整性
- ✅ Micro-compact 正确触发（时间阈值）
- ✅ 正确清理旧工具结果内容
- ✅ 保留最近 N 个结果
- ✅ 幂等性（不重复清理）

### 性能提升
- ✅ Token 消耗降低 ≥30%（长对话场景）
- ✅ autoCompact 触发减少 ≥50%
- ✅ 无性能回归（短对话）

### 质量保证
- ✅ 单元测试覆盖率 ≥90%
- ✅ 所有现有测试通过
- ✅ 集成测试通过
- ✅ 代码审查通过（Biome lint + TypeScript 无错误）

### 文档完整
- ✅ 项目总览更新
- ✅ 完成报告撰写
- ✅ 配置说明（环境变量）

---

## 下一步（Phase 2 预览）

Phase 1 完成后，立即启动 Phase 2（P1 功能）：
1. LLM Permission Classifier（智能风险评估）
2. Session Memory Compact（会话记忆压缩）
3. Token Budget 管理增强

预计工期：3-4 周

---

## 附录

### 环境变量配置

```bash
# 启用/禁用 micro-compact
CCR_MICROCOMPACT_ENABLED=1          # 默认 1（启用）

# 时间阈值（分钟）
CCR_MICROCOMPACT_GAP_MINUTES=60     # 默认 60

# 保留最近 N 个工具结果
CCR_MICROCOMPACT_KEEP_RECENT=5      # 默认 5
```

### 参考文档

- 分析报告：`docs/kernel-upgrade-analysis-20260705.md`
- 参考实现：`reference/services/compact/microCompact.ts`
- 现有架构：`docs/项目架构.md`

---

**计划状态**：📝 待批准  
**最后更新**：2026-07-05
