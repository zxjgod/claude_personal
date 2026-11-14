import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { afterEach, beforeEach, expect, it } from "vitest";

const fixture = path.resolve("src/__tests__/fixtures/runtime-process.ts");
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-runtime-process-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
const args = (mode: string, sessionId = "owner", runId = "", value = "original") => [
  "--import",
  "tsx",
  fixture,
  mode,
  root,
  sessionId,
  runId,
  value,
];
const env = () => ({ ...process.env, CCR_USER_CONFIG_DIR: path.join(root, "user") });

async function crashAfterSave(mode = "seed"): Promise<{ runId?: string }> {
  const child = spawn(process.execPath, args(mode), {
    env: env(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const lines = readline.createInterface({ input: child.stdout });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    for await (const line of lines) {
      const result = JSON.parse(line);
      if (result.ready) return result;
    }
    throw new Error(`fixture exited before save: ${stderr}`);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill("SIGKILL");
    await closed;
  }
}

function restore(mode = "restore", sessionId = "owner", runId = "", value = "original") {
  return JSON.parse(
    execFileSync(process.execPath, args(mode, sessionId, runId, value), {
      env: env(),
      windowsHide: true,
      timeout: 15000,
      encoding: "utf8",
    }).trim(),
  );
}

it("recovers completed goals and interrupted task state in a new process", async () => {
  await crashAfterSave();
  const state = restore();
  expect(state.goal).toMatchObject({
    complete: true,
    checks: 2,
    objective: "finish the saved task",
  });
  expect(state.tasks).toEqual([{ subject: "unfinished task", status: "pending" }]);
  expect(state.jobs).toMatchObject([{ status: "error", stdout: "partial stdout", hasKill: false }]);
});

it("retains background diagnostics when a new process marks a job interrupted", async () => {
  await crashAfterSave();
  expect(restore().jobs[0].stderr).toContain("original diagnostic");
  expect(restore().jobs[0].stderr).toContain("interrupted");
});

it("delivers an overdue relative sleep without restarting its full delay", async () => {
  await crashAfterSave();
  const state = restore();
  expect(state.schedules).toEqual(["overdue sleep", "future sleep"]);
  expect(state.due).toEqual(["overdue sleep"]);
  expect(state.remaining[0]).toBeLessThan(3599);
  expect(state.remaining[0]).toBeGreaterThan(3500);
});

it("restores elapsed durable sleeps and collects them once while awaiting delivery", async () => {
  await crashAfterSave("durable-seed");
  expect(restore("durable-restore")).toEqual({ due: ["durable sleep"], duplicate: [] });
});

it("keeps queued input in its original session and workspace without replay duplicates", async () => {
  await crashAfterSave();
  const state = restore();
  expect(state.wrongSessionInput).toBeUndefined();
  expect(state.wrongWorkspaceInput).toBeUndefined();
  expect(state.input).toMatchObject({
    prompt: "queued prompt",
    sessionId: "owner",
    workspaceRoot: root,
  });
  expect(state.duplicateInput).toBeUndefined();
  const other = restore("restore", "stranger");
  expect(other.tasks).toEqual([]);
  expect(other.jobs).toEqual([]);
  expect(other.input).toBeUndefined();
});

it("reuses completed workflow reports after a process crash without repeating their side effects", async () => {
  const { runId } = await crashAfterSave("workflow-seed");
  expect(runId).toBeTruthy();
  const result = restore("workflow-retry", "owner", runId);
  expect(result.status).toBe("completed");
  expect(result.logs.some((line: string) => line.startsWith("resumed:"))).toBe(true);
  expect(fs.readFileSync(path.join(root, "calls.txt"), "utf8")).toBe("first\nsecond\n");
});

it("executes workflow steps again when their arguments change after restart", async () => {
  const { runId } = await crashAfterSave("workflow-seed");
  expect(restore("workflow-retry", "owner", runId, "changed").status).toBe("completed");
  expect(fs.readFileSync(path.join(root, "calls.txt"), "utf8")).toBe("first\nfirst\nsecond\n");
});

it("does not replay a worker whose side effect survived but whose report did not", async () => {
  const { runId } = await crashAfterSave("workflow-crash");
  expect(runId).toBeTruthy();
  const readEffects = () => fs.readFileSync(path.join(root, "calls.txt"), "utf8");
  expect(readEffects()).toBe("first\nsecond\n");
  expect(restore("workflow-list")).toMatchObject([
    {
      id: runId,
      status: "failed",
      logs: expect.arrayContaining([expect.stringContaining("steps[1]")]),
    },
  ]);
  expect(restore("workflow-list", "another-session")).toEqual([]);
  for (const args of ["original", "changed"]) {
    const result = restore("workflow-resume", "owner", runId, args);
    expect(result.status).toBe("failed");
    expect(result.logs.join("\n")).toContain("unconfirmed worker");
    expect(result.logs.join("\n")).toContain("steps[1]");
    expect(readEffects()).toBe("first\nsecond\n");
  }
  // The caller has reconciled the prior side effect and opts into a retry.
  expect(restore("workflow-retry", "owner", runId).status).toBe("completed");
  expect(readEffects()).toBe("first\nsecond\nsecond\n");
});
