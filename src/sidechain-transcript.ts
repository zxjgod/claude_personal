// ============================================================
// Sidechain transcript recorder — sub-agent audit trail (拍板 #22)
// ============================================================
// Official 2.1.202 records every sub-agent's own turn stream into the session
// transcript with "isSidechain":true (post-hoc audit, debugging, and the data
// source for resuming orphaned agents). We do the same through the existing
// SessionTranscript, marked via the isSidechain/agentName fields, in TWO modes
// (子代理管理 /agents sidechain):
//
//   - "audit"  (DEFAULT): every sub-agent tool_use / tool_result / usage event
//                        plus the final report line.
//   - "report"           : ONLY the final subagent_report line (仅最终报告回流)
//                        — no per-tool detail.
//
// Recording is best-effort and never throws into the sub-agent loop: a disk
// failure must not fail the actual work. The module keeps one SessionTranscript
// per workspace (its internal seq cache makes repeated appends cheap).
// ============================================================

import { getSubagentSettings } from "./subagent-settings.js";
import { SessionTranscript, type TranscriptInput } from "./tui/session-transcript.js";

function transcriptFor(workspaceRoot: string): SessionTranscript {
  // Shared per-workspace instance (SessionTranscript.forWorkspace) — a private
  // instance would fork the seq cache from cli-session's main-line writer.
  return SessionTranscript.forWorkspace(workspaceRoot);
}

/** Cap for any single recorded payload (tool inputs can be huge). */
const FIELD_CAP = 2000;

function cap(text: string): string {
  return text.length <= FIELD_CAP ? text : `${text.slice(0, FIELD_CAP)}…`;
}

/**
 * Record one sub-agent event into the session transcript (sidechain-marked).
 * No-op when the mode filters this event out, and never throws.
 */
export function recordSidechain(
  workspaceRoot: string,
  sessionId: string,
  agentName: string,
  entry: TranscriptInput,
): Promise<void> {
  try {
    const mode = getSubagentSettings().sidechainMode;
    // "report" mode keeps ONLY the final report line (仅最终报告回流).
    if (mode === "report" && entry.type !== "subagent_report") return Promise.resolve();
    // `.catch` is load-bearing, not defensive noise: the callers below are
    // fire-and-forget (no await, no .catch of their own), so an append failure
    // — read-only workspace, ENOSPC, an unusable id — surfaced as an UNHANDLED
    // rejection, which terminates the CLI (Node >=15) over a best-effort audit
    // line. The promise still resolves only after this line hit the disk, so
    // tests awaiting a write are unaffected.
    return transcriptFor(workspaceRoot)
      .append(sessionId, {
        ...entry,
        isSidechain: true,
        agentName,
      })
      .catch(() => undefined);
  } catch {
    // Best-effort audit trail — never break the sub-agent over logging.
    return Promise.resolve();
  }
}

/** Convenience wrappers used by the sub-agent loops. (Fire-and-forget in
 * production; the returned promise lets tests await the disk write.) */
export function recordSidechainToolUse(
  workspaceRoot: string,
  sessionId: string,
  agentName: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
): Promise<void> {
  let serialized: Record<string, unknown> = input;
  try {
    const raw = JSON.stringify(input);
    if (raw.length > FIELD_CAP) serialized = { _truncated: cap(raw) };
  } catch {
    serialized = { _unserializable: true };
  }
  return recordSidechain(workspaceRoot, sessionId, agentName, {
    type: "tool_use",
    id,
    name,
    input: serialized,
  });
}

export function recordSidechainToolResult(
  workspaceRoot: string,
  sessionId: string,
  agentName: string,
  name: string,
  preview: string,
  error?: string,
): Promise<void> {
  return recordSidechain(workspaceRoot, sessionId, agentName, {
    type: "tool_result",
    name,
    preview: cap(preview),
    ...(error ? { error } : {}),
  });
}

export function recordSidechainReport(
  workspaceRoot: string,
  sessionId: string,
  agentName: string,
  report: string,
  durationMs?: number,
  toolCalls?: number,
): Promise<void> {
  return recordSidechain(workspaceRoot, sessionId, agentName, {
    type: "subagent_report",
    report: cap(report),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  });
}

/** Test hook: drop cached transcripts (seq caches) between tests. */
export function resetSidechainTranscripts(): void {
  SessionTranscript.resetShared();
}
