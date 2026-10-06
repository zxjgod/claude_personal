// ============================================================
// Notification Center — background completion delivery (M41)
// ============================================================
// Session-keyed queue of <task_notification> blocks. Background work
// (background Bash jobs, background sub-agents, teammate messages) pushes a
// notification the moment it settles; the delivery layer drains the queue and
// injects it into the conversation as a user message so the model learns a
// background task finished WITHOUT polling job_output:
//
//   - mid-turn:   agent-loop drains at the tool-result boundary and continues
//                 the turn with the notification in history (the model can
//                 immediately act on the completion);
//   - turn start: the REPL/TUI prepends still-pending notifications to the
//                 next user message (background work finished while idle);
//   - idle UI:    the scheduler loop surfaces unseen notifications as a dim
//                 console line so the human sees the completion too
//                 (peek-only — the model still gets the queued copy).
//
// Deliberately in-memory: notifications are ephemeral handoffs between a live
// producer and the live loop of the same process. Nothing to persist.
// ============================================================

import { sanitizeTerminalText } from "../tui/terminal-width.js";

export interface TaskNotificationInput {
  loopId?: string;
  /** Stable id of the finished work (e.g. "job-3"). */
  id: string;
  /** Kind of work ("bash", "agent", …). */
  kind: string;
  /** Terminal status: "done" | "killed" | "error". */
  status: string;
  /** One-line human summary of what the work was. */
  summary: string;
  /** Optional tail of the output (already truncated by the producer). */
  outputTail?: string;
}

/** Render a notification as the <task_notification> XML block the model sees. */
export function formatTaskNotification(input: TaskNotificationInput): string {
  const parts = [
    "<task_notification>",
    `<task_id>${input.id}</task_id>`,
    `<kind>${input.kind}</kind>`,
    `<status>${input.status}</status>`,
    `<summary>${input.summary}</summary>`,
  ];
  if (input.outputTail) parts.push(`<output>\n${input.outputTail}\n</output>`);
  parts.push("</task_notification>");
  return parts.join("\n");
}

/** Human-facing one-liner for the idle UI (no XML). */
export function formatNotificationLine(input: TaskNotificationInput): string {
  // summary/kind/id come from background task output (model- or shell-
  // produced) — strip terminal control sequences before the idle UI prints it.
  const summary = sanitizeTerminalText(input.summary);
  const what = summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
  return `后台任务 ${sanitizeTerminalText(input.id)} (${sanitizeTerminalText(input.kind)}) ${sanitizeTerminalText(input.status)}: ${what}`;
}

interface PendingNotification {
  id: string;
  sessionId: string;
  /** Structured record — the UI renders a human line from this. */
  input: TaskNotificationInput;
  /** Pre-formatted <task_notification> XML the model receives. */
  text: string;
  createdAt: number;
  displayed: boolean;
}

type NotificationHook = (payload: Record<string, unknown>) => void | Promise<void>;
const notificationHooks = new Set<NotificationHook>();
export function registerNotificationHook(hook: NotificationHook): () => void {
  notificationHooks.add(hook);
  return () => notificationHooks.delete(hook);
}

const queues = new Map<string, PendingNotification[]>();
let counter = 0;

function bucket(sessionId: string): PendingNotification[] {
  let q = queues.get(sessionId);
  if (!q) {
    q = [];
    queues.set(sessionId, q);
  }
  return q;
}

/**
 * Queue a completion notification for a session's next model-visible delivery.
 * Fire-and-forget: producers call this from their settle path and never await.
 */
export function pushTaskNotification(sessionId: string, input: TaskNotificationInput): void {
  counter += 1;
  bucket(sessionId).push({
    id: `note-${counter}`,
    sessionId,
    input,
    text: formatTaskNotification(input),
    createdAt: Date.now(),
    displayed: false,
  });
  for (const hook of notificationHooks)
    void Promise.resolve(hook({ session_id: sessionId, notification: input })).catch(() => {});
}

/**
 * Remove and return all pending notifications for a session, formatted for
 * the model (M41 delivery). Draining clears the "unseen for display" state
 * with it — a notification the model has already received must not also be
 * re-shown to the user as new.
 */
export function drainNotifications(sessionId: string): string[] {
  const q = queues.get(sessionId);
  if (!q || q.length === 0) return [];
  const out = q.map((n) => n.text);
  queues.delete(sessionId);
  return out;
}

/**
 * Peek-only read for the idle UI: returns notifications not yet shown to the
 * user (as structured records, for a human-friendly line) and marks them
 * displayed. They STAY queued so the model still receives them at the next
 * delivery point.
 */
export function takeUnseenForDisplay(sessionId: string): TaskNotificationInput[] {
  const q = queues.get(sessionId);
  if (!q) return [];
  const out: TaskNotificationInput[] = [];
  for (const n of q) {
    if (!n.displayed) {
      out.push(n.input);
      n.displayed = true;
    }
  }
  return out;
}

/** Test/util: clear a session's queue. */
export function resetNotifications(sessionId?: string): void {
  if (sessionId === undefined) queues.clear();
  else queues.delete(sessionId);
}
