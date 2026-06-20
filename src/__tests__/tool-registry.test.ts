// ============================================================
// Tests: Tool Registry
// ============================================================

import { describe, it, expect } from "vitest";
import { ToolRegistry, createTool } from "../tool-registry.js";
import type { Tool } from "../types.js";

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

  it("should format tools for OpenAI", () => {
    const registry = new ToolRegistry();
    const tool = createTool({
      name: "read",
      description: "Read files",
      promptDescription: "Read a file from disk",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string", description: "Path" } },
        required: ["filePath"],
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "ok" }),
    });
    registry.register(tool);
    const formatted = registry.formatToolsForOpenAI();
    expect(formatted).toHaveLength(1);
    expect(formatted[0].type).toBe("function");
    expect(formatted[0].function.name).toBe("read");
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
