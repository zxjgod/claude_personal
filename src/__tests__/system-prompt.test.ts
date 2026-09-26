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
import type { Tool } from "../types.js";

function mkTool(
  name: string,
  description: string,
  promptDescription = `full docs for ${name}`,
  enabled = true,
): Tool {
  return {
    name,
    description,
    promptDescription,
    inputSchema: { type: "object", properties: {}, required: [] },
    isEnabled: () => enabled,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async () => ({ content: "" }),
    formatResult: (r: any) => r.content,
    checkPermissions: async () => ({ allowed: true }) as const,
  } as unknown as Tool;
}

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
    // Top10 #10: the section is a one-line INDEX using the short description;
    // the full promptDescription lives only in the API tools argument.
    expect(prompt).toContain("read — Read file contents");
    expect(prompt).not.toContain("Use this to read files");
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

// ============================================================
// Tool descriptions section (Top10 #10)
// ============================================================
// The section is a one-line index (name — short description), memoized under
// a tool-set fingerprint: the old code dumped every tool's full
// promptDescription (~3.6k duplicate tokens per request) and rebuilt the
// section raw every turn, so an MCP reconnect reordering the registry busted
// the whole cacheable prefix.
// ============================================================

describe("tool descriptions section (Top10 #10)", () => {
  it("lists one short line per enabled tool, never the full promptDescription", () => {
    const tools = [
      mkTool("read", "Read file contents", "Use this to read files. Parameters: filePath ..."),
      mkTool("bash", "Execute a shell command", "Runs a command in the shell with timeout ..."),
    ];
    const prompt = renderSystemPrompt(buildSystemPrompt({ workspaceRoot: "/t", tools }));
    expect(prompt).toContain("read — Read file contents");
    expect(prompt).toContain("bash — Execute a shell command");
    expect(prompt).not.toContain("Use this to read files");
    expect(prompt).not.toContain("Runs a command in the shell");
  });

  it("excludes disabled tools", () => {
    const tools = [
      mkTool("read", "Read file contents"),
      mkTool("off_tool", "Disabled", "d", false),
    ];
    const prompt = renderSystemPrompt(buildSystemPrompt({ workspaceRoot: "/t", tools }));
    expect(prompt).toContain("read —");
    expect(prompt).not.toContain("off_tool");
  });

  it("registry ORDER does not change the static prefix bytes (MCP reorder stability)", () => {
    const a = mkTool("aaa", "A tool");
    const b = mkTool("bbb", "B tool");
    const p1 = buildSystemPrompt({ workspaceRoot: "/t", tools: [a, b] });
    const p2 = buildSystemPrompt({ workspaceRoot: "/t", tools: [b, a] });
    expect(staticPrefixOf(p1)).toBe(staticPrefixOf(p2));
    // Sorted output: aaa before bbb regardless of input order.
    const section = p2.find((block) => block.includes("AVAILABLE TOOLS"))!;
    expect(section.indexOf("aaa")).toBeLessThan(section.indexOf("bbb"));
  });

  it("tool-set change alters the prefix; changing back restores the original bytes", () => {
    const a = mkTool("aaa", "A tool");
    const b = mkTool("bbb", "B tool");
    const first = staticPrefixOf(buildSystemPrompt({ workspaceRoot: "/t", tools: [a] }));
    const changed = staticPrefixOf(buildSystemPrompt({ workspaceRoot: "/t", tools: [a, b] }));
    expect(changed).not.toBe(first);
    // Back to the original set: stale tools: memo key evicted, section
    // recomputed deterministically → byte-identical to the first build.
    const back = staticPrefixOf(buildSystemPrompt({ workspaceRoot: "/t", tools: [a] }));
    expect(back).toBe(first);
  });

  it("same tool set across builds hits the memo (no recompute drift)", () => {
    const tools = [mkTool("aaa", "A tool"), mkTool("bbb", "B tool")];
    const x = staticPrefixOf(buildSystemPrompt({ workspaceRoot: "/t", tools }));
    const y = staticPrefixOf(buildSystemPrompt({ workspaceRoot: "/t", tools }));
    expect(x).toBe(y);
  });
});

function staticPrefixOf(blocks: string[]): string {
  return blocks.slice(0, boundaryIndex(blocks)).join("\n");
}

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

// ============================================================
// Top10 follow-up A7③: dynamic blocks ordered stable → volatile
// ============================================================

describe("dynamic block stability ordering (A7③)", () => {
  it("puts CLAUDE.md/env BEFORE the date and git (volatile last)", () => {
    const blocks = buildSystemPrompt({
      workspaceRoot: "/proj",
      tools: [],
      claudeMdContent: "RULES-MARKER",
      gitStatus: "modified: x.ts",
    });
    const dynamic = blocks.slice(boundaryIndex(blocks)).join("\n");
    const idxClaude = dynamic.indexOf("RULES-MARKER");
    const idxDate = dynamic.indexOf("Today's date is");
    const idxGit = dynamic.indexOf("GIT STATUS");
    expect(idxClaude).toBeGreaterThanOrEqual(0);
    expect(idxDate).toBeGreaterThan(idxClaude);
    expect(idxGit).toBeGreaterThan(idxDate);
  });

  it("a date-only change leaves the CLAUDE.md block bytes untouched", () => {
    // Same session inputs → identical prefix + identical CLAUDE.md block;
    // the volatility is confined to the tail (prefix-cache friendly).
    const a = buildSystemPrompt({
      workspaceRoot: "/proj",
      tools: [],
      claudeMdContent: "STABLE-RULES",
    });
    const b = buildSystemPrompt({
      workspaceRoot: "/proj",
      tools: [],
      claudeMdContent: "STABLE-RULES",
    });
    const join = (x: string[]) => x.slice(boundaryIndex(x)).join("\n");
    expect(join(a)).toBe(join(b));
  });
});
