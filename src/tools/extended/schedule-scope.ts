import * as path from "node:path";

/** Durable schedules belong to a workspace; ephemeral schedules also own a session. */
export interface ScheduleScope {
  workspaceRoot?: string;
  sessionId?: string;
}

export function scheduleWorkspaceKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function matchesScheduleScope(owner: ScheduleScope, active?: ScheduleScope): boolean {
  if (!active) return true;
  if (
    owner.workspaceRoot &&
    active.workspaceRoot &&
    scheduleWorkspaceKey(owner.workspaceRoot) !== scheduleWorkspaceKey(active.workspaceRoot)
  )
    return false;
  return !owner.sessionId || owner.sessionId === active.sessionId;
}

export interface PendingScheduledInput extends ScheduleScope {
  registry: "cron" | "wakeup";
  source: "cron" | "wakeup";
  jobId: string;
  prompt: string;
  label: string;
}

// Identity survives the busy queue, so cancellation reaches due inputs too.
const pendingInputs: PendingScheduledInput[] = [];

export function enqueueScheduledInput(input: PendingScheduledInput): void {
  pendingInputs.push(input);
}

export function takeScheduledInput(scope: ScheduleScope): PendingScheduledInput | undefined {
  const index = pendingInputs.findIndex((item) => matchesScheduleScope(item, scope));
  return index < 0 ? undefined : pendingInputs.splice(index, 1)[0];
}

export function cancelScheduledInputs(
  registry: PendingScheduledInput["registry"],
  jobId?: string,
  scope?: ScheduleScope,
): number {
  const ids = new Set<string>();
  for (let index = pendingInputs.length - 1; index >= 0; index--) {
    const item = pendingInputs[index];
    if (
      item &&
      item.registry === registry &&
      (!jobId || item.jobId === jobId) &&
      matchesScheduleScope(item, scope)
    ) {
      ids.add(item.jobId);
      pendingInputs.splice(index, 1);
    }
  }
  return ids.size;
}
