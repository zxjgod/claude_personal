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
  /**
   * Review fix ("recurring 忙时按 jobId 去重吞掉后续分钟"): which due-slot
   * this input belongs to (the epoch-minute for cron firings). The queue
   * dedupe only collapses inputs with the SAME dueKey, so a recurring job
   * that came due again while the last prompt was still parked queues a
   * SECOND delivery instead of being silently dropped.
   */
  dueKey?: string;
}

// Identity survives the busy queue, so cancellation reaches due inputs too.
const pendingInputs: PendingScheduledInput[] = [];
export function pendingSessionInputs(sessionId: string): PendingScheduledInput[] {
  return pendingInputs.filter((item) => item.sessionId === sessionId).map((item) => ({ ...item }));
}
export function releaseSessionInputs(sessionId: string): void {
  for (let index = pendingInputs.length - 1; index >= 0; index--)
    if (pendingInputs[index].sessionId === sessionId) pendingInputs.splice(index, 1);
}

export function enqueueScheduledInput(input: PendingScheduledInput): void {
  if (
    pendingInputs.some(
      (entry) =>
        entry.registry === input.registry &&
        entry.jobId === input.jobId &&
        entry.sessionId === input.sessionId &&
        entry.dueKey === input.dueKey,
    )
  )
    return;
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
