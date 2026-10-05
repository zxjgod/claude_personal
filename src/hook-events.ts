// ============================================================
// Hook lifecycle events — the `--include-hook-events` contract
// ------------------------------------------------------------
// KERNEL LAYER. A dependency-free sink plus the official stream-json
// message shapes, shared by the two sides that have to agree on the
// schema: the hook EXECUTION layer (hooks-config.ts, which owns the
// real lifecycle — spawn, stdout, exit code, timeout) and the stream
// WRITER (cli.ts / headless.ts).
//
// Official CLI 2.1.202 emits three `system` message subtypes into
// `--output-format stream-json`:
//   hook_started   { hook_id, hook_name, hook_event }
//   hook_progress  { …, stdout, stderr, output }   (only while output grows)
//   hook_response  { …, output, stdout, stderr, exit_code?, outcome }
//
// Two details are easy to get wrong and are therefore mirrored here:
//   1. the gate is NOT just the flag — SessionStart and Setup report
//      their lifecycle unconditionally; every other event needs
//      `--include-hook-events` (and must be a known event name).
//   2. `hook_name` is `${event}:${matcher}` when the config entry has a
//      matcher, and the bare event name when it does not.
// ============================================================

import { randomUUID } from "node:crypto";

/**
 * Hook event names the official client is willing to put on the output
 * stream. An event outside this set is never emitted: a consumer cannot
 * be expected to interpret a subtype it has no contract for.
 */
export const STREAM_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "MessageDisplay",
]);

/** Reported without `--include-hook-events` — official emits these two always. */
const ALWAYS_EMITTED: ReadonlySet<string> = new Set(["SessionStart", "Setup"]);

/** Terminal classification of one hook invocation. */
export type HookOutcome = "success" | "blocking" | "non_blocking_error" | "cancelled" | "error";

/** Identity carried by every message about one hook invocation. */
export interface HookIdentity {
  hookId: string;
  hookName: string;
  hookEvent: string;
}

export interface HookStartedEvent extends HookIdentity {
  phase: "started";
}
export interface HookProgressEvent extends HookIdentity {
  phase: "progress";
  stdout: string;
  stderr: string;
  output: string;
}
export interface HookResponseEvent extends HookIdentity {
  phase: "response";
  outcome: HookOutcome;
  output: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs?: number;
}
export type HookLifecycleEvent = HookStartedEvent | HookProgressEvent | HookResponseEvent;

export type HookLifecycleSink = (event: HookLifecycleEvent) => void;

let sink: HookLifecycleSink | undefined;
let includeAll = false;

/**
 * Install (or with `undefined`, remove) the consumer of hook lifecycle
 * events. `includeAll` mirrors `--include-hook-events`.
 *
 * A missing sink is the normal state outside stream-json print mode, and
 * every emitter below is a no-op then — no buffering, no queue.
 */
export function setHookLifecycleSink(
  next: HookLifecycleSink | undefined,
  options?: { includeAll?: boolean },
): void {
  sink = next;
  includeAll = options?.includeAll ?? false;
}

export function clearHookLifecycleSink(): void {
  setHookLifecycleSink(undefined);
}

/** Is a consumer currently attached? Lets an installer avoid stealing another's. */
export function hookLifecycleSinkActive(): boolean {
  return sink !== undefined;
}

/** Is `hookEvent` reportable right now? See the two gate rules in the header. */
export function hookLifecycleEmits(hookEvent: string): boolean {
  if (ALWAYS_EMITTED.has(hookEvent)) return true;
  return includeAll && STREAM_HOOK_EVENTS.has(hookEvent);
}

/** Official `hook_name`: `${event}:${matcher}` when the entry has a matcher. */
export function hookLifecycleName(hookEvent: string, matcher?: string): string {
  return matcher ? `${hookEvent}:${matcher}` : hookEvent;
}

export function hookIdentity(
  hookEvent: string,
  matcher: string | undefined,
  hookId: string,
): HookIdentity {
  return { hookId, hookName: hookLifecycleName(hookEvent, matcher), hookEvent };
}

export function emitHookStarted(id: HookIdentity): void {
  if (!sink || !hookLifecycleEmits(id.hookEvent)) return;
  sink({ ...id, phase: "started" });
}

export function emitHookProgress(
  id: HookIdentity,
  snapshot: { stdout: string; stderr: string },
): void {
  if (!sink || !hookLifecycleEmits(id.hookEvent)) return;
  sink({
    ...id,
    phase: "progress",
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    // Official's `output` is the combined transcript so far; with a single
    // stdout channel it is the stdout prefix, which is what a consumer
    // tailing a long-running hook actually wants.
    output: `${snapshot.stdout}${snapshot.stderr}`,
  });
}

export function emitHookResponse(
  id: HookIdentity,
  response: {
    outcome: HookOutcome;
    output?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    durationMs?: number;
  },
): void {
  if (!sink || !hookLifecycleEmits(id.hookEvent)) return;
  sink({
    ...id,
    phase: "response",
    outcome: response.outcome,
    output: response.output ?? "",
    stdout: response.stdout ?? "",
    stderr: response.stderr ?? "",
    ...(response.exitCode !== undefined && { exitCode: response.exitCode }),
    ...(response.durationMs !== undefined && { durationMs: response.durationMs }),
  });
}

/**
 * Shape one lifecycle event as the official `system` stream-json message.
 * `session_id` / `uuid` are attached here rather than at the call site,
 * matching official where every flushed frame gets them.
 */
export function hookLifecycleMessage(
  event: HookLifecycleEvent,
  sessionId: string,
): Record<string, unknown> {
  const base = { type: "system", session_id: sessionId, uuid: randomUUID() };
  if (event.phase === "started")
    return {
      ...base,
      subtype: "hook_started",
      hook_id: event.hookId,
      hook_name: event.hookName,
      hook_event: event.hookEvent,
    };
  if (event.phase === "progress")
    return {
      ...base,
      subtype: "hook_progress",
      hook_id: event.hookId,
      hook_name: event.hookName,
      hook_event: event.hookEvent,
      stdout: event.stdout,
      stderr: event.stderr,
      output: event.output,
    };
  return {
    ...base,
    subtype: "hook_response",
    hook_id: event.hookId,
    hook_name: event.hookName,
    hook_event: event.hookEvent,
    output: event.output,
    stdout: event.stdout,
    stderr: event.stderr,
    ...(event.exitCode !== undefined && { exit_code: event.exitCode }),
    outcome: event.outcome,
  };
}
