// ============================================================
// Permission-scoped tool exposure
// ------------------------------------------------------------
// Deny rules used to gate EXECUTION only. The denied tool stayed in
// the request payload with its full schema, so the model kept seeing
// `bash`'s JSON Schema and kept proposing calls that were then refused
// — burning turns on calls that could never succeed. The tool set is
// now filtered before it reaches the provider, and the AVAILABLE TOOLS
// index in the system prompt is filtered to match.
//
// The subtle part, and the reason this file exists: only a BARE deny
// rule removes a tool. `Bash(rm *)` denies one shape of call, so bash
// must stay visible — hiding it would also take away `git status`,
// which the user never denied.
// ============================================================

import { describe, expect, it } from "vitest";
import { isToolHiddenByPolicy, type PermissionPolicy } from "../permission-policy.js";
import { buildSystemPrompt, renderSystemPrompt } from "../system-prompt.js";
import { visibleTools } from "../tools/registry.js";
import type { Tool } from "../types.js";

const policy = (deny: string[]): PermissionPolicy => ({ allow: [], deny, ask: [] });

/** Minimal Tool stub — only the fields visibleTools reads. */
const stub = (name: string, description = `${name} tool`): Tool =>
  ({
    name,
    description,
    promptDescription: description,
    inputSchema: { type: "object", properties: {}, required: [] },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async () => ({ content: "" }),
    checkPermissions: async () => ({ allowed: true as const }),
    formatResult: (r: { content: string }) => r.content,
  }) as unknown as Tool;

const TOOLS = [stub("bash"), stub("read"), stub("write")];

describe("isToolHiddenByPolicy", () => {
  it("hides a tool denied by bare name", () => {
    expect(isToolHiddenByPolicy(policy(["Bash"]), "bash")).toBe(true);
    expect(isToolHiddenByPolicy(policy(["write"]), "write")).toBe(true);
  });

  it("case-insensitively, matching official-style capitalized rules", () => {
    // Registry names are lowercase; settings.json conventionally writes
    // "Bash" / "Edit". A case-sensitive compare would make every official
    // rule a silent no-op.
    expect(isToolHiddenByPolicy(policy(["Bash"]), "bash")).toBe(true);
    expect(isToolHiddenByPolicy(policy(["bash"]), "BASH")).toBe(true);
  });

  it("KEEPS a tool when the deny rule is parameterized", () => {
    // The whole point: `Bash(rm *)` denies one call shape, not the tool.
    expect(isToolHiddenByPolicy(policy(["Bash(rm *)"]), "bash")).toBe(false);
    expect(isToolHiddenByPolicy(policy(["Bash(npm run:*)"]), "bash")).toBe(false);
  });

  it("hides on an explicit catch-all for that tool", () => {
    expect(isToolHiddenByPolicy(policy(["Bash(*)"]), "bash")).toBe(true);
    expect(isToolHiddenByPolicy(policy(["*"]), "bash")).toBe(true);
  });

  it("ignores ask and allow rules — those are not revocations", () => {
    expect(isToolHiddenByPolicy({ allow: [], deny: [], ask: ["Bash"] }, "bash")).toBe(false);
    expect(isToolHiddenByPolicy({ allow: ["Bash"], deny: [], ask: [] }, "bash")).toBe(false);
  });

  it("does not cross-match sibling tools by prefix", () => {
    expect(isToolHiddenByPolicy(policy(["Read"]), "read")).toBe(true);
    expect(isToolHiddenByPolicy(policy(["Read"]), "read_file")).toBe(false);
  });
});

describe("visibleTools", () => {
  it("returns the enabled set unchanged when no deny rules exist", () => {
    expect(visibleTools(TOOLS, policy([])).map((t) => t.name)).toEqual(["bash", "read", "write"]);
    expect(visibleTools(TOOLS, undefined).map((t) => t.name)).toEqual(["bash", "read", "write"]);
  });

  it("drops bare-denied tools and keeps the rest", () => {
    expect(visibleTools(TOOLS, policy(["Bash"])).map((t) => t.name)).toEqual(["read", "write"]);
  });

  it("keeps a tool whose deny rule is parameterized", () => {
    expect(visibleTools(TOOLS, policy(["Bash(rm *)"])).map((t) => t.name)).toEqual([
      "bash",
      "read",
      "write",
    ]);
  });

  it("still drops disabled tools regardless of policy", () => {
    const off = { ...stub("bash"), isEnabled: () => false };
    expect(visibleTools([off, stub("read")], policy([])).map((t) => t.name)).toEqual(["read"]);
  });
});

describe("system prompt AVAILABLE TOOLS stays in sync with the payload", () => {
  const promptWith = (pol?: PermissionPolicy) =>
    renderSystemPrompt(
      buildSystemPrompt({
        workspaceRoot: "/tmp/ws",
        tools: TOOLS,
        claudeMdContent: "",
        permissionPolicy: pol,
      }),
    );

  it("omits a bare-denied tool from the index", () => {
    const prompt = promptWith(policy(["Bash"]));
    expect(prompt).toContain("read — read tool");
    expect(prompt).not.toContain("bash — bash tool");
  });

  it("still lists a tool whose deny rule is parameterized", () => {
    expect(promptWith(policy(["Bash(rm *)"]))).toContain("bash — bash tool");
  });

  it("lists everything when the policy is empty", () => {
    expect(promptWith(policy([]))).toContain("bash — bash tool");
  });
});
