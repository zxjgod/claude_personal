import * as fs from "node:fs";
import * as path from "node:path";
import { sessionGoal, setSessionGoal } from "../../goal-runtime.js";
import { restoreSessionRuntime, saveSessionRuntime } from "../../session-runtime.js";
import { createTask, listTasks } from "../../structured-tasks.js";
import {
  collectDueCronJobs,
  listScheduledJobs,
  loadDurableJobs,
  persistDurableJobs,
  registerScheduledJob,
} from "../../tools/extended/cron-shared.js";
import { enqueueScheduledInput, takeScheduledInput } from "../../tools/extended/schedule-scope.js";
import { createJob, listJobs } from "../../tools/job-store.js";
import { listWorkflows, runWorkflow } from "../../workflow.js";

const [mode, root, sessionId = "owner", runId, args = "original"] = process.argv.slice(2);
const emit = (value: unknown) => console.log(JSON.stringify(value));
if (mode === "seed") {
  setSessionGoal(sessionId, "finish the saved task");
  const goal = sessionGoal(sessionId);
  if (goal) {
    goal.complete = true;
    goal.checks = 2;
  }
  createTask(sessionId, "unfinished task", "must remain actionable").status = "in_progress";
  const job = createJob(sessionId, { kind: "bash", command: "fixture worker" });
  job.stdout = "partial stdout";
  job.stderr = "original diagnostic";
  for (const [cron, ageMs, prompt] of [
    ["+1", 5000, "overdue sleep"],
    ["+3600", 1000, "future sleep"],
    ["* * * * *", 8 * 86400000, "expired cron"],
  ] as const) {
    const schedule = registerScheduledJob({
      cron,
      prompt,
      recurring: false,
      durable: false,
      workspaceRoot: root,
      sessionId,
    });
    if (schedule) schedule.createdAtMs -= ageMs;
  }
  enqueueScheduledInput({
    registry: "cron",
    source: "cron",
    jobId: "queued",
    prompt: "queued prompt",
    label: "saved input",
    workspaceRoot: root,
    sessionId,
  });
  saveSessionRuntime(root, sessionId);
  setInterval(() => {}, 1000);
  emit({ ready: true });
} else if (mode === "restore") {
  restoreSessionRuntime(root, sessionId);
  restoreSessionRuntime(root, sessionId); // replay must not duplicate a queued input
  const jobs = listJobs(sessionId);
  await Promise.all(jobs.map((job) => job.settled));
  emit({
    goal: sessionGoal(sessionId),
    tasks: listTasks(sessionId).map(({ subject, status }) => ({ subject, status })),
    jobs: jobs.map(({ stdout, stderr, status, kill }) => ({
      stdout,
      stderr,
      status,
      hasKill: !!kill,
    })),
    schedules: listScheduledJobs({ workspaceRoot: root, sessionId }).map(({ prompt }) => prompt),
    remaining: listScheduledJobs({ workspaceRoot: root, sessionId })
      .filter((job) => job.cron === "+3600")
      .map((job) => 3600 - Number(process.hrtime.bigint() - job.createdAt) / 1e9),
    wrongSessionInput: takeScheduledInput({ workspaceRoot: root, sessionId: "stranger" }),
    wrongWorkspaceInput: takeScheduledInput({ workspaceRoot: path.join(root, "other"), sessionId }),
    input: takeScheduledInput({ workspaceRoot: root, sessionId }),
    duplicateInput: takeScheduledInput({ workspaceRoot: root, sessionId }),
    due: collectDueCronJobs(new Date(), { workspaceRoot: root, sessionId }).map(
      ({ job }) => job.prompt,
    ),
  });
} else if (mode === "durable-seed") {
  const job = registerScheduledJob({
    cron: "+1",
    prompt: "durable sleep",
    recurring: false,
    durable: true,
    workspaceRoot: root,
  });
  if (!job) throw new Error("fixture could not register durable sleep");
  job.createdAtMs -= 5000;
  persistDurableJobs(root);
  setInterval(() => {}, 1000);
  emit({ ready: true });
} else if (mode === "durable-restore") {
  loadDurableJobs(root);
  const scope = { workspaceRoot: root, sessionId };
  emit({
    due: collectDueCronJobs(new Date(), scope).map(({ job }) => job.prompt),
    duplicate: collectDueCronJobs(new Date(), scope).map(({ job }) => job.prompt),
  });
} else if (mode === "workflow-list") {
  emit(listWorkflows({ workspaceRoot: root, sessionId }));
} else if (
  ["workflow-seed", "workflow-crash", "workflow-resume", "workflow-retry"].includes(mode)
) {
  const plan = JSON.stringify({ steps: [{ agent: "first" }, { agent: "second" }] });
  if (mode === "workflow-seed" || mode === "workflow-crash") setInterval(() => {}, 1000);
  const result = await runWorkflow(
    plan,
    { workspaceRoot: root, sessionId, permissionMode: "default" },
    {
      args,
      resumeFromRunId: runId || undefined,
      ...(mode === "workflow-retry" && { retryUnconfirmed: true }),
      agentRunner: async (prompt) => {
        if ((mode === "workflow-seed" || mode === "workflow-crash") && prompt === "second") {
          if (mode === "workflow-crash")
            fs.appendFileSync(path.join(root, "calls.txt"), `${prompt}\n`);
          const file = fs.readdirSync(path.join(root, ".claude", "workflow-runs"))[0];
          emit({ ready: true, runId: file?.slice(sessionId.length + 1, -5) });
          await new Promise(() => {});
        }
        fs.appendFileSync(path.join(root, "calls.txt"), `${prompt}\n`);
        return `report:${prompt}`;
      },
    },
  );
  emit({ status: result.status, result: result.result, logs: result.logs });
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
