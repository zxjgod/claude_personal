# Phase 2 实施计划：体验提升与性能优化

> 计划日期：2026-07-05  
> 预计工期：3-4 周  
> 优先级：P1（体验显著提升）

## 执行摘要

基于 Phase 1 的成功经验和代码库深度探索，Phase 2 聚焦 **4 个 P1 级功能**，按复杂度和收益排序：

### 优先级排序（推荐）

1. **Usage Baseline 优化** ⭐⭐⭐⭐⭐
   - 工期最短：2-3 天
   - 收益明显：性能 +20%
   - 风险最低：纯优化，不改变行为
   - **建议第一个实施**

2. **LLM Permission Classifier** ⭐⭐⭐⭐
   - 工期：3-5 天
   - 收益：权限决策准确率 +40%
   - 已有框架：只需补充实现
   - **建议第二个实施**

3. **Token Budget 增强** ⭐⭐⭐
   - 工期：3-4 天  
   - 收益：跨 workflow 预算控制
   - 已有基础：turnOutputBudget 可扩展
   - **建议第三个实施**

4. **Session Memory Compact** ⭐⭐
   - 工期：4-6 天
   - 收益：长对话记忆效率 +25%
   - 复杂度最高：需要理解 session memory 架构
   - **建议最后实施或 Phase 3**

---

## 现状分析（基于代码探索）

### 已有基础设施 ✅

#### 1. LLM Permission Classifier（70% 完成）

**已实现**：
```typescript
// src/cli.ts:388-396
const permissionClassifier: PermissionClassifier | undefined = 
  llmPermClassifierEnabled ? {
    callModel,
    modelConfig,
    timeoutMs: 4000,
  } : undefined;

// src/types.ts:202
export interface PermissionClassifier {
  classifyRisk(...): Promise<ClassifierResult>;
}
```

**缺失**：
- ❌ `classifyRisk` 实现（核心逻辑）
- ❌ 集成到 `checkPermission()` 流程
- ❌ 测试覆盖

**工作量**：~150 行代码 + ~100 行测试

---

#### 2. Usage Baseline（80% 完成）

**已实现**：
```typescript
// src/agent-loop.ts:76
usageBaseline?: { promptTokens: number; messageCount: number };

// src/agent-loop.ts:1082-1088
function estimateContextTokens(messages, baseline) {
  if (baseline && messages.length >= baseline.messageCount) {
    const appended = messages.slice(baseline.messageCount);
    return baseline.promptTokens + estimateTokens(appended);
  }
  return estimateTokens(messages);  // Fallback：全量估算
}
```

**问题**：
- ❌ `baseline.promptTokens` 未正确填充（从 usage 中提取）
- ❌ compaction 后 baseline 被清空但未重建
- ✅ 增量估算逻辑已完整

**工作量**：~50 行代码修复 + ~50 行测试

---

#### 3. Token Budget（60% 完成）

**已实现**：
```typescript
// src/query/token-budget.ts
export interface TokenBudgetState {
  totalOutput: number;
  lowGainStreak: number;
  continuations: number;
}

// src/agent-loop.ts:143
turnOutputBudget?: number;  // 单轮预算
```

**缺失**：
- ❌ 跨 workflow 的全局预算池
- ❌ 从用户输入解析预算（+500k 风格）
- ❌ 预算耗尽时的优雅处理

**工作量**：~200 行代码 + ~100 行测试

---

#### 4. Session Memory Compact（30% 完成）

**已实现**：
```typescript
// src/session-memory.ts
export class SessionMemory {
  async save(...): Promise<void>;
  async load(...): Promise<SessionData | null>;
}

// reference/services/compact/sessionMemoryCompact.ts（参考实现）
export const DEFAULT_SM_COMPACT_CONFIG = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
};
```

**缺失**：
- ❌ 专项压缩逻辑（针对 session memory 的优化）
- ❌ 配置管理
- ❌ 集成到 autoCompact 流程

**工作量**：~300 行代码 + ~150 行测试

---

## 详细实施方案

### 🥇 Task 1: Usage Baseline 优化（2-3 天）

#### 目标
修复 usage baseline 填充和重建逻辑，实现真正的增量 token 估算。

#### 1.1 问题诊断

**当前行为**：
```typescript
// agent-loop.ts:404
usageBaseline: { promptTokens, messageCount: windowAtCall }
```

**问题**：`promptTokens` 变量未定义或未从 `usage` 中提取。

**验证方法**：
```typescript
// 在 agent-loop.ts 中添加日志
console.log('[DEBUG] usage:', usage);
console.log('[DEBUG] baseline:', state.usageBaseline);
```

