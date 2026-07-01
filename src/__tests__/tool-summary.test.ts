// ============================================================
// Tests: Tool-result summary — fast-model latency hiding (M36, kernel §9)
// ============================================================

import { describe, expect, it, vi } from "vitest";
import {
  buildSummaryPrompt,
  buildToolBatchDigest,
  DEFAULT_SUMMARY_MIN_BYTES,
  renderSummaryAttachment,
  shouldSummarizeBatch,
  startToolSummary,
} from "../tool-summary.js";
import type { ToolExecutionResult } from "../types.js";

function result(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    toolName: "grep",
    formatted: "x".repeat(50),
    ...overrides,
  };
}

describe("buildToolBatchDigest", () => {
  it("sums model-facing bytes and truncates snippets", () => {
    const big = result({ toolName: "read", formatted: "y".repeat(5000) });
    const digest = buildToolBatchDigest([big]);
    expect(digest.entries).toHaveLength(1);
    expect(digest.totalBytes).toBe(5000);
    // Snippet is capped and ellipsized.
    expect(digest.entries[0]!.snippet.length).toBeLessThan(5000);
    expect(digest.entries[0]!.snippet.endsWith("…")).toBe(true);
  });

  it("prefers modelContent over formatted (the model-facing copy)", () => {
    const r = result({ formatted: "FULL".repeat(100), modelContent: "small" });
    const digest = buildToolBatchDigest([r]);
    expect(digest.entries[0]!.bytes).toBe(5);
    expect(digest.entries[0]!.snippet).toBe("small");
  });

  it("flags errors", () => {
    const digest = buildToolBatchDigest([result({ isError: true })]);
    expect(digest.entries[0]!.isError).toBe(true);
  });
});

describe("shouldSummarizeBatch", () => {
  it("skips small batches below the gate", () => {
    const digest = buildToolBatchDigest([result({ formatted: "tiny" })]);
    expect(shouldSummarizeBatch(digest)).toBe(false);
  });

  it("summarizes batches at/above the gate", () => {
    const digest = buildToolBatchDigest([
      result({ formatted: "z".repeat(DEFAULT_SUMMARY_MIN_BYTES) }),
    ]);
    expect(shouldSummarizeBatch(digest)).toBe(true);
  });

  it("skips an empty batch", () => {
    expect(shouldSummarizeBatch(buildToolBatchDigest([]))).toBe(false);
  });
});

describe("buildSummaryPrompt", () => {
  it("includes tool names, error tags, and byte sizes", () => {
    const digest = buildToolBatchDigest([
      result({ toolName: "grep", formatted: "found 3 matches" }),
      result({ toolName: "bash", isError: true, formatted: "command failed" }),
    ]);
    const prompt = buildSummaryPrompt(digest);
    expect(prompt).toContain("grep");
    expect(prompt).toContain("bash");
    expect(prompt).toContain("ERROR");
    expect(prompt).toContain("ok");
  });
});

describe("renderSummaryAttachment", () => {
  it("wraps a summary in a system-reminder", () => {
    const out = renderSummaryAttachment("Found the config in 3 files.");
    expect(out).toContain("<system-reminder>");
    expect(out).toContain("Found the config in 3 files.");
    expect(out).toContain("</system-reminder>");
  });

  it("returns null for empty/whitespace summaries", () => {
    expect(renderSummaryAttachment(null)).toBeNull();
    expect(renderSummaryAttachment("   ")).toBeNull();
  });
});

describe("startToolSummary", () => {
  it("returns null immediately for a sub-gate batch (no model call)", () => {
    const summarize = vi.fn();
    const out = startToolSummary({ results: [result({ formatted: "tiny" })], summarize });
    expect(out).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("calls the summarizer and resolves to a rendered attachment", async () => {
    const summarize = vi.fn().mockResolvedValue("Digest: grep found 3 hits.");
    const out = startToolSummary({
      results: [result({ formatted: "Q".repeat(3000) })],
      summarize,
    });
    expect(out).not.toBeNull();
    const attachment = await out!;
    expect(summarize).toHaveBeenCalledOnce();
    expect(attachment).toContain("Digest: grep found 3 hits.");
    expect(attachment).toContain("<system-reminder>");
  });

  it("resolves to null when the summarizer throws (never blocks the loop)", async () => {
    const summarize = vi.fn().mockRejectedValue(new Error("fast model down"));
    const out = startToolSummary({
      results: [result({ formatted: "Q".repeat(3000) })],
      summarize,
    });
    expect(await out!).toBeNull();
  });

  it("resolves to null when the summarizer yields nothing", async () => {
    const summarize = vi.fn().mockResolvedValue(null);
    const out = startToolSummary({
      results: [result({ formatted: "Q".repeat(3000) })],
      summarize,
    });
    expect(await out!).toBeNull();
  });
});
