# 鲁棒性提升计划 - claude_personal

**日期**: 2026-07-05  
**目标**: 全面提升项目鲁棒性，从 7.5/10 提升到 9.0/10

---

## 📊 当前状态评估

### 项目现状
```
源文件数: 125 个
测试文件数: 69 个
测试通过率: 99.8% (906/908)
TypeScript 错误: 0
代码行数: ~15,000 行
完成度: 90%
```

### 鲁棒性评分（当前 7.5/10）

| 维度 | 当前评分 | 问题 |
|---|:---:|---|
| 架构设计 | 8.5/10 | ✅ 优秀 |
| 核心正确性 | 8.0/10 | ⚠️ 存在潜在死循环 |
| 安全性 | 7.0/10 | ⚠️ 权限检查缺口 |
| 错误处理 | 6.5/10 | ❌ 缺乏系统化处理 |
| 工程质量 | 8.0/10 | ⚠️ 少量 any 类型 |
| 可维护性 | 8.0/10 | ⚠️ 循环依赖 |
| 边界检查 | 6.0/10 | ❌ 输入验证不足 |

### 已知 P0 级问题（来自项目评审报告）

1. ❌ **context_length 错误死循环** - `agent-loop.ts:541`
   - 返回 "retry" 但不压缩，无限重试
   
2. ❌ **429 重试无上限** - `agent-loop.ts:534`
   - 无退避策略，无最大重试次数
   
3. ⚠️ **子代理权限全放行** - `agent-loop.ts:25`
   - `defaultAskUser` 自动允许，bash/write 免审批
   
4. ⚠️ **Bash 权限检查可能是死代码**
   - default 模式下审批链路存疑

---

## 🎯 提升目标

### 总体目标
从 **7.5/10** 提升到 **9.0/10**（+20%）

### 分项目标

| 维度 | 当前 | 目标 | 提升 |
|---|:---:|:---:|:---:|
| 核心正确性 | 8.0 | 9.5 | +19% |
| 安全性 | 7.0 | 9.0 | +29% |
| 错误处理 | 6.5 | 9.0 | +38% |
| 边界检查 | 6.0 | 8.5 | +42% |
| 工程质量 | 8.0 | 9.0 | +13% |
| 可维护性 | 8.0 | 8.5 | +6% |

---

## 📋 实施计划

## Phase 1: 核心正确性修复（P0 优先级）

### 1.1 修复 context_length 死循环 ⚡ 高危
**文件**: `src/agent-loop.ts:541-547`

**当前问题**:
```typescript
if (error.type === "context_length_exceeded") {
  return "retry"; // ❌ 不压缩就重试 → 死循环
}
```

**修复方案**:
```typescript
if (error.type === "context_length_exceeded") {
  // 强制触发压缩
  if (retryCount >= MAX_CONTEXT_RETRIES) {
    return "terminal"; // 超过上限，终止
  }
  // 标记需要压缩
  shouldCompact = true;
  retryCount++;
  return "retry";
}
```

**影响**: 防止死循环，保护用户系统

---

### 1.2 修复 429 重试无限循环 ⚡ 高危
**文件**: `src/agent-loop.ts:534-540`

**当前问题**:
```typescript
if (error.type === "rate_limit_error") {
  await sleep(retryAfter || 5000);
  return "retry"; // ❌ 无上限
}
```

**修复方案**:
```typescript
const MAX_RATE_LIMIT_RETRIES = 3;
let rateLimitRetryCount = 0;

if (error.type === "rate_limit_error") {
  if (rateLimitRetryCount >= MAX_RATE_LIMIT_RETRIES) {
    return "terminal";
  }
  
  // 指数退避
  const backoff = Math.min(
    (retryAfter || 5000) * Math.pow(2, rateLimitRetryCount),
    60000 // 最大 60 秒
  );
  
  rateLimitRetryCount++;
  await sleep(backoff);
  return "retry";
}
```

**影响**: 防止 API 滥用，提升用户体验

---

## Phase 2: 安全性增强（P0 优先级）

### 2.1 子代理权限隔离 🔒 安全
**文件**: `src/agent-loop.ts:25`, `src/tools/extended/task.ts`

