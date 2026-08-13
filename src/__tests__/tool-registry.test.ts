// ============================================================
// Tests: Tool Registry
// ============================================================

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildTool,
  createTool,
  InputValidationError,
  TOOL_DEFAULTS,
  ToolRegistry,
  toolUseError,
} from "../tools/registry.js";

describe("ToolRegistry", () => {
  it("should register a tool", () => {
    const registry = new ToolRegistry();
    const tool = createTool({
      name: "test",
      description: "A test tool",
      promptDescription: "Use this for testing",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "ok" }),
    });
    registry.register(tool);
    expect(registry.enabledCount).toBe(1);
  });

  it("should throw on duplicate registration", () => {
    const registry = new ToolRegistry();
    const tool = createTool({
      name: "test",
      description: "Test",
      promptDescription: "Test tool",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "ok" }),
    });
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow("already registered");
  });

  it("should get enabled tools only", () => {
    const registry = new ToolRegistry();
    const t1 = createTool({
      name: "t1",
      description: "T1",
      promptDescription: "Tool 1",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "ok" }),
    });
    registry.register(t1);
    expect(registry.getEnabledTools()).toHaveLength(1);
    expect(registry.enabledCount).toBe(1);
  });

  it("should unregister a tool", () => {
    const registry = new ToolRegistry();
    const tool = createTool({
      name: "test",
      description: "Test",
      promptDescription: "Test tool",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "ok" }),
    });
    registry.register(tool);
    expect(registry.enabledCount).toBe(1);
    registry.unregister("test");
    expect(registry.enabledCount).toBe(0);
  });

  it("should return undefined for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.getTool("unknown")).toBeUndefined();
  });

  it("listSources returns registration-order source tags", () => {
    const registry = new ToolRegistry();
    const mk = (name: string) =>
      createTool({
        name,
        description: name,
        promptDescription: name,
        inputSchema: { type: "object", properties: {}, required: [] },
        isReadOnly: true,
        isConcurrencySafe: true,
        call: async () => ({ content: "ok" }),
      });
    registry.register(mk("a"), "core");
    registry.register(mk("b"), "mcp");
    registry.register(mk("c"), "core");
    expect(registry.listSources().map((s) => `${s.source}:${s.tool.name}`)).toEqual([
      "core:a",
      "mcp:b",
      "core:c",
    ]);
    // Defaults to "core" when source is omitted.
    registry.register(mk("d"));
    expect(registry.listSources().at(-1)?.source).toBe("core");
  });

  it("unregister removes the source record too", () => {
    const registry = new ToolRegistry();
    const tool = createTool({
      name: "tmp",
      description: "Tmp",
      promptDescription: "Tmp tool",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "ok" }),
    });
    registry.register(tool, "mcp");
    registry.unregister("tmp");
    expect(registry.listSources()).toHaveLength(0);
  });
});

describe("createTool", () => {
  it("should create a tool with defaults", () => {
    const tool = createTool({
      name: "test",
      description: "Test",
      promptDescription: "Test desc",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: true,
      isConcurrencySafe: false,
      call: async () => ({ content: "result" }),
    });

    expect(tool.name).toBe("test");
    expect(tool.isEnabled()).toBe(true);
    expect(tool.isReadOnly()).toBe(true);
    expect(tool.isConcurrencySafe()).toBe(false);
  });

  it("should format results with default formatter", () => {
    const tool = createTool({
      name: "test",
      description: "Test",
      promptDescription: "Test desc",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "hello" }),
    });

    const formatted = tool.formatResult({ content: "hello" });
    expect(formatted).toContain("hello");
  });

  it("should format errors with default formatter", () => {
    const tool = createTool({
      name: "test",
      description: "Test",
      promptDescription: "Test desc",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const formatted = tool.formatResult({
      content: "",
      error: "Something went wrong",
    });
    expect(formatted).toContain("Error: Something went wrong");
  });
});

// ============================================================
// M28 · buildTool + fail-closed defaults + strict validation
// ============================================================

