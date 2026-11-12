import * as fs from "node:fs";
import * as path from "node:path";
import { restoreGoal, sessionGoal } from "./goal-runtime.js";
import { restoreLoop, saveLoop } from "./loop-runtime.js";
import { listTasks, restoreStructuredTasks } from "./structured-tasks.js";
import { listAgents, restoreTeam } from "./team.js";
import { listScheduledJobs, restoreSessionJobs } from "./tools/extended/cron-shared.js";
import { enqueueScheduledInput, pendingSessionInputs } from "./tools/extended/schedule-scope.js";
import { listWakeupJobs, restoreWakeups } from "./tools/extended/schedule-wakeup.js";
import { listJobs, restoreJobs } from "./tools/job-store.js";
import { renameSyncWithRetry } from "./utils/atomic-rename.js";

function backgroundSnapshot(sessionId: string) {
  return listJobs(sessionId).map(
    ({ settled: _settled, resolveSettled: _resolve, kill: _kill, ...job }) => ({
      ...job,
      stdout: job.stdout.slice(-1000000),
      stderr: job.stderr.slice(-1000000),
    }),
  );
}
/** Patch only jobs after shutdown: inactive sessions' goals/queues keep their
 * saved state and timestamp. Missing/deleted snapshots must not be recreated. */
export function saveBackgroundJobRuntime(root: string, sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return;
  const file = path.join(root, ".claude", "session-runtime", `${sessionId}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1)
      throw new Error();
  } catch {
    throw new Error("Invalid session runtime; refusing background-only update");
  }
  value.backgroundJobs = backgroundSnapshot(sessionId);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  renameSyncWithRetry(temp, file);
}
export function saveSessionRuntime(root: string, sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return;
  saveLoop({ workspaceRoot: root, sessionId });
  const file = path.join(root, ".claude", "session-runtime", `${sessionId}.json`);
  const value = {
    version: 1,
    savedAt: Date.now(),
    goal: sessionGoal(sessionId),
    jobs: listScheduledJobs().filter((job) => !job.durable && job.sessionId === sessionId),
    queuedInputs: pendingSessionInputs(sessionId),
    tasks: listTasks(sessionId),
    wakeups: listWakeupJobs()
      .filter((job) => job.sessionId === sessionId)
      .map((job) => ({
        ...job,
        fireAtMs: Date.now() + Number(job.fireAt - process.hrtime.bigint()) / 1000000,
      })),
    team: listAgents(sessionId).map(({ scope: _scope, ...agent }) => agent),
    backgroundJobs: backgroundSnapshot(sessionId),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    temp,
    JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? String(entry) : entry)),
  );
  renameSyncWithRetry(temp, file);
}
export function restoreSessionRuntime(root: string, sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return;
  restoreLoop({ workspaceRoot: root, sessionId });
  restoreGoal(sessionId, undefined);
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(root, ".claude", "session-runtime", `${sessionId}.json`), "utf8"),
    );
    if (value.version !== 1) return;
    restoreGoal(sessionId, value.goal);
    if (Array.isArray(value.jobs)) restoreSessionJobs(root, sessionId, value.jobs);
    if (
      Array.isArray(value.queuedInputs) &&
      typeof value.savedAt === "number" &&
      Date.now() - value.savedAt <= 7 * 86400000
    )
      for (const input of value.queuedInputs) {
        if (
          input &&
          input.sessionId === sessionId &&
          ["cron", "wakeup"].includes(input.registry) &&
          typeof input.prompt === "string" &&
          typeof input.jobId === "string" &&
          (input.workspaceRoot === undefined || typeof input.workspaceRoot === "string") &&
          typeof input.label === "string" &&
          ["cron", "wakeup"].includes(input.source) &&
          (input.dueKey === undefined || typeof input.dueKey === "string")
        )
          enqueueScheduledInput(input);
      }
    if (Array.isArray(value.tasks)) restoreStructuredTasks(sessionId, value.tasks);
    if (Array.isArray(value.wakeups)) restoreWakeups(root, sessionId, value.wakeups);
    if (Array.isArray(value.team)) restoreTeam(sessionId, value.team);
    if (Array.isArray(value.backgroundJobs)) restoreJobs(sessionId, value.backgroundJobs);
  } catch {
    /* no snapshot */
  }
}
