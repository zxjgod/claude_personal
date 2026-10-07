# Phase 2 Task 3: Token Budget 增强 - 实施计划

> 开始时间：2026-07-05  
> 预计工期：3-4 天  
> 优先级：P1

## 目标

实现跨 workflow 的全局 token 预算池，支持用户通过 `+500k` 风格的输入精确控制 AI 消耗成本。

---

## 现状分析

### 已有实现（60%）

**1. Turn Output Budget**

`src/query/token-budget.ts`:
```typescript
export interface TokenBudgetState {
  totalOutput: number;        // 累计 output
  lowGainStreak: number;      // 低增益连续次数
  continuations: number;      // 自动继续次数
}

export function checkTokenBudget(
  state: TokenBudgetState,
  lastTurnOutput: number,
  config: TokenBudgetConfig,
): BudgetDecision {
  // 检查是否应该自动继续
}
```

**限制**：
- ❌ 仅单轮预算（`turnOutputBudget`）
- ❌ 无法跨 workflow 共享
- ❌ 不支持用户输入预算（如 `+500k`）

---

**2. Agent Loop 集成**

`src/agent-loop.ts:143`:
```typescript
export interface LoopOptions {
  turnOutputBudget?: number;  // 单轮输出预算
  // ...
}
```

`src/agent-loop.ts:190`:
```typescript
state = {
  budget: createTokenBudgetState(),
  // ...
};
```

---

### 需要实现（40%）

1. ✅ **全局预算结构** - 跨 workflow 共享
2. ✅ **用户输入解析** - `+500k` → 500000
3. ✅ **预算检查逻辑** - 耗尽时终止
4. ✅ **预算记录** - 每次 model call 更新
5. ✅ **警告机制** - 低预算提示
6. ✅ **CLI 集成** - 解析用户输入

---

## 实施方案

### Step 1: 扩展 TokenBudgetState

**文件**：`src/query/token-budget.ts`

**新增接口**：
```typescript
/**
 * Global token budget (M42, kernel §10).
 * Tracks cumulative output token usage across all workflows/turns.
 * Enables "+500k" style user budget control.
 */
export interface GlobalTokenBudget {
  /** User-specified total budget (e.g. 500000 for "+500k"), null = unlimited */
  total: number | null;
  /** Cumulative output tokens spent across all workflows */
  spent: number;
  /** Start time for statistics */
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

export interface GlobalBudgetStatus {
  remaining: number | null;  // null = unlimited
  exhausted: boolean;
  percentUsed: number | null;
  warningLevel: "none" | "low" | "critical";
}

export function checkGlobalBudget(budget: GlobalTokenBudget): GlobalBudgetStatus {
  if (budget.total === null) {
    return {
      remaining: null,
      exhausted: false,
      percentUsed: null,
      warningLevel: "none",
    };
  }

  const remaining = Math.max(0, budget.total - budget.spent);
  const exhausted = remaining === 0;
  const percentUsed = (budget.spent / budget.total) * 100;

  let warningLevel: "none" | "low" | "critical" = "none";
  if (percentUsed >= 95) warningLevel = "critical";
  else if (percentUsed >= 80) warningLevel = "low";

  return { remaining, exhausted, percentUsed, warningLevel };
}
```

---

### Step 2: 解析用户输入

**文件**：`src/cli.ts`（或新建 `src/utils/budget-parser.ts`）

```typescript
/**
 * Parse token budget from user input.
 * 
 * Examples:
 *   "+500k implement feature" → 500000
 *   "+2m large task" → 2000000
 *   "+10000 small task" → 10000
 *   "no budget here" → null
 */
export function parseTokenBudget(input: string): number | null {
  // Match +数字[k|m] pattern
  const match = input.match(/\+(\d+)([km]?)\b/i);
  if (!match) return null;

  const value = Number.parseInt(match[1], 10);
  const unit = match[2]?.toLowerCase();

  if (unit === "k") return value * 1000;
  if (unit === "m") return value * 1_000_000;
  return value;
}

/**
 * Strip budget directive from user input.
 * 
 * Example:
 *   "+500k implement feature" → "implement feature"
 */
export function stripBudgetDirective(input: string): string {
  return input.replace(/\+\d+[km]?\s*/i, "").trim();
}
```