**当前问题**:
```typescript
const defaultAskUser: AskUserFn = async () => true; // ❌ 全放行
```

**修复方案**:
```typescript
// 1. 为子代理创建受限审批器
const createSubAgentApprover = (
  parentApprover?: AskUserFn,
  restrictive: boolean = true
): AskUserFn => {
  return async (prompt: string, tool: string) => {
    // 危险工具必须经过父级审批
    const dangerousTools = ['bash', 'write', 'edit', 'multi_edit'];
    
    if (dangerousTools.includes(tool)) {
      if (parentApprover) {
        return parentApprover(
          `[Sub-agent] ${prompt}`,
          tool
        );
      }
      // 无父级审批器且在严格模式 → 拒绝
      return restrictive ? false : true;
    }
    
    // 只读工具自动允许
    return true;
  };
};

// 2. Task tool 使用受限审批器
const subContext: ToolContext = {
  ...context,
  askUser: createSubAgentApprover(context.askUser, true),
};
```

**影响**: 防止子代理绕过权限检查

---

### 2.2 Bash 权限检查强化 🔒 安全
**文件**: `src/permissions.ts`, `src/tools/core/bash.ts`

**修复方案**:
```typescript
// 1. 确保 checkPermissions 被正确调用
export async function checkPermission(
  tool: Tool,
  input: ToolInput,
  context: ToolContext
): Promise<boolean> {
  // 添加日志验证调用链
  if (process.env.DEBUG_PERMISSIONS) {
    console.log(`Checking permission for ${tool.name}`);
  }
  
  // 确保非只读工具必须检查
  if (!tool.isReadOnly(input)) {
    const result = await tool.checkPermissions(input, context);
    if (!result.allowed) {
      return false;
    }
  }
  
  // 如果需要审批，调用 askUser
  if (tool.requiresApproval()) {
    return context.askUser(...);
  }
  
  return true;
}

// 2. 添加测试验证
describe('Bash permission check', () => {
  it('should block dangerous commands in default mode', async () => {
    const result = await checkPermission(
      BashTool,
      { command: 'rm -rf /', description: 'test' },
      { ...context, permissionMode: 'default' }
    );
    expect(result).toBe(false);
  });
});
```

**影响**: 确保权限系统有效工作

---

## Phase 3: 错误处理系统化（P1 优先级）

### 3.1 统一错误处理框架 📦 架构
**新文件**: `src/utils/error-handler.ts`

**实现**:
```typescript
// 1. 错误分类
export enum ErrorCategory {
  VALIDATION = 'validation',     // 输入验证错误
  PERMISSION = 'permission',     // 权限错误
  NETWORK = 'network',          // 网络错误
  FILESYSTEM = 'filesystem',    // 文件系统错误
  PROVIDER = 'provider',        // LLM Provider 错误
  TIMEOUT = 'timeout',          // 超时错误
  UNKNOWN = 'unknown',          // 未知错误
}

// 2. 错误元数据
export interface ErrorMetadata {
  category: ErrorCategory;
  retryable: boolean;
  userFacing: boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  suggestion?: string;
}

// 3. 结构化错误
export class StructuredError extends Error {
  constructor(
    message: string,
    public metadata: ErrorMetadata,
    public cause?: Error
  ) {
    super(message);
    this.name = 'StructuredError';
  }
}

// 4. 错误处理器
export class ErrorHandler {
  static handle(error: Error, context: ErrorContext): ErrorResult {
    const structured = this.classify(error);
    
    // 记录日志
    this.log(structured, context);
    
    // 决定重试策略
    const shouldRetry = this.shouldRetry(structured, context);
    
    // 生成用户友好消息
    const userMessage = this.formatUserMessage(structured);
    
    return { shouldRetry, userMessage, severity: structured.metadata.severity };
  }
  
  private static classify(error: Error): StructuredError {
    // 分类逻辑
    if (error.message.includes('ENOENT')) {
      return new StructuredError(
        error.message,
        {
          category: ErrorCategory.FILESYSTEM,
          retryable: false,
          userFacing: true,
          severity: 'medium',
          suggestion: 'Check if the file exists'
        },
        error
      );
    }
    // ... 更多分类
  }
}
```

