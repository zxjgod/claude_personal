// ============================================================
// Tests: Resume subsystem (拍板 #19, official 2.1.202 parity)
// ============================================================
// Typed sub-agent runs persist a full record (messages + status + report) to
// .claude/sessions/subagents-<sid>/<agentId>.json; task/agent `resume:"<id>"`
// reloads the stored conversation and continues it. Orphans (records stuck in
// "running" after a crash) are reported as "interrupted" by listRuns.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const captured: { messages: any[] }[] = [];
let reply = "canned answer";

vi.mock("../llm-adapter.js", () => ({
  createModelCaller: () =>
    async function* (messages: any[]) {
      captured.push({ messages: messages.map((m) => ({ ...m })) });
      yield { type: "text_delta", delta: reply };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    },
}));

import {
  claimRun,
  createRun,
  deleteRunsInDir,
  isRunActive,
  listRuns,
  loadRun,
  markRunActive,
  saveRun,
  unmarkRunActive,
} from "../subagent-store.js";
import { TaskTool } from "../tools/extended/task.js";
import type { ModelConfig, ToolContext } from "../types.js";

const modelConfig: ModelConfig = { provider: "deepseek", model: "deepseek-chat", apiKey: "k" };

let workspaceRoot: string;
const sessionId = `resume-test-${process.pid}`;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot,
    sessionId,
    permissionMode: "default",
    modelConfig,
    ...overrides,
  };
}

beforeEach(() => {
  captured.length = 0;
  reply = "canned answer";
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resume-test-"));
});

afterAll(() => {
  // Temp dirs are per-test under os.tmpdir(); best-effort sweep of this run.
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (name.startsWith("resume-test-")) {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  }
});

describe("subagent-store — record lifecycle", () => {
  it("createRun + saveRun + loadRun round-trips a record", () => {
    const run = createRun(workspaceRoot, sessionId, "general", "desc", "the prompt");
    expect(run.agentId).toMatch(/^general-/);
    run.status = "completed";
    run.report = "done";
    run.messages = [{ role: "user", content: [{ type: "text", text: "hi" }] } as any];
    saveRun(workspaceRoot, run);
    const loaded = loadRun(workspaceRoot, sessionId, run.agentId);
    expect(loaded?.status).toBe("completed");
    expect(loaded?.report).toBe("done");
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.prompt).toBe("the prompt");
  });

  it("loadRun returns undefined for unknown/corrupt records", () => {
    expect(loadRun(workspaceRoot, sessionId, "nope-123")).toBeUndefined();
    const run = createRun(workspaceRoot, sessionId, "general", "d", "p");
    saveRun(workspaceRoot, run);
    const file = path.join(
      workspaceRoot,
      ".claude",
      "sessions",
      `subagents-${sessionId}`,
      `${run.agentId}.json`,
    );
    fs.writeFileSync(file, "{not json", "utf-8");
    expect(loadRun(workspaceRoot, sessionId, run.agentId)).toBeUndefined();
  });

  it('listRuns reports crash-leftover "running" records as interrupted (orphan)', () => {
    const orphan = createRun(workspaceRoot, sessionId, "general", "crashed", "p");
    saveRun(workspaceRoot, orphan); // status stays "running" — process died
    const done = createRun(workspaceRoot, sessionId, "general", "ok", "p");
    done.status = "completed";
    saveRun(workspaceRoot, done);
    const runs = listRuns(workspaceRoot, sessionId);
    const byId = new Map(runs.map((r) => [r.agentId, r.status]));
    expect(byId.get(orphan.agentId)).toBe("interrupted");
    expect(byId.get(done.agentId)).toBe("completed");
  });

  it("active-run markers guard in-process runs", () => {
    expect(isRunActive(sessionId, "a-1")).toBe(false);
    markRunActive(sessionId, "a-1");
    expect(isRunActive(sessionId, "a-1")).toBe(true);
    unmarkRunActive(sessionId, "a-1");
    expect(isRunActive(sessionId, "a-1")).toBe(false);
  });
});

