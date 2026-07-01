// ============================================================
// Tests: System Prompt Builder (M33 — cache-first design)
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  DANGEROUS_uncachedSystemPromptSection,
  DYNAMIC_BOUNDARY,
  listUncachedSections,
  renderSystemPrompt,
  resetSystemPromptCache,
  systemPromptSection,
} from "../system-prompt.js";

afterEach(() => {
  resetSystemPromptCache();
  delete process.env.CLAUDE_CODE_SIMPLE;
});

/** Index of the boundary block in the returned array. */
function boundaryIndex(blocks: string[]): number {
  return blocks.findIndex((b) => b.includes(DYNAMIC_BOUNDARY));
}

describe("buildSystemPrompt", () => {
  it("returns an ordered array of blocks", () => {
    const blocks = buildSystemPrompt({ workspaceRoot: "/tmp/test", tools: [] });
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(1);
  });

  it("places the dynamic boundary between static and dynamic blocks", () => {
    const blocks = buildSystemPrompt({ workspaceRoot: "/tmp/test", tools: [] });
    const idx = boundaryIndex(blocks);
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(blocks.length - 1);
  });

  it("includes workspace root in a block below the boundary", () => {
    const blocks = buildSystemPrompt({ workspaceRoot: "/home/user/my-project", tools: [] });
    const idx = boundaryIndex(blocks);
    const dynamic = blocks.slice(idx).join("\n");
    expect(dynamic).toContain("/home/user/my-project");
  });

  it("includes tool descriptions when tools are provided", () => {
    const mockTool = {
      name: "read",
      description: "Read file contents",
      promptDescription: "Use this to read files",
      inputSchema: {
        type: "object" as const,
        properties: { filePath: { type: "string", description: "Path to file" } },
        required: ["filePath"],
      },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async () => ({ content: "" }),
      formatResult: (r: any) => r.content,
      checkPermissions: async () => ({ allowed: true }) as const,
    };
    const prompt = renderSystemPrompt(
      buildSystemPrompt({ workspaceRoot: "/tmp/test", tools: [mockTool] }),
    );
    expect(prompt).toContain("read");
  });

  it("includes CLAUDE.md content below the boundary when provided", () => {
    const blocks = buildSystemPrompt({
      workspaceRoot: "/tmp/test",
      tools: [],
      claudeMdContent: "# Project Rules\n- Always use TypeScript",
    });
    const idx = boundaryIndex(blocks);
    const dynamic = blocks.slice(idx).join("\n");
    expect(dynamic).toContain("CLAUDE.md");
    expect(dynamic).toContain("TypeScript");
  });
});

describe("cache discipline (kernel §5)", () => {
  it("keeps the date OUT of the static cacheable prefix", () => {
    const blocks = buildSystemPrompt({ workspaceRoot: "/tmp/test", tools: [] });
    const idx = boundaryIndex(blocks);
    const today = new Date().toISOString().split("T")[0];
    const staticPrefix = blocks.slice(0, idx).join("\n");
    expect(staticPrefix).not.toContain(today);
    // ...but it IS present below the boundary, as a system-reminder.
    const dynamic = blocks.slice(idx).join("\n");
    expect(dynamic).toContain(today);
    expect(dynamic).toContain("<system-reminder>");
  });

  it("keeps cwd/platform OUT of the static prefix", () => {
    const blocks = buildSystemPrompt({ workspaceRoot: "/unique/workspace/path", tools: [] });
    const idx = boundaryIndex(blocks);
    const staticPrefix = blocks.slice(0, idx).join("\n");
    expect(staticPrefix).not.toContain("/unique/workspace/path");
    expect(staticPrefix).not.toContain(process.platform);
  });

  it("produces a byte-identical static prefix across two builds (cacheable)", () => {
    const a = buildSystemPrompt({ workspaceRoot: "/a", tools: [] });
    const b = buildSystemPrompt({ workspaceRoot: "/b", tools: [] });
    const prefixA = a.slice(0, boundaryIndex(a)).join("\n");
    const prefixB = b.slice(0, boundaryIndex(b)).join("\n");
    expect(prefixA).toBe(prefixB);
  });
});

describe("CLAUDE_CODE_SIMPLE escape hatch", () => {
  it("returns a single minimal block", () => {
    process.env.CLAUDE_CODE_SIMPLE = "1";
    const blocks = buildSystemPrompt({ workspaceRoot: "/tmp/test", tools: [] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("coding assistant");
  });
});

describe("memoized section registry (kernel §4)", () => {
  it("computes a memoized section once and reuses it", () => {
    let calls = 0;
    const compute = () => {
      calls++;
      return `value-${calls}`;
    };
    const first = systemPromptSection("test_section", compute);
    const second = systemPromptSection("test_section", compute);
    expect(first).toBe("value-1");
    expect(second).toBe("value-1");
    expect(calls).toBe(1);
  });

  it("recomputes after resetSystemPromptCache", () => {
    let calls = 0;
    const compute = () => `value-${++calls}`;
    systemPromptSection("reset_section", compute);
    resetSystemPromptCache();
    const after = systemPromptSection("reset_section", compute);
    expect(after).toBe("value-2");
    expect(calls).toBe(2);
  });

  it("recomputes a DANGEROUS_ uncached section every call and records its reason", () => {
    let calls = 0;
    const run = () =>
      DANGEROUS_uncachedSystemPromptSection("volatile", () => `v-${++calls}`, "changes every turn");
    expect(run()).toBe("v-1");
    expect(run()).toBe("v-2");
    expect(listUncachedSections().get("volatile")).toBe("changes every turn");
  });

  it("registers the date section as cache-busting with a reason", () => {
    buildSystemPrompt({ workspaceRoot: "/tmp/test", tools: [] });
    expect(listUncachedSections().has("date")).toBe(true);
  });
});
