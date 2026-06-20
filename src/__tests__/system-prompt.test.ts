// ============================================================
// Tests: System Prompt Builder
// ============================================================

import { describe, it, expect } from "vitest";
import { buildSystemPrompt, rebuildDynamicSections } from "../system-prompt.js";

describe("buildSystemPrompt", () => {
  it("should return a non-empty string", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/test",
      tools: [],
    });
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe("string");
  });

  it("should include workspace root", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/home/user/my-project",
      tools: [],
    });
    expect(prompt).toContain("/home/user/my-project");
  });

  it("should include tool descriptions when tools are provided", () => {
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
      checkPermissions: async () => ({ allowed: true } as const),
    };

    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/test",
      tools: [mockTool],
    });
    expect(prompt).toContain("read");
  });

  it("should include CLAUDE.md content when provided", () => {
    const claudeMd = "# Project Rules\n- Always use TypeScript\n- No any types";
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/test",
      tools: [],
      claudeMdContent: claudeMd,
    });
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain("TypeScript");
  });

  it("should contain the dynamic boundary marker", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/test",
      tools: [],
    });
    expect(prompt).toContain("DYNAMIC BOUNDARY");
  });
});

describe("rebuildDynamicSections", () => {
  it("should preserve static sections", () => {
    const original = buildSystemPrompt({
      workspaceRoot: "/tmp/test",
      tools: [],
    });

    const rebuilt = rebuildDynamicSections(original, {
      claudeMdContent: "# Updated rules\n- Use tabs",
    });

    // Should still contain key static content
    expect(rebuilt).toContain("coding assistant");
    // Should contain the updated content
    expect(rebuilt).toContain("Use tabs");
  });

  it("should include dynamic boundary", () => {
    const original = buildSystemPrompt({
      workspaceRoot: "/tmp/test",
      tools: [],
    });

    const rebuilt = rebuildDynamicSections(original, {});

    expect(rebuilt).toContain("DYNAMIC BOUNDARY");
  });
});
