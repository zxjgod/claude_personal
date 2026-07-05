// ============================================================
// Tests: MCP tool first-call approval (16.10)
// ============================================================
// MCP servers can run arbitrary external actions, so a tool's first call in a
// session should prompt the user (not auto-approve). These tests exercise the
// gating logic mirrored from mcp.ts's checkPermissions: first call prompts
// unless the tool is already confirmed this session; an approved choice is
// sticky; bypassPermissions skips the prompt.
// ============================================================

import { describe, expect, it } from "vitest";
import { createTool } from "../tools/registry.js";
import type { ToolContext } from "../types.js";

function mcpLikeTool(name: string, confirmed: Set<string>) {
  // Mirror the gating logic added in mcp.ts: first call prompts unless the
  // tool is already in the confirmed set; an "always"/yes choice sticks.
  return createTool({
    name,
    description: name,
    promptDescription: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    isReadOnly: false,
    requiresApproval: true,
    isConcurrencySafe: true,
    call: async () => ({ content: "ok" }),
    checkPermissions: async (input, context) => {
      if (context.permissionMode === "bypassPermissions") return { allowed: true };
      if (confirmed.has(name)) return { allowed: true };
      const allowed = context.askUser
        ? await context.askUser({ name } as any, input, "first call")
        : true;
      if (allowed) {
        confirmed.add(name);
        return { allowed: true };
      }
      return { allowed: false, reason: `MCP tool "${name}" not approved by user` };
    },
  });
}

function ctx(mode: ToolContext["permissionMode"], askUser?: () => Promise<boolean>): ToolContext {
  return {
    workspaceRoot: "/tmp",
    sessionId: "s",
    permissionMode: mode,
    askUser: askUser as any,
  };
}

describe("MCP tool first-call approval (16.10)", () => {
  it("prompts on the first call, then is sticky for the session", async () => {
    const confirmed = new Set<string>();
    const tool = mcpLikeTool("mcp__srv__doit", confirmed);
    let calls = 0;
    const askUser = async () => {
      calls++;
      return true;
    };

    expect((await tool.checkPermissions({}, ctx("default", askUser))).allowed).toBe(true);
    expect(calls).toBe(1); // prompted once
    expect(confirmed.has("mcp__srv__doit")).toBe(true);

    // Second call must NOT prompt — sticky.
    expect((await tool.checkPermissions({}, ctx("default", askUser))).allowed).toBe(true);
    expect(calls).toBe(1);
  });

  it("refuses when the user denies the first call", async () => {
    const confirmed = new Set<string>();
    const tool = mcpLikeTool("mcp__srv__danger", confirmed);
    const askUser = async () => false;
    const r = await tool.checkPermissions({}, ctx("default", askUser));
    expect(r.allowed).toBe(false);
    if (r.allowed) throw new Error("expected denial");
    expect(r.reason).toContain("not approved");
    expect(confirmed.has("mcp__srv__danger")).toBe(false);
  });

  it("does not prompt in bypassPermissions mode", async () => {
    const confirmed = new Set<string>();
    const tool = mcpLikeTool("mcp__srv__fast", confirmed);
    let calls = 0;
    const askUser = async () => {
      calls++;
      return true;
    };
    expect((await tool.checkPermissions({}, ctx("bypassPermissions", askUser))).allowed).toBe(true);
    expect(calls).toBe(0);
  });
});
