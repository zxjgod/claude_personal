# Runtime Monitor 使用指南

## 概述

运行时监控工具用于诊断 TUI 流式输出的偶发问题，特别是：
- AI 回复多行显示
- Markdown 渲染异常
- 流式更新抖动

## 快速开始

### 方法 1：环境变量（推荐）

```bash
# 启用基本日志
DEBUG_STREAM=info npm run tui

# 启用详细日志
DEBUG_STREAM=verbose npm run tui

# 关闭日志
DEBUG_STREAM=off npm run tui
```

### 方法 2：代码中启用

```typescript
import { enableDebug, disableDebug } from './debug-logs/streaming-hooks.js';

// 在应用启动时
enableDebug('verbose');

// ... 运行测试 ...

// 完成后禁用
disableDebug();
```

## 日志级别

| 级别 | 说明 | 输出量 |
|------|------|--------|
| `off` | 关闭日志 | 无 |
| `info` | 基本事件 | 低 |
| `warn` | 警告事件 | 中 |
| `debug` | 详细调试 | 高 |
| `verbose` | 全部日志 | 最高 |

## 日志输出位置

日志文件保存在 `debug-logs/runtime-YYYY-MM-DD_HH-mm-ss.log`

例如：
```
debug-logs/runtime-2024-01-15_14-30-00.log
```

## 日志格式

```
14:30:00.123 info    [stream ] → delta #1 (+5 chars, total: 5, gap: 0ms)
14:30:00.156 info    [stream ] → delta #2 (+12 chars, total: 17, gap: 33ms)
14:30:00.234 info    [render ] render (text: 17, stable: 0, unstable: 17)
14:30:01.567 warn    [timing ] ⚠ Rapid delta (8ms gap)
14:30:05.123 info    [stream ] ◉ commit (150 chars in 5123ms, 45 deltas)
```

## 集成到代码

### 在 StreamBuffer 中使用

```typescript
import { createDebugStreamBuffer } from './debug-logs/streaming-hooks.js';

const streamBuffer = new StreamBuffer((text) => {
  store.appendStreamingWithTokens(text, liveTokens());
});

// 创建调试包装
const debugBuffer = createDebugStreamBuffer(
  (delta) => streamBuffer.push(delta),
  () => streamBuffer.flush(),
  () => store.getSnapshot().streamingText,
);

// 替换原来的方法
debugBuffer.push(event.delta);
debugBuffer.flush();
```

### 在 StreamingMarkdown 中使用

```typescript
import { logStreamingMarkdownRender } from './debug-logs/streaming-hooks.js';

export function StreamingMarkdown({ children }) {
  // ... 原有逻辑 ...

  logStreamingMarkdownRender(
    children,
    stablePrefix,
    unstableSuffix,
    tokens.length,
  );

  // ... 原有返回 ...
}
```

### 在 TuiStore 中使用

```typescript
import { createDebugStoreWrapper } from './debug-logs/streaming-hooks.js';

const store = new TuiStore('model', { batching: true });
const debugStore = createDebugStoreWrapper(store);
```

## 分析日志

### 常见问题模式

1. **Rapid Updates（快速更新）**
   ```
   14:30:00.123 warn    [timing ] ⚠ Rapid delta (8ms gap)
   ```
   表示 delta 之间的间隔太短，可能导致渲染抖动。

2. **Unstable Boundary（边界不稳定）**
   ```
   14:30:00.456 warn    [boundary] ⚠ Stable prefix longer than text
   ```
   表示 stable prefix 计算有误，可能需要检查边界逻辑。

3. **Excessive Deltas（过多小增量）**
   ```
   14:30:05.123 info    [stream ] ◉ commit (150 chars in 5123ms, 200 deltas)
   ```
   平均每个 delta 只有 0.75 字符，说明 LLM 输出非常碎片化。

### 性能指标

日志会输出以下性能指标：
- `charsPerSecond`: 字符/秒
- `avgDelta`: 平均 delta 大小
- `totalDeltas`: 总 delta 数量
- `duration`: 总耗时

## 禁用日志

```typescript
import { disableDebug } from './debug-logs/streaming-hooks.js';

disableDebug();
```

或在命令行：
```bash
DEBUG_STREAM=off npm run tui
```

## 清理日志

日志文件可以安全删除：
```bash
rm -rf debug-logs/
```

新的运行会自动创建新的日志文件。