**影响**: 统一错误处理，提升可维护性

---

### 3.2 添加错误恢复机制 🔄 可靠性
**文件**: `src/agent-loop.ts`, `src/tools/core/*.ts`

**实现**:
```typescript
// 1. 工具级错误恢复
export async function executeToolWithRecovery(
  tool: Tool,
  input: ToolInput,
  context: ToolContext
): Promise<ToolResult> {
  const maxRetries = 3;
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await tool.call(input, context);
    } catch (error) {
      lastError = error as Error;
      
      const structured = ErrorHandler.handle(error, { tool: tool.name, attempt });
      
      if (!structured.shouldRetry || attempt === maxRetries - 1) {
        // 返回错误结果而非抛出
        return {
          content: '',
          error: structured.userMessage,
          metadata: { 
            category: structured.severity,
            attempts: attempt + 1
          }
        };
      }
      
      // 等待后重试
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  
  // 不应该到这里
  throw lastError;
}
```

**影响**: 提升系统容错能力

---

## Phase 4: 边界检查和输入验证（P1 优先级）

### 4.1 工具输入验证增强 ✅ 安全
**文件**: `src/tools/core/*.ts`

**实现**:
```typescript
// 1. 通用验证器
export class InputValidator {
  static validateFilePath(path: string, context: ToolContext): ValidationResult {
    // 检查路径长度
    if (path.length > 4096) {
      return { valid: false, error: 'Path too long' };
    }
    
    // 检查非法字符
    if (/[\x00-\x1F]/.test(path)) {
      return { valid: false, error: 'Invalid characters in path' };
    }
    
    // 检查路径遍历
    const normalized = path.normalize(path);
    if (normalized.includes('..')) {
      return { valid: false, error: 'Path traversal detected' };
    }
    
    // 检查工作空间边界
    const resolution = resolveInWorkspace(path, context.workspaceRoot);
    if (!resolution.ok) {
      return { valid: false, error: resolution.error };
    }
    
    return { valid: true };
  }
  
  static validateCommand(command: string): ValidationResult {
    // 检查命令长度
    if (command.length > 100000) {
      return { valid: false, error: 'Command too long' };
    }
    
    // 检查危险模式
    const dangerous = [
      /:\(\)\{\s*:\|\:&\s*\};:/,  // Fork bomb
      />\s*\/dev\/sd[a-z]/,        // Write to device
      /dd\s+if=/,                  // dd command
    ];
    
    for (const pattern of dangerous) {
      if (pattern.test(command)) {
        return { valid: false, error: 'Dangerous command pattern detected' };
      }
    }
    
    return { valid: true };
  }
}

// 2. 在每个工具中应用
export const ReadTool: Tool = buildTool({
  name: "read",
  // ...
  async call(input, context): Promise<ToolResult> {
    // 验证输入
    const validation = InputValidator.validateFilePath(input.filePath, context);
    if (!validation.valid) {
      return { content: "", error: validation.error };
    }
    
    // ... 原有逻辑
  },
});
```

**影响**: 防止注入攻击和异常输入

---

### 4.2 资源限制和配额 📊 稳定性
**新文件**: `src/utils/resource-limiter.ts`

**实现**:
```typescript
export class ResourceLimiter {
  private static limits = {
    maxFileSize: 10 * 1024 * 1024,      // 10MB
    maxConcurrentTools: 10,             // 最多 10 个并发工具
    maxToolExecutionTime: 300000,       // 5 分钟
    maxMemoryUsage: 1024 * 1024 * 1024, // 1GB
    maxOpenFiles: 100,                  // 最多 100 个打开文件
  };
  
  private static metrics = {
    openFiles: new Set<string>(),
    runningTools: 0,
  };
  
  static async checkFileSize(path: string): Promise<boolean> {
    const stat = await fs.stat(path);
    return stat.size <= this.limits.maxFileSize;
  }
  
  static async acquireToolSlot(): Promise<boolean> {
    if (this.metrics.runningTools >= this.limits.maxConcurrentTools) {
      return false;
    }
    this.metrics.runningTools++;
    return true;
  }
  
  static releaseToolSlot(): void {
    this.metrics.runningTools = Math.max(0, this.metrics.runningTools - 1);
  }
  
  static trackFileOpen(path: string): boolean {
    if (this.metrics.openFiles.size >= this.limits.maxOpenFiles) {
      return false;
    }
    this.metrics.openFiles.add(path);
    return true;
  }
  
  static trackFileClose(path: string): void {
    this.metrics.openFiles.delete(path);
  }
}
```