**测试**：
```typescript
describe("parseTokenBudget", () => {
  it("parses +500k format", () => {
    expect(parseTokenBudget("+500k do something")).toBe(500_000);
  });

  it("parses +2m format", () => {
    expect(parseTokenBudget("+2m large task")).toBe(2_000_000);
  });

  it("parses plain number", () => {
    expect(parseTokenBudget("+10000 task")).toBe(10_000);
  });

  it("returns null for no budget", () => {
    expect(parseTokenBudget("no budget")).toBe(null);
  });

  it("strips budget from input", () => {
    expect(stripBudgetDirective("+500k implement feature")).toBe("implement feature");
  });
});
```

---

### Step 3: 集成到 Agent Loop

**文件**：`src/agent-loop.ts`

**修改 LoopOptions**：
```typescript
export interface LoopOptions {
  // 现有选项...
  
  /**
   * Global token budget (M42). When set, the loop tracks cumulative output
   * across all turns and terminates with "budget_exhausted" when the limit
   * is reached. Shared across workflows when passed down.
   */
  globalBudget?: GlobalTokenBudget;
}
```

**在 loop 开始检查**：
```typescript
// 在 while 循环顶部
if (options.globalBudget) {
  const status = checkGlobalBudget(options.globalBudget);
  
  if (status.exhausted) {
    yield {
      type: "error",
      error: new Error(`Token budget exhausted (${options.globalBudget.spent} tokens used)`),
    };
    return terminal("budget_exhausted");
  }
  
  // Warning at 80% and 95%
  if (status.warningLevel === "critical") {
    yield {
      type: "warning",
      message: `Token budget critical: ${status.remaining} tokens remaining (${status.percentUsed?.toFixed(1)}% used)`,
    };
  } else if (status.warningLevel === "low") {
    yield {
      type: "warning",
      message: `Token budget low: ${status.remaining} tokens remaining`,
    };
  }
}
```

**在 done 后更新**：
```typescript
case "done": {
  usage = event.usage;
  lastTurnOutput = event.usage.output_tokens;
  
  // 更新全局预算
  if (options.globalBudget) {
    options.globalBudget = recordGlobalOutput(
      options.globalBudget,
      usage.output_tokens,
    );
  }
  
  // ... 现有逻辑
}
```

---

### Step 4: CLI 集成

**文件**：`src/cli.ts`（或 TUI 入口）

```typescript
// 在处理用户输入时
const rawInput = await readInput();
if (!rawInput) continue;

// 解析预算
const budgetAmount = parseTokenBudget(rawInput);
const cleanedInput = stripBudgetDirective(rawInput);

// 创建或更新全局预算
if (budgetAmount !== null) {
  globalBudget = createGlobalBudget(budgetAmount);
  console.log(`Token budget set: ${budgetAmount} tokens`);
}

// 传递给 agent loop
for await (const event of agentLoop(messages, tools, callModel, config, {
  ...options,
  globalBudget,
})) {
  // ...
}
```

---

### Step 5: 添加测试

**文件**：`src/__tests__/token-budget-global.test.ts`