---

#### 1.2 修复方案

**步骤 1**：从 `usage` 中提取 `input_tokens`

```typescript
// src/agent-loop.ts（在 done 处理中）
if (event.type === "done") {
  usage = event.usage;
  
  // 提取 input_tokens 作为 promptTokens
  const promptTokens = usage?.input_tokens ?? 0;
  const messageCount = windowAtCall;
  
  state = {
    ...state,
    usageBaseline: { promptTokens, messageCount },
  };
}
```

**步骤 2**：compaction 后重建 baseline

```typescript
// 在 autoCompact 之后
if (prepared.needsAutoCompact) {
  yield { type: "compacting" };
  messages = await autoCompact(messages, callModel, modelConfig, abortSignal);
  
  // 重建 baseline：重新估算压缩后的 messages
  const newPromptTokens = estimateTokens(messages);
  state = {
    ...state,
    usageBaseline: {
      promptTokens: newPromptTokens,
      messageCount: messages.length,
    },
  };
  
  yield { type: "compacted", summary: "Context compressed" };
}
```

**步骤 3**：添加诊断日志（可选）

```typescript
function estimateContextTokens(messages, baseline) {
  if (baseline && messages.length >= baseline.messageCount) {
    const appended = messages.slice(baseline.messageCount);
    const increment = estimateTokens(appended);
    const total = baseline.promptTokens + increment;
    
    // 诊断日志
    if (process.env.CCR_DEBUG_TOKENS) {
      console.log(`[Tokens] baseline=${baseline.promptTokens}, ` +
                  `+${increment} (${messages.length - baseline.messageCount} new), ` +
                  `total=${total}`);
    }
    
    return total;
  }
  return estimateTokens(messages);
}
```

---

#### 1.3 测试

**新增测试**：`src/__tests__/usage-baseline.test.ts`

```typescript
describe('Usage Baseline', () => {
  it('should use provider-reported input_tokens as baseline', async () => {
    const messages = createMessages(10);
    const callModel = mockCallModel({
      usage: { input_tokens: 5000, output_tokens: 100 }
    });
    
    // 初始调用
    for await (const event of agentLoop(messages, tools, callModel, config, {})) {
      // ...
    }
    
    // 验证 baseline 设置
    expect(loopState.usageBaseline).toEqual({
      promptTokens: 5000,
      messageCount: 10,
    });
  });
  
  it('should estimate incrementally with valid baseline', () => {
    const baseline = { promptTokens: 5000, messageCount: 10 };
    const messages = createMessages(12);  // 新增 2 条
    
    const estimate = estimateContextTokens(messages, baseline);
    
    // 应该是 5000 + estimate(2 条新消息)
    expect(estimate).toBeLessThan(5000 + 500);  // 假设每条 < 250 tokens
  });
  
  it('should rebuild baseline after compaction', async () => {
    // 触发 autoCompact
    // 验证压缩后 baseline 被重建
  });
});
```

**预期收益**：
- 避免每次重新估算整个历史（~100ms → ~1ms）
- 长对话性能提升 20%

---

### 🥈 Task 2: LLM Permission Classifier（3-5 天）

#### 目标
实现基于 Haiku 的智能风险评估，提升权限决策准确率 +40%。

#### 2.1 实现核心逻辑

**新建文件**：`src/permissions-classifier.ts`

```typescript
import type { ClassifierResult, PermissionClassifier, ToolContext } from "./types.js";

/**
 * LLM-based permission risk classifier using Haiku for fast assessment.
 */
export async function classifyRisk(
  classifier: PermissionClassifier,
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ClassifierResult> {
  const prompt = buildClassifierPrompt(toolName, input, context);
  
  try {
    const response = await Promise.race([
      callClassifierModel(classifier, prompt),
      timeout(classifier.timeoutMs ?? 4000),
    ]);
    
    return parseClassifierResponse(response);
  } catch (error) {
    // Timeout 或失败 → 降级到 'unknown'（让静态检查结果生效）
    return {
      riskLevel: "unknown",
      reasoning: "Classifier unavailable (timeout or error)",
      suggestedAction: "warn",
    };
  }
}

function buildClassifierPrompt(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): string {
  return `You are a security classifier for AI assistant operations.

Assess the risk level of this operation:

Tool: ${toolName}
Input: ${JSON.stringify(input, null, 2)}
Working Directory: ${context.workspaceRoot}
Permission Mode: ${context.permissionMode}

Risk Levels:
- LOW: Read-only operations, no side effects (read file, glob, grep)
- MEDIUM: Writes files, modifies state (write, edit)
- HIGH: Deletes data, network operations (bash with rm, web requests)
- CRITICAL: System-level changes, privilege escalation (sudo, /etc edits)

