// Regression tests for official tool-NAME parity (src/tools/utils/official-names.ts).
//
// The defect these lock down: every tool lookup was `tools.find(t => t.name ===
// name)`, so a model using official Claude Code names — `Read`, `WebFetch`,
// `TodoWrite`, `TaskOutput` — could not run a single tool. The sibling
// official-params.test.ts covers the PARAMETER names; this file covers the tool
// NAMES, which are checked in seven independent places.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isToolHiddenByPolicy, permissionRuleMatches } from "../permission-policy.js";
import { resolveSubagentTools } from "../subagents.js";
import { callIsConcurrencySafe, executeSingleTool } from "../tool-executor.js";
import { buildTool } from "../tools/registry.js";
import { canonicalToolKey, resolveTool } from "../tools/utils/official-names.js";
import type { Tool, ToolContext } from "../types.js";

const ctx = {
  cwd: ".",
  workspaceRoot: ".",
  allowedDirectories: ["."],
  permissionMode: "default",
  sessionId: "official-names-test",
} as unknown as ToolContext;

const allow = async () => true;

/** Minimal echo tool, registered under `name`. */
function echoTool(name: string) {
  return buildTool({
    name,
    description: `echo (${name})`,
    schema: z.strictObject({ value: z.string().optional() }),
    promptDescription: "echo",
    isReadOnly: true,
    isConcurrencySafe: () => true,
    async call(input: Record<string, unknown>) {
      return { content: `ran:${name}:${input.value ?? ""}` };
    },
    async checkPermissions() {
      return { allowed: true };
    },
  });
}

async function call(toolName: string, args: unknown) {
  return executeSingleTool(
    { id: "c1", function: { name: toolName, arguments: JSON.stringify(args) } } as never,
    [echoTool("echo")] as never,
    ctx,
    allow,
  );
}

/** The raw tool result, without the `[12ms]` duration footer `formatted` adds. */
function contentOf(r: { result?: { content: string } }): string {
  if (!r.result) throw new Error("tool returned no result");
  return r.result.content;
}

describe("canonicalToolKey", () => {
  it("camelCase official names become this project's snake_case names", () => {
    expect(canonicalToolKey("Read")).toBe("read");
    expect(canonicalToolKey("Bash")).toBe("bash");
    expect(canonicalToolKey("Grep")).toBe("grep");
    expect(canonicalToolKey("AskUserQuestion")).toBe("ask_user_question");
    expect(canonicalToolKey("EnterPlanMode")).toBe("enter_plan_mode");
    expect(canonicalToolKey("NotebookEdit")).toBe("notebook_edit");
    expect(canonicalToolKey("ExitWorktree")).toBe("exit_worktree");
  });

  it("resolves word-level renames the derivation cannot produce", () => {
    expect(canonicalToolKey("TodoWrite")).toBe("todo");
    expect(canonicalToolKey("TaskOutput")).toBe("job_output");
    expect(canonicalToolKey("ListMcpResources")).toBe("mcp_list_resources");
    expect(canonicalToolKey("ReadMcpResourceDir")).toBe("mcp_read_resource");
  });

  it("accepts the concatenated lowercase form used by permission rules", () => {
    // Nothing distinguishes `webfetch` -> `web_fetch` from `webfetch` ->
    // `webfetch` without knowing the words, so the table must be keyed on the
    // concatenated form too. Permission rules are usually written this way.
    expect(canonicalToolKey("webfetch")).toBe("web_fetch");
    expect(canonicalToolKey("websearch")).toBe("web_search");
    expect(canonicalToolKey("todowrite")).toBe("todo");
    expect(canonicalToolKey("multiedit")).toBe("multi_edit");
  });

  it("leaves this project's own names untouched (self-consistency)", () => {
    for (const n of ["read", "web_fetch", "todo", "job_output", "mcp_read_resource"]) {
      expect(canonicalToolKey(n)).toBe(n);
    }
  });

  it("tolerates whitespace and separators", () => {
    expect(canonicalToolKey("  WebFetch  ")).toBe("web_fetch");
    expect(canonicalToolKey("web fetch")).toBe("web_fetch");
  });
});

describe("resolveTool", () => {
  const tools = [echoTool("web_fetch"), echoTool("todo"), echoTool("read")];

  it("prefers an exact match", () => {
    expect(resolveTool("web_fetch", tools)?.name).toBe("web_fetch");
  });

  it("resolves official spellings", () => {
    expect(resolveTool("WebFetch", tools)?.name).toBe("web_fetch");
    expect(resolveTool("TodoWrite", tools)?.name).toBe("todo");
    expect(resolveTool("Read", tools)?.name).toBe("read");
  });

  it("returns undefined for a genuinely unknown name", () => {
    // Never silently substitute a different tool — callers keep reporting
    // "Unknown tool: X".
    expect(resolveTool("TotallyMadeUpTool", tools)).toBeUndefined();
  });
});

describe("execution accepts official tool names", () => {
  it("runs a tool addressed by its official name", async () => {
    const result = await call("Echo", { value: "hi" });
    expect(result.isError).toBeFalsy();
    expect(contentOf(result)).toBe("ran:echo:hi");
  });

  it("still runs our own spelling", async () => {
    const result = await call("echo", { value: "hi" });
    expect(result.isError).toBeFalsy();
  });

  it("concurrency partitioning resolves official names too", () => {
    // callIsConcurrencySafe had its own exact-match lookup; if it stayed
    // exact-match, an official-spelled call would be forced to run serially.
    const safe = echoTool("web_fetch");
    expect(
      callIsConcurrencySafe(
        { id: "x", function: { name: "WebFetch", arguments: "{}" } } as never,
        [safe] as never,
      ),
    ).toBe(true);
  });

  it("an unknown name is still an error", async () => {
    const result = await call("NoSuchTool", {});
    expect(result.isError).toBe(true);
  });
});

describe("subagent tool sets accept official names", () => {
  const available = [echoTool("read"), echoTool("grep"), echoTool("todo"), echoTool("job_output")];
  const names = (list: string[]) =>
    resolveSubagentTools(
      { name: "t", description: "d", toolNames: list } as never,
      available as never,
    ).map((t: Tool) => t.name);

  it("resolves the official frontmatter spellings", () => {
    expect(names(["Read", "Grep"])).toEqual(["read", "grep"]);
    expect(names(["TodoWrite"])).toEqual(["todo"]);
    expect(names(["TaskOutput"])).toEqual(["job_output"]);
  });
});

describe("permission rules and execution agree on names", () => {
  // A WebFetch rule scopes on the `url` argument; the resolver reads `input.url`.
  it("a rule written in official form still matches", () => {
    const input = { url: "https://example.com/a" };
    expect(permissionRuleMatches("WebFetch(https://example.com/*)", "web_fetch", input)).toBe(true);
    expect(permissionRuleMatches("WebFetch(https://example.com/*)", "WebFetch", input)).toBe(true);
  });

  it("a deny rule hides the tool it names in official form", () => {
    // Regression guard for the divergence this module removed: rules used to
    // normalize through a private alias table while execution did not, so a
    // rule could match a tool that execution then refused to find.
    const policy = { allow: [], deny: ["WebFetch"], ask: [] };
    expect(isToolHiddenByPolicy(policy, "web_fetch")).toBe(true);
    expect(isToolHiddenByPolicy({ allow: [], deny: ["TodoWrite"], ask: [] }, "todo")).toBe(true);
  });
});