describe("buildTool (M28)", () => {
  const makeTool = () =>
    buildTool({
      name: "m28_probe",
      description: "probe",
      promptDescription: "probe tool",
      schema: z.strictObject({
        filePath: z.string().describe("abs path"),
        limit: z.number().int().optional(),
      }),
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async (input) => ({ content: input.filePath }),
    });

  it("derives the model-facing JSON Schema from the Zod schema", () => {
    const tool = makeTool();
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.properties.filePath?.type).toBe("string");
    expect(tool.inputSchema.properties.filePath?.description).toBe("abs path");
    // optional → not required
    expect(tool.inputSchema.required).toEqual(["filePath"]);
  });

  it("validateInput accepts well-formed input and returns the typed value", () => {
    const tool = makeTool();
    const out = tool.validateInput?.({ filePath: "/a", limit: 5 });
    expect(out).toEqual({ filePath: "/a", limit: 5 });
  });

  it("validateInput rejects unknown keys (strictObject) with InputValidationError", () => {
    const tool = makeTool();
    expect(() => tool.validateInput?.({ filePath: "/a", evil: 1 })).toThrow(InputValidationError);
  });

  it("validateInput rejects a missing required field", () => {
    const tool = makeTool();
    expect(() => tool.validateInput?.({ limit: 3 })).toThrow(InputValidationError);
  });

  it("validateInput rejects a wrong type", () => {
    const tool = makeTool();
    expect(() => tool.validateInput?.({ filePath: 123 })).toThrow(/Invalid arguments/);
  });

  it("applies fail-closed defaults when capabilities are omitted", () => {
    const tool = buildTool({
      name: "m28_failclosed",
      description: "d",
      promptDescription: "p",
      schema: z.strictObject({ x: z.string() }),
      // isReadOnly / isConcurrencySafe deliberately omitted
      call: async () => ({ content: "ok" }),
    });
    expect(tool.isReadOnly()).toBe(TOOL_DEFAULTS.isReadOnly); // false
    expect(tool.isConcurrencySafe()).toBe(TOOL_DEFAULTS.isConcurrencySafe); // false
    // requiresApproval defaults to "not read-only" → true
    expect(tool.requiresApproval?.()).toBe(true);
    // isDestructive defaults to "not read-only" → true
    expect(tool.isDestructive?.({ x: "y" })).toBe(true);
    expect(tool.interruptBehavior).toBe("kill");
  });

  it("honors explicit capability overrides", () => {
    const tool = makeTool(); // read-only
    expect(tool.isReadOnly()).toBe(true);
    expect(tool.requiresApproval?.()).toBe(false);
    expect(tool.isDestructive?.({ filePath: "/a" })).toBe(false);
  });

  it("getPath surfaces the touched path when provided", () => {
    const tool = buildTool({
      name: "m28_getpath",
      description: "d",
      promptDescription: "p",
      schema: z.strictObject({ filePath: z.string() }),
      getPath: (input) => input.filePath,
      call: async () => ({ content: "ok" }),
    });
    expect(tool.getPath?.({ filePath: "/x/y" })).toBe("/x/y");
  });
});

describe("toolUseError (M28)", () => {
  it("wraps a message in the kernel envelope", () => {
    expect(toolUseError("boom")).toBe("<tool_use_error>boom</tool_use_error>");
  });
});

describe("createTool fail-closed defaults (M28)", () => {
  it("falls back to the safest capabilities when omitted", () => {
    const tool = createTool({
      name: "legacy_failclosed",
      description: "d",
      promptDescription: "p",
      inputSchema: { type: "object", properties: {}, required: [] },
      // isReadOnly / isConcurrencySafe omitted — now optional, fail-closed
      call: async () => ({ content: "ok" }),
    });
    expect(tool.isReadOnly()).toBe(false);
    expect(tool.isConcurrencySafe()).toBe(false);
    expect(tool.requiresApproval?.()).toBe(true);
  });
});