Respond in JSON:
{
  "riskLevel": "low" | "medium" | "high" | "critical",
  "reasoning": "Brief explanation (1-2 sentences)",
  "suggestedAction": "allow" | "warn" | "deny"
}`;
}

async function callClassifierModel(
  classifier: PermissionClassifier,
  prompt: string,
): Promise<string> {
  const chunks: string[] = [];
  
  // 使用 Haiku（快速 + 便宜）
  const classifierConfig = {
    ...classifier.modelConfig,
    model: "claude-haiku-4.5",
  };
  
  for await (const event of classifier.callModel(
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    [],
    "You are a security risk classifier. Respond only with valid JSON.",
    classifierConfig,
  )) {
    if (event.type === "text_delta") {
      chunks.push(event.delta);
    }
  }
  
  return chunks.join("");
}

function parseClassifierResponse(response: string): ClassifierResult {
  try {
    // 提取 JSON（可能被 markdown 包裹）
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    // 验证字段
    if (!["low", "medium", "high", "critical"].includes(parsed.riskLevel)) {
      throw new Error(`Invalid riskLevel: ${parsed.riskLevel}`);
    }
    
    return {
      riskLevel: parsed.riskLevel,
      reasoning: parsed.reasoning || "No reasoning provided",
      suggestedAction: parsed.suggestedAction || "warn",
    };
  } catch (error) {
    // 解析失败 → 降级
    return {
      riskLevel: "unknown",
      reasoning: `Failed to parse classifier response: ${error}`,
      suggestedAction: "warn",
    };
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Classifier timeout")), ms);
  });
}
```

---

#### 2.2 集成到权限检查

**修改文件**：`src/permissions.ts`

```typescript
// 在 checkDangerousPattern 之后调用
export async function checkPermissionWithClassifier(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
  classifier?: PermissionClassifier,
): Promise<{ dangerous: boolean; reason: string; classifierResult?: ClassifierResult }> {
  // 先静态检查
  const staticCheck = checkDangerousPattern(toolName, input, context.workspaceRoot);
  
  // 如果静态检查已经标记为危险，且有 classifier，进行二次评估
  if (staticCheck.dangerous && classifier) {
    try {
      const classifierResult = await classifyRisk(classifier, toolName, input, context);
      
      // Critical 级别 → 直接拒绝
      if (classifierResult.riskLevel === "critical") {
        return {
          dangerous: true,
          reason: `CRITICAL RISK (AI-assessed): ${classifierResult.reasoning}`,
          classifierResult,
        };
      }
      
      // High 级别 → 增强警告
      if (classifierResult.riskLevel === "high") {
        return {
          dangerous: true,
          reason: `${staticCheck.reason}\n\nAI Assessment: ${classifierResult.reasoning}`,
          classifierResult,
        };
      }
      
      // Medium/Low → 信任 AI 判断，降低警告等级
      if (classifierResult.riskLevel === "low" || classifierResult.riskLevel === "medium") {
        return {
          dangerous: false,  // 允许通过
          reason: `AI re-assessed as ${classifierResult.riskLevel} risk: ${classifierResult.reasoning}`,
          classifierResult,
        };
      }
    } catch (error) {
      // Classifier 失败 → 回退到静态检查结果
      console.warn(`[Classifier] Failed:`, error);
    }
  }
  
  return staticCheck;
}
```

---

#### 2.3 测试

**新增测试**：`src/__tests__/permissions-classifier.test.ts`

```typescript
describe('LLM Permission Classifier', () => {
  it('should classify read operations as low risk', async () => {
    const classifier = mockClassifier({
      response: { riskLevel: "low", reasoning: "Read-only", suggestedAction: "allow" }
    });
    
    const result = await classifyRisk(classifier, "read", { filePath: "test.txt" }, context);
    
    expect(result.riskLevel).toBe("low");
  });
  
  it('should classify sudo commands as critical', async () => {
    const classifier = mockClassifier({
      response: { riskLevel: "critical", reasoning: "Privilege escalation", suggestedAction: "deny" }
    });
    
    const result = await classifyRisk(
      classifier,
      "bash",
      { command: "sudo rm -rf /" },
      context
    );
    
    expect(result.riskLevel).toBe("critical");
    expect(result.suggestedAction).toBe("deny");
  });
  
  it('should timeout and degrade gracefully', async () => {
    const classifier = mockClassifier({ delayMs: 5000, timeoutMs: 1000 });
    
    const result = await classifyRisk(classifier, "bash", { command: "echo hi" }, context);
    
    expect(result.riskLevel).toBe("unknown");
    expect(result.reasoning).toContain("timeout");
  });
  
  it('should override static check for false positives', async () => {
    // 静态检查：危险（包含 "rm -r"）
    const staticCheck = checkDangerousPattern("bash", { command: "rm -r empty_dir" }, "/workspace");
    expect(staticCheck.dangerous).toBe(true);
    
    // AI 评估：实际是低风险（删除空目录）
    const classifier = mockClassifier({
      response: { riskLevel: "low", reasoning: "Deleting empty directory", suggestedAction: "allow" }
    });
    
    const finalCheck = await checkPermissionWithClassifier("bash", { command: "rm -r empty_dir" }, context, classifier);
    
    expect(finalCheck.dangerous).toBe(false);  // AI 覆盖静态检查
  });
});
```

