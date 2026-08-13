// ============================================================
// Tests: Workflow orchestration runtime (Phase 3)
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { resetWorkflows, runWorkflow } from "../workflow.js";

const ctx: ToolContext = {
  workspaceRoot: process.cwd(),
  sessionId: "wf-test",
  permissionMode: "default",
};

// A fake worker runner so the orchestration is testable without a live model.
const fakeAgent = async (prompt: string): Promise<string> => `result:${prompt}`;

afterEach(() => {
  resetWorkflows();
});

describe("runWorkflow", () => {
  it("runs a single agent and returns its result", async () => {
    const record = await runWorkflow(
      `const a = await agent("find X");
       return a;`,
      ctx,
      { agentRunner: fakeAgent },
    );
    expect(record.status).toBe("completed");
    expect(record.result).toBe("result:find X");
  });

  it("runs agents in parallel via parallel()", async () => {
    const record = await runWorkflow(
      `const r = await parallel([
         () => agent("a"),
         () => agent("b"),
         () => agent("c"),
       ]);
       return r.join(",");`,
      ctx,
      { agentRunner: fakeAgent },
    );
    expect(record.status).toBe("completed");
    expect(record.result).toBe("result:a,result:b,result:c");
  });

  it("pipes items through pipeline stages", async () => {
    const record = await runWorkflow(
      `const r = await pipeline(["a","b"], (x) => agent("stage1:" + x));
       return r.length;`,
      ctx,
      { agentRunner: fakeAgent },
    );
    expect(record.status).toBe("completed");
    expect(record.result).toBe("2");
  });

  it("captures log/phase lines and args", async () => {
    const record = await runWorkflow(
      `phase("scan");
       log("args = " + args);
       return "done";`,
      ctx,
      { agentRunner: fakeAgent, args: "hello" },
    );
    expect(record.logs).toContain("[phase] scan");
    expect(record.logs).toContain("args = hello");
    expect(record.result).toBe("done");
  });

  it("marks a throwing script as failed", async () => {
    const record = await runWorkflow(`throw new Error("boom")`, ctx, {
      agentRunner: fakeAgent,
    });
    expect(record.status).toBe("failed");
    expect(record.logs.some((l) => l.includes("boom"))).toBe(true);
  });
});
