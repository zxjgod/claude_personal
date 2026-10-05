// ============================================================
// Tests: MCP tool per-call approval (16.10, hardened)
// ============================================================
// MCP servers can run arbitrary external actions, so every call prompts the
// user unless they chose "always" (which lives in the prompter's alwaysAllow
// set, keyed with the tool-definition fingerprint). A one-time "yes" approves
// exactly one invocation — it must NOT silently authorize later calls with
// different arguments. bypassPermissions skips the prompt.
// ============================================================

import { describe, expect, it } from "vitest";
import { createTool } from "../tools/registry.js";
import type { ToolContext } from "../types.js";

function mcpLikeTool(name: string) {
  // Mirror the gating logic in mcp/index.ts: every call prompts; "yes"
  // approves only this invocation; no manager-side confirmation cache.
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
      const allowed = context.askUser
        ? await context.askUser({ name } as any, input, "MCP server action")
        : false;
      if (allowed) return { allowed: true };
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

describe("MCP tool per-call approval (16.10)", () => {
  it("a one-time yes approves exactly one call — the next call prompts again", async () => {
    const tool = mcpLikeTool("mcp__srv__doit");
    let calls = 0;
    const askUser = async () => {
      calls++;
      return true;
    };

    expect((await tool.checkPermissions({}, ctx("default", askUser))).allowed).toBe(true);
    expect(calls).toBe(1);

    // Second call MUST prompt again — no session-wide spread from a plain yes.
    expect((await tool.checkPermissions({}, ctx("default", askUser))).allowed).toBe(true);
    expect(calls).toBe(2);
  });

  it("refuses when the user denies", async () => {
    const tool = mcpLikeTool("mcp__srv__danger");
    const askUser = async () => false;
    const r = await tool.checkPermissions({}, ctx("default", askUser));
    expect(r.allowed).toBe(false);
    if (r.allowed) throw new Error("expected denial");
    expect(r.reason).toContain("not approved");
  });

  it("does not prompt in bypassPermissions mode", async () => {
    const tool = mcpLikeTool("mcp__srv__fast");
    let calls = 0;
    const askUser = async () => {
      calls++;
      return true;
    };
    expect((await tool.checkPermissions({}, ctx("bypassPermissions", askUser))).allowed).toBe(true);
    expect(calls).toBe(0);
  });
});