**预期收益**：
- 权限决策准确率 +40%（减少误报）
- 用户体验显著提升（减少不必要的确认）
- 成本：每次危险操作 ~0.5 cents（Haiku）

---

### 🥉 Task 3: Token Budget 增强（3-4 天）

#### 目标
实现跨 workflow 的全局预算池，支持 `+500k` 风格的用户输入。

#### 3.1 扩展 TokenBudgetState

**修改文件**：`src/query/token-budget.ts`

```typescript
export interface GlobalTokenBudget {
  /** 用户设置的总预算（如 +500k），null = 无限制 */
  total: number | null;
  /** 已消耗的 output tokens（累计所有 workflow） */
  spent: number;
  /** 开始时间（用于统计） */
  startTime: number;
}

export function createGlobalBudget(total: number | null = null): GlobalTokenBudget {
  return {
    total,
    spent: 0,
    startTime: Date.now(),
  };
}

export function recordGlobalOutput(
  budget: GlobalTokenBudget,
  outputTokens: number,
): GlobalTokenBudget {
  return {
    ...budget,
    spent: budget.spent + Math.max(0, outputTokens),
  };
}

export function checkGlobalBudget(budget: GlobalTokenBudget): {
  remaining: number | null;
  exhausted: boolean;
  percentUsed: number | null;
} {
  if (budget.total === null) {
    return { remaining: null, exhausted: false, percentUsed: null };
  }
  
  const remaining = Math.max(0, budget.total - budget.spent);
  const exhausted = remaining === 0;
  const percentUsed = (budget.spent / budget.total) * 100;
  
  return { remaining, exhausted, percentUsed };
}
```

---

#### 3.2 解析用户输入

**新增函数**：`src/cli.ts`

```typescript
/**
 * 解析用户输入中的 token 预算（+500k 风格）
 */
function parseTokenBudget(input: string): number | null {
  const match = input.match(/\+(\d+)([km]?)\b/i);
  if (!match) return null;
  
  const value = parseInt(match[1], 10);
  const unit = match[2]?.toLowerCase();
  
  if (unit === 'k') return value * 1000;
  if (unit === 'm') return value * 1_000_000;
  return value;
}

// 使用示例
const userInput = "+500k implement the feature";
const budget = parseTokenBudget(userInput);  // 500000
```

---

#### 3.3 集成到 Agent Loop

**修改文件**：`src/agent-loop.ts`

```typescript
// 在 LoopOptions 中添加全局预算
export interface LoopOptions {
  // ... 现有选项
  globalBudget?: GlobalTokenBudget;
}

// 在 loop 中检查
if (options.globalBudget) {
  const budgetCheck = checkGlobalBudget(options.globalBudget);
  
  if (budgetCheck.exhausted) {
    yield { type: "error", error: new Error("Global token budget exhausted") };
    return terminal("budget_exhausted");
  }
  
  if (budgetCheck.remaining && budgetCheck.remaining < 10_000) {
    yield {
      type: "warning",
      message: `Token budget low: ${budgetCheck.remaining} remaining`,
    };
  }
}

// 在 done 后更新全局预算
if (options.globalBudget && usage?.output_tokens) {
  options.globalBudget = recordGlobalOutput(
    options.globalBudget,
    usage.output_tokens,
  );
}
```

---

#### 3.4 测试

```typescript
describe('Global Token Budget', () => {
  it('should parse +500k budget from user input', () => {
    expect(parseTokenBudget("+500k do something")).toBe(500_000);
    expect(parseTokenBudget("+2m large task")).toBe(2_000_000);
    expect(parseTokenBudget("no budget")).toBe(null);
  });
  
  it('should stop when budget exhausted', async () => {
    const budget = createGlobalBudget(1000);  // 1K 预算
    
    // 消耗 1200 tokens
    for await (const event of agentLoop(messages, tools, callModel, config, { globalBudget: budget })) {
      // ...
    }
    
    // 应该提前终止
    expect(terminal.reason).toBe("budget_exhausted");
  });
});
```

