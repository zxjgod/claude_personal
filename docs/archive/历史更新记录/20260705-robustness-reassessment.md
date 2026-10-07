# 鲁棒性重新评估报告
**日期**: 2026-07-05  
**对比**: 2026-06-23 项目评审报告

---

## 📊 问题状态核查

### P0 级问题（来自 2026-06-23 评审报告）

#### 1. ❌ context_length 错误死循环
**原评审报告声称**: `agent-loop.ts:541-547` 返回 "retry" 但不压缩

**实际代码检查** (`agent-loop.ts:437-456`):
```typescript
if (recovery === "compact_and_retry") {
  state = { ...state, contextLengthRetries: state.contextLengthRetries + 1 };
  try {
    messages = await autoCompact(messages, callModel, modelConfig, abortSignal);
    yield {
      type: "compacted",
      summary: "Context compressed after context_length error",
    };
    nextAction = "retry";
    streamEnded = true;
  } catch {
    nextAction = "abort";
    abortError = event.error;
    streamEnded = true;
  }
  break;
}
```

**结论**: ✅ **已修复**
- 有 `autoCompact` 调用
- 有 `contextLengthRetries` 计数器
- 有 `MAX_CONTEXT_LENGTH_RETRIES = 3` 上限
- 压缩失败会 abort

---

#### 2. ❌ 429 重试无限循环
**原评审报告声称**: 无上限且不退避

**实际代码检查** (`agent-loop.ts:1209-1222`):
```typescript
// Rate limit → wait and retry (bounded)
if (
  err?.status === 429 ||
  (err?.code === "rate_limit_exceeded" && err?.type === "rate_limit_error")
) {
  if (state.rateLimitRetries >= state.maxRateLimitRetries) {
    return "abort";
  }
  const retryAfter = err?.headers?.["retry-after"]
    ? Number.parseInt(err.headers["retry-after"], 10) * 1000
    : err?.error?.retry_after
      ? err.error.retry_after * 1000
      : 5000;
  await sleep(retryAfter);
  return "retry";
}
```

**配置检查** (`agent-loop.ts:181-182`):
```typescript
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_CONTEXT_LENGTH_RETRIES = 3;
```

**结论**: ✅ **已修复**
- 有 `MAX_RATE_LIMIT_RETRIES = 3` 上限
- 使用 `retry-after` header
- 有默认 5000ms 等待
- **缺少**: 指数退避策略（但有基本保护）

---

#### 3. ⚠️ 子代理权限全放行
**原评审报告声称**: `defaultAskUser` 自动允许，bash/write 免审批

**实际代码检查** (`agent-loop.ts:41`):
```typescript
const defaultAskUser: AskUserFn = async () => true;
```

**使用位置** (`agent-loop.ts:135, 164`):
```typescript
askUser = defaultAskUser,  // 默认参数
// 注释: sub-agents and tests use defaultAskUser
// which auto-approves everything — a safety gap
```

**结论**: ⚠️ **仍存在问题**
- `defaultAskUser` 确实全部放行
- 子代理和测试场景会绕过审批
- 这是一个**设计决策**，有注释说明
- **需要**: 为子代理创建受限审批器

---

#### 4. ⚠️ Bash 权限检查可能是死代码
**原评审报告声称**: default 模式下审批链路存疑

**需要检查**: `permissions.ts` 和 `BashTool.checkPermissions`

---

## 🔍 深入检查其他潜在问题

### 检查点 1: 输入验证
