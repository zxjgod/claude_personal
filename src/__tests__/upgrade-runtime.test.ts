import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { confirmProjectLspConfig, disposeLanguageServers } from "../language-servers.js";
import { restoreSessionRuntime, saveSessionRuntime } from "../session-runtime.js";
import { clearTasks, createTask, listTasks } from "../structured-tasks.js";
import { createAgents, listAgents, resetTeams } from "../team.js";
import { AskUserQuestionTool } from "../tools/breadth/interactive.js";
import {
  listScheduledJobs,
  registerScheduledJob,
  resetScheduledJobs,
} from "../tools/extended/cron-shared.js";
import { LspNavigationTool } from "../tools/extended/lsp-navigation.js";
import { clearJobs, createJob, listJobs } from "../tools/job-store.js";
import { runWorkflow } from "../workflow.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-runtime-upgrade-"));
  vi.stubEnv("CCR_USER_CONFIG_DIR", path.join(root, "user"));
  resetScheduledJobs();
});
afterEach(async () => {
  await disposeLanguageServers();
  clearTasks("upgrade-session");
  resetTeams();
  clearJobs("upgrade-session");
  resetScheduledJobs();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it("uses standard LSP framing to navigate a configured non-TypeScript language", async () => {
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(
    path.join(root, ".claude", "lsp.json"),
    JSON.stringify({
      fixture: {
        command: process.execPath,
        args: [path.resolve("src/__tests__/fixtures/mock-lsp-server.mjs")],
        extensionToLanguage: { ".py": "python" },
      },
    }),
  );
  fs.writeFileSync(path.join(root, "fixture.py"), "def fixture(): pass");
  await confirmProjectLspConfig(root, async () => true);
  const result = await LspNavigationTool.call(
    { operation: "definition", filePath: "fixture.py", line: 1, column: 5 },
    { workspaceRoot: root, sessionId: "upgrade-session", permissionMode: "default" },
  );
  expect(result.error).toBeUndefined();
  expect(JSON.parse(result.content)[0].range.start.line).toBe(2);
});
it("collects a batch of questions with option previews through the interactive channel", async () => {
  const ask = vi.fn(async () => ["A"]);
  const result = await AskUserQuestionTool.call(
    {
      questions: [
        { question: "First?", options: [{ label: "A", preview: "sample" }, "B"] },
        { question: "Second?", options: ["A", "B"] },
      ],
    },
    {
      workspaceRoot: root,
      sessionId: "upgrade-session",
      permissionMode: "default",
      askUserQuestion: ask,
    },
  );
  expect(JSON.parse(result.content).answers).toEqual({ "First?": ["A"], "Second?": ["A"] });
  expect(ask.mock.calls).toHaveLength(2);
});
it("restores session schedules and structured tasks only for their original session", () => {
  registerScheduledJob({
    cron: "*/5 * * * *",
    prompt: "check",
    recurring: true,
    durable: false,
    workspaceRoot: root,
    sessionId: "upgrade-session",
  });
  createTask("upgrade-session", "fixture", "Restore me");
  createAgents("upgrade-session", [{ role: "general", name: "worker" }]);
  const job = createJob("upgrade-session", { kind: "agent", command: "fixture" });
  job.stdout = "partial progress";
  saveSessionRuntime(root, "upgrade-session");
  resetScheduledJobs();
  clearTasks("upgrade-session");
  resetTeams();
  job.status = "error";
  clearJobs("upgrade-session");
  restoreSessionRuntime(root, "different-session");
  expect(listScheduledJobs()).toHaveLength(0);
  restoreSessionRuntime(root, "upgrade-session");
  expect(listScheduledJobs({ workspaceRoot: root, sessionId: "upgrade-session" })).toHaveLength(1);
  expect(listTasks("upgrade-session")[0].subject).toBe("fixture");
  expect(listAgents("upgrade-session")[0].role).toBe("general");
  expect(listJobs("upgrade-session")[0]).toMatchObject({
    status: "error",
    stdout: "partial progress",
  });
});
it("resumes unchanged workflow calls and executes each bounded loop iteration", async () => {
  const ctx = {
    workspaceRoot: root,
    sessionId: "upgrade-session",
    permissionMode: "default" as const,
  };
  const worker = vi.fn(async (prompt: string) => `result:${prompt}`);
  const first = await runWorkflow(
    JSON.stringify({ steps: [{ agent: "first" }, { agent: "second" }] }),
    ctx,
    { agentRunner: worker },
  );
  await runWorkflow(JSON.stringify({ steps: [{ agent: "first" }, { agent: "third" }] }), ctx, {
    agentRunner: worker,
    resumeFromRunId: first.id,
  });
  expect(worker).toHaveBeenCalledTimes(3);
  await runWorkflow(
    JSON.stringify({
      steps: [
        { agent: "marker" },
        {
          if: {
            from: 0,
            includes: "marker",
            // biome-ignore lint/suspicious/noThenProperty: declarative branch data.
            then: [{ repeat: { times: 2, steps: [{ agent: "repeat" }] } }],
          },
        },
      ],
    }),
    ctx,
    { agentRunner: worker },
  );
  expect(worker.mock.calls.filter(([prompt]) => prompt === "repeat")).toHaveLength(2);
});
