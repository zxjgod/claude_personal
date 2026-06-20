// ============================================================
// Tests: Permission System
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { checkPermission } from "../permissions.js";
import { createTool } from "../tool-registry.js";
import type { Tool, ToolContext } from "../types.js";

const WORKSPACE = "/home/user/project";

function makeContext(
  mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" = "default",
): ToolContext {
  return {
    workspaceRoot: WORKSPACE,
    sessionId: "test",
    permissionMode: mode,
  };
}

async function alwaysAllow(): Promise<boolean> {
  return true;
}
async function alwaysDeny(): Promise<boolean> {
  return false;
}

describe("checkPermission", () => {
  it("should allow read-only tools", async () => {
    const tool = createTool({
      name: "read",
      description: "Read",
      promptDescription: "Read files",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      {},
      makeContext(),
      { askUser: alwaysDeny },
    );
    expect(result.allowed).toBe(true);
  });

  it("should deny destructive tools in plan mode", async () => {
    const tool = createTool({
      name: "write",
      description: "Write",
      promptDescription: "Write files",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: false,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      {},
      makeContext("plan"),
      { askUser: alwaysAllow },
    );
    expect(result.allowed).toBe(false);
  });

  it("should allow everything in bypass mode", async () => {
    const tool = createTool({
      name: "bash",
      description: "Bash",
      promptDescription: "Run commands",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      { command: "rm -rf /" },
      makeContext("bypassPermissions"),
      { askUser: alwaysDeny },
    );
    expect(result.allowed).toBe(true);
  });

  it("should block .env files", async () => {
    const tool = createTool({
      name: "read",
      description: "Read",
      promptDescription: "Read",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      { filePath: "/home/user/project/.env" },
      makeContext(),
      { askUser: alwaysAllow },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked");
  });

  it("should block .ssh paths", async () => {
    const tool = createTool({
      name: "read",
      description: "Read",
      promptDescription: "Read",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      { filePath: "/home/user/.ssh/id_rsa" },
      makeContext(),
      { askUser: alwaysAllow },
    );
    expect(result.allowed).toBe(false);
  });

  it("should auto-approve edits in acceptEdits mode", async () => {
    const tool = createTool({
      name: "edit",
      description: "Edit",
      promptDescription: "Edit files",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: false,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      { filePath: "/home/user/project/src/file.ts", old_string: "a", new_string: "b" },
      makeContext("acceptEdits"),
      { askUser: alwaysDeny },
    );
    expect(result.allowed).toBe(true);
  });

  it("should ask user for dangerous bash command", async () => {
    const tool = createTool({
      name: "bash",
      description: "Bash",
      promptDescription: "Run commands",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const askUser = vi.fn().mockResolvedValue(false);
    const result = await checkPermission(
      tool,
      { command: "rm -rf /tmp/build" },
      makeContext(),
      { askUser },
    );
    expect(askUser).toHaveBeenCalled();
    expect(result.allowed).toBe(false);
  });

  it("should allow tools that explicitly do not require approval", async () => {
    const tool = createTool({
      name: "task",
      description: "Task",
      promptDescription: "Run a sub-agent",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      requiresApproval: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const askUser = vi.fn().mockResolvedValue(false);
    const result = await checkPermission(tool, {}, makeContext(), { askUser });
    expect(result.allowed).toBe(true);
    expect(askUser).not.toHaveBeenCalled();
  });

  it("should still prompt for ordinary destructive tools", async () => {
    const tool = createTool({
      name: "write",
      description: "Write",
      promptDescription: "Write files",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: false,
      call: async () => ({ content: "" }),
    });

    const askUser = vi.fn().mockResolvedValue(false);
    const result = await checkPermission(tool, {}, makeContext(), { askUser });
    expect(result.allowed).toBe(false);
    expect(askUser).toHaveBeenCalled();
  });
});