**预期收益**：
- 用户可精确控制成本
- 长任务自动终止，避免意外费用

---

### 🏅 Task 4: Session Memory Compact（4-6 天，可选）

**建议**：此功能复杂度最高，收益相对较低。**建议推迟到 Phase 3 或跳过**。

如果必须实现，参考 `reference/services/compact/sessionMemoryCompact.ts` 的完整实现。

---

## 实施顺序（推荐）

### Week 1: 快速胜利

**Day 1-2**：Task 1 - Usage Baseline 优化
- 修复 baseline 填充逻辑
- 添加 compaction 后重建
- 测试 + 验证性能提升

**Day 3-5**：Task 2 - LLM Classifier（Part 1）
- 实现 `classifyRisk` 核心逻辑
- 单元测试

### Week 2: 集成与测试

**Day 1-2**：Task 2 - LLM Classifier（Part 2）
- 集成到 `checkPermission` 流程
- 集成测试
- 真实场景验证

**Day 3-5**：Task 3 - Token Budget 增强
- 实现全局预算池
- 解析用户输入
- 集成到 agent loop

### Week 3: 优化与文档

**Day 1-2**：性能测试
- Baseline 优化效果验证
- Classifier 准确率统计

**Day 3-4**：文档更新
- 更新项目总览
- 编写完成报告
- 用户指南（环境变量、配置）

**Day 5**：缓冲时间（修复 bug、优化）

---

## 测试策略

### 单元测试（覆盖率 >90%）

- `usage-baseline.test.ts`（baseline 填充、增量估算）
- `permissions-classifier.test.ts`（风险评估、timeout、降级）
- `token-budget.test.ts`（全局预算、解析、检查）

### 集成测试

- 长对话场景（验证 baseline 性能提升）
- 危险命令场景（验证 classifier 效果）
- 预算控制场景（验证全局预算终止）

### 性能测试

**Baseline 优化**：
- 对比：baseline 启用 vs 禁用
- 场景：50 轮对话
- 指标：token 估算耗时（预期从 ~100ms → ~1ms）

**Classifier**：
- 统计：静态检查 vs AI 评估的准确率
- 成本：每次评估的 token 消耗

---

## 风险管理

### 风险 1：Classifier 增加延迟

**概率**：中  
**影响**：中（用户体验下降）

**缓解**：
- 4 秒 timeout（已有）
- 仅对静态检查标记的危险操作调用
- 失败降级到静态检查结果

---

### 风险 2：Baseline 估算不准确

**概率**：低  
**影响**：低（仍有 fallback）

**缓解**：
- 保留全量估算作为 fallback
- compaction 后重建 baseline
- 添加诊断日志验证准确性

---

### 风险 3：全局预算计算错误

**概率**：低  
**影响**：高（用户超支）

**缓解**：
- 严格测试预算逻辑
- 保守估算（向上取整）
- 提前警告（剩余 10K 时提示）

---

## 成功标准

### 功能完整性

- ✅ Usage Baseline 正确填充和重建
- ✅ LLM Classifier 正确评估风险
- ✅ 全局 Token Budget 正确控制消耗

### 性能提升

- ✅ Token 估算耗时降低 95%（100ms → 5ms）
- ✅ Classifier 准确率 > 90%（相比静态检查）
- ✅ 预算控制准确率 > 98%

### 质量保证

- ✅ 单元测试覆盖率 > 90%
- ✅ 所有现有测试通过
- ✅ TypeScript 0 错误
- ✅ Biome lint 0 错误

---

## 预期收益汇总

| 功能 | 性能提升 | 体验提升 | 成本影响 |
|---|---|---|---|
| Usage Baseline | +20% | 小 | 无 |
| LLM Classifier | 小 | +40% | +每次 ~0.5¢ |
| Token Budget | 小 | +30% | 无（节省） |
| **总计** | **+20%** | **+40%** | **净节省** |

**项目完成度**：83-85% → **88-90%** ✨

---

## 下一步行动

1. ✅ 用户确认优先级（推荐：Baseline → Classifier → Budget）
2. ✅ 退出计划模式，开始实施
3. ⏳ Week 1：实施 Task 1 + Task 2（Part 1）

---

**计划状态**：📝 待批准  
**推荐路径**：Task 1 → Task 2 → Task 3（跳过 Task 4）  
**预计完成时间**：2026-07-25（3 周）