describe("TaskTool — resume (拍板 #19)", () => {
  it("a typed run persists a record and returns its agent id", async () => {
    const r = await TaskTool.call({ description: "d", prompt: "first task" }, ctx());
    expect(r.error).toBeUndefined();
    const agentId = r.metadata?.agentId as string;
    expect(agentId).toMatch(/^general-/);
    expect(r.content).toContain(`Agent id: ${agentId}`);
    const stored = loadRun(workspaceRoot, sessionId, agentId);
    expect(stored?.status).toBe("completed");
    expect(stored?.report).toBe("canned answer");
    // user prompt + assistant reply persisted as the resume seed
    expect(stored?.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("resume reloads the stored conversation and appends the new prompt", async () => {
    const r1 = await TaskTool.call({ description: "d", prompt: "first task" }, ctx());
    const agentId = r1.metadata?.agentId as string;
    captured.length = 0;
    reply = "follow-up answer";
    const r2 = await TaskTool.call(
      { description: "d2", prompt: "follow up", resume: agentId },
      ctx(),
    );
    expect(r2.error).toBeUndefined();
    expect(r2.metadata?.agentId).toBe(agentId); // same record continued
    const seen = captured[0]!.messages;
    const texts = seen.map((m) =>
      typeof m.content === "string" ? m.content : m.content?.[0]?.text,
    );
    expect(texts[0]).toBe("first task"); // stored history leads
    expect(texts).toContain("canned answer"); // first run's reply
    expect(texts[texts.length - 1]).toBe("follow up"); // new prompt appended last
    expect(r2.content).toContain("follow-up answer");
  });

  it("resume of an unknown id fails with a clear error", async () => {
    const r = await TaskTool.call(
      { description: "d", prompt: "p", resume: "general-nope-000" },
      ctx(),
    );
    expect(r.error).toContain("No stored sub-agent run");
  });

  it("resume cannot be combined with fork", async () => {
    const r = await TaskTool.call(
      { description: "d", prompt: "p", subagent_name: "fork", resume: "x-1" },
      ctx({ getParentMessages: () => [], parentSystemPrompt: "P" }),
    );
    expect(r.error).toContain("fork");
  });

  it("resume rejects a type mismatch against the stored record", async () => {
    const run = createRun(workspaceRoot, sessionId, "custom-x", "d", "p");
    run.status = "completed";
    saveRun(workspaceRoot, run);
    const r = await TaskTool.call(
      { description: "d", prompt: "p", subagent_name: "general", resume: run.agentId },
      ctx(),
    );
    expect(r.error).toContain('"custom-x"');
  });

  it("resume of an in-process running record is rejected", async () => {
    const run = createRun(workspaceRoot, sessionId, "general", "d", "p");
    run.status = "interrupted"; // disk state not "running"…
    saveRun(workspaceRoot, run);
    markRunActive(sessionId, run.agentId); // …but live in THIS process
    try {
      const r = await TaskTool.call({ description: "d", prompt: "p", resume: run.agentId }, ctx());
      expect(r.error).toContain("still running");
    } finally {
      unmarkRunActive(sessionId, run.agentId);
    }
  });

  it("an interrupted orphan record can be resumed", async () => {
    const orphan = createRun(workspaceRoot, sessionId, "general", "orphan", "original task");
    orphan.messages = [{ role: "user", content: [{ type: "text", text: "original task" }] } as any];
    saveRun(workspaceRoot, orphan); // "running" on disk == crashed
    const r = await TaskTool.call(
      { description: "d", prompt: "continue", resume: orphan.agentId },
      ctx(),
    );
    expect(r.error).toBeUndefined();
    const stored = loadRun(workspaceRoot, sessionId, orphan.agentId);
    expect(stored?.status).toBe("completed");
    expect(captured[0]!.messages[0].content[0].text).toBe("original task");
  });
});

describe("subagent-store — file-safe ids and run claims", () => {
  it("a plugin-namespaced type name still produces a visible, resumable record", () => {
    // loadAgentsDir registers plugin agents as "ns:agent". The colon reached
    // the file name, and on Windows `ns:agent-….json` is an NTFS ALTERNATE
    // DATA STREAM of a file called `ns` — the write "succeeded" but the run
    // directory then held no `*.json` entry, so /agents history (which lists
    // .json files) never showed the run and any tooling walking the directory
    // missed it too.
    const run = createRun(workspaceRoot, sessionId, "myplugin:reviewer", "d", "p");
    expect(run.agentId).not.toContain(":");
    run.status = "completed";
    saveRun(workspaceRoot, run);
    expect(loadRun(workspaceRoot, sessionId, run.agentId)?.status).toBe("completed");
    expect(listRuns(workspaceRoot, sessionId).map((r) => r.agentId)).toContain(run.agentId);
  });

  it("claimRun admits exactly one writer per run", () => {
    const run = createRun(workspaceRoot, sessionId, "general", "d", "p");
    try {
      expect(claimRun(sessionId, run.agentId)).toBe(true);
      expect(isRunActive(sessionId, run.agentId)).toBe(true);
      expect(claimRun(sessionId, run.agentId)).toBe(false);
    } finally {
      unmarkRunActive(sessionId, run.agentId);
    }
    expect(claimRun(sessionId, run.agentId)).toBe(true);
    unmarkRunActive(sessionId, run.agentId);
  });

  it("deleteRunsInDir removes the session records (session-delete wiring)", () => {
    const run = createRun(workspaceRoot, sessionId, "general", "d", "p");
    saveRun(workspaceRoot, run);
    expect(listRuns(workspaceRoot, sessionId)).toHaveLength(1);
    deleteRunsInDir(path.join(workspaceRoot, ".claude", "sessions"), sessionId);
    expect(listRuns(workspaceRoot, sessionId)).toHaveLength(0);
  });
});