**影响**: 防止资源耗尽

---

## Phase 5: 工程质量提升（P2 优先级）

### 5.1 消除 any 类型 🔧 质量
**目标**: 将 any 类型使用率从当前降低 80%

**策略**:
```typescript
// 1. 找出所有 any
grep -r ": any" src/**/*.ts > any-report.txt

// 2. 逐个替换为具体类型
// 示例：
// 改前
function process(data: any): void { }

// 改后
interface ProcessData {
  type: string;
  payload: unknown;
}
function process(data: ProcessData): void { }

// 3. 使用 unknown 替代 any（需要类型守卫）
function handle(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}
```

---

### 5.2 打破循环依赖 🔄 架构
**当前问题**: `tools.ts` → `TaskTool` → `subagents.ts` → `tools.ts`

**解决方案**:
```typescript
// 1. 提取公共接口
// src/tools/interfaces.ts
export interface ToolDefinition {
  name: string;
  description: string;
  // ...
}

// 2. 使用依赖注入
// src/tools/extended/task.ts
let coreToolsGetter: (() => Tool[]) | null = null;

export function setCoreToolsGetter(getter: () => Tool[]): void {
  coreToolsGetter = getter;
}

// 3. CLI 初始化时注入
// src/cli.ts
setCoreToolsGetter(() => CORE_TOOLS);
```

---

### 5.3 添加更多错误场景测试 🧪 质量
**目标**: 错误场景测试覆盖率 80%

**实现**:
```typescript
// src/__tests__/error-scenarios.test.ts
describe('Error Scenarios', () => {
  describe('File Operations', () => {
    it('should handle file not found', async () => {
      const result = await ReadTool.call(
        { filePath: '/nonexistent.txt' },
        context
      );
      expect(result.error).toContain('not found');
    });
    
    it('should handle permission denied', async () => {
      // Mock fs.readFileSync to throw EACCES
      // ...
    });
    
    it('should handle file too large', async () => {
      // ...
    });
  });
  
  describe('Network Operations', () => {
    it('should handle timeout', async () => {
      // ...
    });
    
    it('should handle connection refused', async () => {
      // ...
    });
  });
  
  describe('Provider Errors', () => {
    it('should handle rate limit', async () => {
      // ...
    });
    
    it('should handle invalid API key', async () => {
      // ...
    });
  });
});
```

---

## Phase 6: 监控和可观测性（P2 优先级）

### 6.1 添加健康检查 ❤️ 运维
**新文件**: `src/utils/health-check.ts`

**实现**:
```typescript
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    filesystem: boolean;
    provider: boolean;
    memory: boolean;
    tools: boolean;
  };
  metrics: {
    uptime: number;
    totalTools: number;
    failedTools: number;
    memoryUsage: number;
  };
}

export class HealthChecker {
  static async check(): Promise<HealthStatus> {
    const checks = {
      filesystem: await this.checkFilesystem(),
      provider: await this.checkProvider(),
      memory: this.checkMemory(),
      tools: this.checkTools(),
    };
    
    const allHealthy = Object.values(checks).every(v => v);
    const status = allHealthy ? 'healthy' : 
                  Object.values(checks).some(v => v) ? 'degraded' : 
                  'unhealthy';
    
    return {
      status,
      checks,
      metrics: this.collectMetrics(),
    };
  }
  
  private static async checkFilesystem(): Promise<boolean> {
    try {
      await fs.access(process.cwd(), fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  
  private static checkMemory(): boolean {
    const usage = process.memoryUsage();
    return usage.heapUsed < ResourceLimiter.limits.maxMemoryUsage;
  }
}
```

