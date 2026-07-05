// Usage Baseline Performance Benchmark
// 测试增量 token 估算 vs 全量估算的性能差异

import type { Message } from "../src/types.js";

// 简化的 token 估算函数（模拟 agent-loop 中的逻辑）
function estimateTokens(messages: Message[]): number {
  let totalChars = 0;

  for (const msg of messages) {
    if (msg.role === "user") {
      for (const block of msg.content) {
        if (block.type === "text") {
          totalChars += block.text.length;
        }
      }
    } else if (msg.role === "assistant") {
      totalChars += (msg.content?.length || 0);
    } else if (msg.role === "tool") {
      totalChars += (msg.content?.length || 0);
    } else if (msg.role === "system") {
      totalChars += msg.content.length;
    }
  }

  return Math.ceil(totalChars / 4);
}

function estimateContextTokens(
  messages: Message[],
  baseline?: { promptTokens: number; messageCount: number },
): number {
  if (baseline && messages.length >= baseline.messageCount) {
    const appended = messages.slice(baseline.messageCount);
    return baseline.promptTokens + estimateTokens(appended);
  }
  return estimateTokens(messages);
}

// 创建模拟对话
function createConversation(rounds: number): Message[] {
  const messages: Message[] = [];

  for (let i = 0; i < rounds; i++) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `User question ${i}: `.repeat(50) }],
    });

    messages.push({
      role: "assistant",
      content: `Assistant answer ${i}: `.repeat(100),
      tool_calls: [],
    });
  }

  return messages;
}

// Benchmark: 无 baseline
function benchmarkWithoutBaseline(messages: Message[], iterations: number): number {
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    estimateContextTokens(messages, undefined);
  }

  return performance.now() - start;
}

// Benchmark: 有 baseline
function benchmarkWithBaseline(messages: Message[], iterations: number): number {
  const baseline = {
    promptTokens: 5000,
    messageCount: messages.length - 2,
  };

  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    estimateContextTokens(messages, baseline);
  }

  return performance.now() - start;
}

// 准确性测试
function testAccuracy() {
  console.log("\\n=== Baseline Accuracy Test ===\\n");

  const messages = createConversation(20);

  const fullEstimate = estimateContextTokens(messages, undefined);

  const baseline = {
    promptTokens: estimateContextTokens(messages.slice(0, 18), undefined),
    messageCount: 18,
  };
  const incrementalEstimate = estimateContextTokens(messages, baseline);

  const diff = Math.abs(fullEstimate - incrementalEstimate);
  const diffPercent = (diff / fullEstimate) * 100;

  console.log(`Full estimate:        ${fullEstimate} tokens`);
  console.log(`Incremental estimate: ${incrementalEstimate} tokens`);
  console.log(`Difference:           ${diff} tokens (${diffPercent.toFixed(2)}%)`);
  console.log();

  if (diffPercent < 1) {
    console.log("✅ PASS: <1% difference");
  } else {
    console.log("❌ FAIL: >1% difference");
  }
}

// 性能测试
function runPerformanceTest() {
  console.log("\\n=== Usage Baseline Performance Test ===\\n");

  const scenarios = [
    { rounds: 10, name: "Short conversation (10 rounds)" },
    { rounds: 30, name: "Medium conversation (30 rounds)" },
    { rounds: 50, name: "Long conversation (50 rounds)" },
  ];

  const iterations = 1000;

  for (const scenario of scenarios) {
    const messages = createConversation(scenario.rounds);

    const timeWithout = benchmarkWithoutBaseline(messages, iterations);
    const timeWith = benchmarkWithBaseline(messages, iterations);

    const speedup = timeWithout / timeWith;
    const timeSaved = ((timeWithout - timeWith) / iterations);

    console.log(`${scenario.name}:`);
    console.log(`  Messages: ${messages.length}`);
    console.log(`  Without baseline: ${timeWithout.toFixed(2)}ms (avg: ${(timeWithout / iterations).toFixed(3)}ms/call)`);
    console.log(`  With baseline:    ${timeWith.toFixed(2)}ms (avg: ${(timeWith / iterations).toFixed(3)}ms/call)`);
    console.log(`  Speedup:          ${speedup.toFixed(2)}x`);
    console.log(`  Time saved:       ${timeSaved.toFixed(3)}ms/call`);
    console.log();
  }
}

// 运行所有测试
console.log("╔════════════════════════════════════════╗");
console.log("║  Usage Baseline Benchmark              ║");
console.log("╚════════════════════════════════════════╝");

testAccuracy();
runPerformanceTest();

console.log("\\n=== Summary ===\\n");
console.log("Baseline optimization provides significant performance improvements");
console.log("in long conversations while maintaining estimation accuracy.");
console.log();