```typescript
describe("Global Token Budget", () => {
  describe("parseTokenBudget", () => {
    // ... 如上测试用例
  });

  describe("GlobalTokenBudget", () => {
    it("creates unlimited budget by default", () => {
      const budget = createGlobalBudget();
      expect(budget.total).toBe(null);
      expect(budget.spent).toBe(0);
    });

    it("creates budget with specified limit", () => {
      const budget = createGlobalBudget(500_000);
      expect(budget.total).toBe(500_000);
    });

    it("records output tokens", () => {
      let budget = createGlobalBudget(1000);
      budget = recordGlobalOutput(budget, 300);
      expect(budget.spent).toBe(300);
      
      budget = recordGlobalOutput(budget, 200);
      expect(budget.spent).toBe(500);
    });

    it("checks budget status", () => {
      const budget = createGlobalBudget(1000);
      budget.spent = 900;  // 90% used
      
      const status = checkGlobalBudget(budget);
      expect(status.remaining).toBe(100);
      expect(status.exhausted).toBe(false);
      expect(status.percentUsed).toBe(90);
      expect(status.warningLevel).toBe("low");
    });

    it("detects exhausted budget", () => {
      const budget = createGlobalBudget(1000);
      budget.spent = 1000;
      
      const status = checkGlobalBudget(budget);
      expect(status.exhausted).toBe(true);
      expect(status.remaining).toBe(0);
    });

    it("handles unlimited budget", () => {
      const budget = createGlobalBudget(null);
      budget.spent = 999999;
      
      const status = checkGlobalBudget(budget);
      expect(status.exhausted).toBe(false);
      expect(status.remaining).toBe(null);
      expect(status.percentUsed).toBe(null);
    });
  });

  describe("Agent Loop Integration", () => {
    it("terminates when budget exhausted", async () => {
      // Mock callModel to return 600 output tokens
      const budget = createGlobalBudget(1000);
      
      let terminated = false;
      for await (const event of agentLoop(messages, tools, mockCallModel, config, {
        globalBudget: budget,
      })) {
        if (event.type === "error" && event.error?.message?.includes("exhausted")) {
          terminated = true;
        }
      }
      
      expect(terminated).toBe(true);
      expect(budget.spent).toBeGreaterThanOrEqual(1000);
    });

    it("warns at 80% usage", async () => {
      const budget = createGlobalBudget(1000);
      budget.spent = 800;  // 80%
      
      let warned = false;
      for await (const event of agentLoop(messages, tools, mockCallModel, config, {
        globalBudget: budget,
      })) {
        if (event.type === "warning" && event.message?.includes("low")) {
          warned = true;
        }
      }
      
      expect(warned).toBe(true);
    });
  });
});
```

---

## 实施顺序

### Day 1: 核心数据结构
1. ✅ 扩展 `token-budget.ts`（GlobalTokenBudget 接口）
2. ✅ 实现 `parseTokenBudget` 和 `stripBudgetDirective`
3. ✅ 单元测试（budget 逻辑 + 解析）

### Day 2: Agent Loop 集成
4. ✅ 修改 `LoopOptions` 添加 `globalBudget`
5. ✅ 在 loop 中添加预算检查
6. ✅ 在 done 后更新预算
7. ✅ 集成测试

### Day 3: CLI 集成 + 测试
8. ✅ CLI 解析用户输入
9. ✅ 传递预算到 agent loop
10. ✅ 端到端测试
11. ✅ 文档更新

---

## 风险管理

### 风险 1：预算计算不准确

**概率**：低  
**影响**：高（用户超支）

**缓解**：
- 使用 provider 报告的 output_tokens（精确）
- 保守估算（向上取整）
- 提前警告（80%/95%）

---

### 风险 2：跨 workflow 共享问题

**概率**：中  
**影响**：中（预算隔离失败）

**缓解**：
- 明确文档说明预算共享机制
- 提供选项：shared vs isolated
- 测试多 workflow 场景

---

## 成功标准

### 功能完整性
- ✅ 正确解析 `+500k` 格式
- ✅ 跨 turn 累计消耗
- ✅ 预算耗尽时终止
- ✅ 80%/95% 警告

### 质量保证
- ✅ 单元测试覆盖率 >90%
- ✅ 集成测试通过
- ✅ TypeScript 0 错误
- ✅ Biome lint 0 错误

### 用户体验
- ✅ 清晰的预算提示
- ✅ 优雅的终止消息
- ✅ 文档完整

---

## 预期收益

**成本控制**：
- 用户可精确设置最大消耗
- 避免意外超支
- 长任务自动终止

**用户体验**：
- 简洁的预算语法（`+500k`）
- 实时预算提示
- 可预测的成本

---

**计划状态**：📝 准备实施  
**预计完成时间**：2026-07-08（3 天）  
**Phase 2 完成度（完成后）**：75%