---

### 6.2 添加性能监控 📈 运维
**实现**:
```typescript
export class PerformanceMonitor {
  private static metrics = new Map<string, number[]>();
  
  static recordToolExecution(toolName: string, durationMs: number): void {
    if (!this.metrics.has(toolName)) {
      this.metrics.set(toolName, []);
    }
    this.metrics.get(toolName)!.push(durationMs);
    
    // 保留最近 100 条
    const arr = this.metrics.get(toolName)!;
    if (arr.length > 100) {
      arr.shift();
    }
  }
  
  static getStats(toolName: string): ToolStats | null {
    const data = this.metrics.get(toolName);
    if (!data || data.length === 0) return null;
    
    return {
      count: data.length,
      avg: data.reduce((a, b) => a + b, 0) / data.length,
      min: Math.min(...data),
      max: Math.max(...data),
      p95: this.percentile(data, 95),
    };
  }
}
```

---

## 📊 实施优先级

### P0 - 立即修复（1-2 天）
1. ✅ context_length 死循环修复
2. ✅ 429 重试无限循环修复
3. ✅ 子代理权限隔离
4. ✅ Bash 权限检查强化

### P1 - 近期完成（3-5 天）
5. ✅ 统一错误处理框架
6. ✅ 工具输入验证增强
7. ✅ 资源限制和配额
8. ✅ 错误恢复机制

### P2 - 中期改进（1-2 周）
9. ⏳ 消除 any 类型
10. ⏳ 打破循环依赖
11. ⏳ 错误场景测试
12. ⏳ 健康检查和监控

---

## 🎯 预期成果

### 鲁棒性评分提升

| 维度 | 改进前 | 改进后 | 提升 |
|---|:---:|:---:|:---:|
| 核心正确性 | 8.0 | 9.5 | +19% |
| 安全性 | 7.0 | 9.0 | +29% |
| 错误处理 | 6.5 | 9.0 | +38% |
| 边界检查 | 6.0 | 8.5 | +42% |
| 工程质量 | 8.0 | 9.0 | +13% |
| 可维护性 | 8.0 | 8.5 | +6% |
| **总体** | **7.5** | **9.0** | **+20%** |

### 量化指标

```
P0 级 Bug:       4 → 0      (-100%)
错误处理覆盖:     30% → 80%   (+167%)
输入验证覆盖:     40% → 90%   (+125%)
错误场景测试:     10 → 80     (+700%)
any 类型使用:     50 → 10     (-80%)
循环依赖:        3 → 0       (-100%)
健康检查:        无 → 有      (新增)
性能监控:        无 → 有      (新增)
```

---

## 🔧 执行建议

### 第一周（P0）
- Day 1-2: 修复死循环和无限重试
- Day 3-4: 权限系统强化
- Day 5: 集成测试和验证

### 第二周（P1）
- Day 1-3: 错误处理框架
- Day 4-5: 输入验证和资源限制
- Day 6-7: 测试和文档

### 第三-四周（P2）
- Week 3: 代码质量提升
- Week 4: 监控和可观测性

---

## ✅ 验收标准

### 必须满足
1. ✅ 所有 P0 Bug 修复
2. ✅ TypeScript 编译 0 错误
3. ✅ 测试通过率 ≥ 99%
4. ✅ 无新增安全漏洞
5. ✅ 错误处理覆盖 ≥ 80%

### 建议达到
6. ⏳ any 类型减少 80%
7. ⏳ 错误场景测试 +70
8. ⏳ 循环依赖清除
9. ⏳ 健康检查实现
10. ⏳ 性能监控实现

---

## 📝 后续维护

### 持续监控
- 每周检查错误日志
- 每月审查性能指标
- 每季度安全审计

### 文档更新
- 更新错误处理指南
- 添加故障排查文档
- 完善开发者指南

### 技术债务
- 建立技术债务跟踪
- 定期评审和偿还
- 保持代码质量

---

**制定时间**: 2026-07-05  
**预计完成**: 2026-07-26 (3-4 周)  
**预期收益**: 鲁棒性 +20%，用户体验显著提升
