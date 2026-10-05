// Tests: official Agent and Workflow parameter compatibility.
//
// Both tools had params official advertises that this project did not accept at
// all — an official-shaped call failed the strict parse. These lock in the
// accepted shapes, and (for Agent.mode) the security invariant that a
// model-supplied mode may narrow but never widen the session's authority.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeSingleTool } from "../tool-executor.js";
import { AgentTool } from "../tools/extended/agent.js";
import { WorkflowTool } from "../tools/extended/workflow.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ccr-agwf-"));

const modelCtx = (dir: string) =>
  ({
    cwd: dir,
    workspaceRoot: dir,
    allowedDirectories: [dir],
    permissionMode: "default",
    sessionId: "agwf",
    modelConfig: { provider: "test", model: "test-model", apiKey: "k" },
  }) as never;

const run = (
  tool: typeof AgentTool | typeof WorkflowTool,
  dir: string,
  args: Record<string, unknown>,
) =>
  executeSingleTool(
    { id: "1", function: { name: tool.name, arguments: JSON.stringify(args) } } as never,
    [tool],
    modelCtx(dir),
    async () => true,
  );

/**
 * Validate without executing. Agent.call() spawns a real sub-agent loop, so the
 * acceptance tests must stop at the schema — they assert that the shape is
 * ACCEPTED, not that a sub-agent ran.
 */
const accepts = (
  tool: typeof AgentTool | typeof WorkflowTool,
  args: Record<string, unknown>,
): string => {
  if (!tool.validateInput) throw new Error(`${tool.name} declares no validateInput`);
  try {
    tool.validateInput(args);
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

describe("Agent official params", () => {
  it("advertises mode and the deprecated team_name", () => {
    const props = AgentTool.inputSchema.properties as Record<string, unknown>;
    expect(props.mode).toBeDefined();
    expect(props.team_name).toBeDefined();
  });

  it("accepts official's full mode enum", () => {
    const modes = (AgentTool.inputSchema.properties as Record<string, { enum?: string[] }>).mode
      ?.enum;
    expect(modes).toEqual([
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "default",
      "dontAsk",
      "plan",
    ]);
  });

  it("rejects a mode that grants more authority than the session holds", async () => {
    const dir = tmp();
    const r = await run(AgentTool, dir, { prompt: "hi", mode: "bypassPermissions" });
    expect(r.isError).toBe(true);
    expect(String(r.formatted)).toContain("bypassPermissions");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a narrowing mode", () => {
    expect(accepts(AgentTool, { prompt: "hi", mode: "dontAsk" })).toBe("");
    expect(accepts(AgentTool, { prompt: "hi", mode: "acceptEdits" })).toBe("");
    expect(accepts(AgentTool, { prompt: "hi", mode: "auto" })).toBe("");
  });

  it("ignores team_name instead of failing the strict parse", () => {
    expect(accepts(AgentTool, { prompt: "hi", team_name: "ignored" })).toBe("");
  });

  it("rejects a mode outside official's enum", () => {
    expect(accepts(AgentTool, { prompt: "hi", mode: "yolo" })).not.toBe("");
  });
});

describe("Workflow official params", () => {
  it("advertises script, scriptPath and title", () => {
    const props = WorkflowTool.inputSchema.properties as Record<string, unknown>;
    expect(props.script).toBeDefined();
    expect(props.scriptPath).toBeDefined();
    expect(props.title).toBeDefined();
  });

  it("has no required params, matching official's all-optional WorkflowInput", () => {
    // `plan` becomes optional because official's `script` is optional and
    // `scriptPath` alone is a complete call.
    expect(WorkflowTool.inputSchema.required ?? []).toEqual([]);
  });

  it("does not require the internal description it never read", () => {
    const props = WorkflowTool.inputSchema.properties as Record<string, unknown>;
    expect(props.description).toBeDefined();
    expect(WorkflowTool.inputSchema.required ?? []).not.toContain("description");
  });

  it("runs a plan read from scriptPath", async () => {
    const dir = tmp();
    const planFile = path.join(dir, "plan.json");
    fs.writeFileSync(planFile, JSON.stringify({ steps: [{ phase: "x" }] }));
    const r = await run(WorkflowTool, dir, { scriptPath: planFile });
    // It reached the runner (a phase with no steps is an orchestration error),
    // which proves the file was read rather than rejected as a missing plan.
    expect(String(r.formatted)).not.toContain("is required");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a scriptPath outside the workspace", async () => {
    const dir = tmp();
    const r = await run(WorkflowTool, dir, { scriptPath: "C:/Windows/System32/drivers/etc/hosts" });
    expect(r.isError).toBe(true);
    expect(String(r.formatted)).toMatch(/outside|denied|not found/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a scriptPath pointing at a directory", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "sub"));
    const r = await run(WorkflowTool, dir, { scriptPath: path.join(dir, "sub") });
    expect(r.isError).toBe(true);
    expect(String(r.formatted)).toContain("not a file");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("explains that an official JS script module is not supported", async () => {
    const dir = tmp();
    // Official `script` is a JS module; this build evaluates no JavaScript. The
    // failure must be specific, not a bare JSON.parse "Unexpected token".
    const r = await run(WorkflowTool, dir, { script: "export const meta = { name: 'x' }" });
    expect(r.isError).toBe(true);
    expect(String(r.formatted)).toContain("evaluates no JavaScript");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts args as an object, as official specifies", () => {
    const args = (WorkflowTool.inputSchema.properties as Record<string, unknown>).args as {
      anyOf?: unknown[];
    };
    expect(args.anyOf?.length).toBeGreaterThan(1);
  });
});
