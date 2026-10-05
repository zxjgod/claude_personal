// ============================================================
// CLI session state — persistence, append-only transcript, stats,
// local telemetry, and session-id resolution/resume. The id lives
// in a mutable holder because /resume swaps it mid-session; every
// consumer reads `session.id` at use time (no stale captures, no
// non-null assertions).
// ============================================================

import chalk from "chalk";
import { bindCheckpointSession } from "./checkpoint.js";
import { parseCliArgs } from "./cli-args.js";
import { formatCliError } from "./cli-errors.js";
import { parseSessionName } from "./cli-session-flags.js";
import { releaseSessionGoal } from "./goal-runtime.js";
import { PersistenceManager } from "./persistence.js";
import { microCompactByTime } from "./services/time-micro-compact.js";
import { isValidSessionId } from "./session-memory.js";
import { restoreSessionRuntime, saveSessionRuntime } from "./session-runtime.js";
import { Telemetry } from "./telemetry.js";
import { releaseSessionSchedules } from "./tools/extended/scheduler.js";
import { resetNotifications } from "./tools/notifications.js";
import { SessionStats } from "./tui/session-stats.js";
import { SessionTranscript } from "./tui/session-transcript.js";
import type { Message } from "./types.js";

export interface SessionState {
  persistence: PersistenceManager;
  transcript: SessionTranscript;
  stats: SessionStats;
  telemetry: Telemetry;
  /** Mutable session id — /resume replaces it. */
  session: { id: string };
  /** Best-effort append to the M19.2 event log; a write failure warns but never blocks. */
  recordTranscript: (entry: Parameters<SessionTranscript["append"]>[1]) => void;
}

export async function initSession(deps: {
  workspaceRoot: string;
  messages: Message[];
  verbose: boolean;
  /**
   * Session id resolved by official `--from-pr [value]` in cli.ts, which
   * owns the `gh` round trip. Takes precedence over `--continue`'s "most
   * recent" guess but not over an explicit `--session` / `--resume`.
   */
  pullRequestSessionId?: string;
  /** The PR to link the resulting session to, for the next `--from-pr`. */
  pullRequest?: { number: number; url?: string; repository?: string };
}): Promise<SessionState> {
  const { workspaceRoot, messages, verbose, pullRequestSessionId, pullRequest } = deps;

  const persistence = new PersistenceManager(workspaceRoot);
  // M19.2: append-only event log (tool_use/tool_result/usage/…) alongside the
  // session snapshot. Best-effort: every record call is wrapped so a write
  // failure warns but never blocks the turn.
  const transcript = SessionTranscript.forWorkspace(workspaceRoot);
  const stats = new SessionStats();

  // Local telemetry (11.4) — disabled unless explicitly opted in. Local-only,
  // never sent over the network; records event names + counts, not content.
  const telemetry = Telemetry.fromWorkspace(workspaceRoot);
  if (telemetry.enabled && verbose) {
    console.log("Telemetry: enabled (local JSONL, no network egress)");
  }

  // Parse --session from CLI args
  const cliArgs = parseCliArgs(process.argv);
  let sessionId = cliArgs.sessionId ?? cliArgs.resume;
  if (!sessionId) {
    const sessionArg = process.argv.find((a) => a.startsWith("--session="));
    sessionId = sessionArg?.split("=")[1];
  }
  if (!sessionId && pullRequestSessionId) {
    sessionId = pullRequestSessionId;
  }
  if (!sessionId && cliArgs.continue) {
    const recent = await persistence.searchSessions("");
    sessionId = recent[0]?.sessionId;
  }

  // Session ids become file names (<id>.json, transcript sidecars, checkpoint
  // buckets) — an externally supplied id (--session-id/--resume/--session=/
  // --from-pr metadata, the last being REMOTE-controlled via gh output) must
  // not contain separators or "..". Reject before any path is built.
  if (sessionId && !isValidSessionId(sessionId)) {
    console.error(
      `Warning: ignoring malformed session id ${JSON.stringify(sessionId.slice(0, 64))} — starting a new session.`,
    );
    sessionId = undefined;
  }

  // If no session specified, list available ones in verbose mode only.
  // Use /sessions during normal use.
  if (!sessionId && verbose) {
    const sessions = await persistence.searchSessions("");
    const incomplete = sessions.filter((s) => s.taskState !== "stopped_by_user");
    if (incomplete.length > 0) {
      console.log("Recent incomplete sessions:");
      for (const s of incomplete.slice(0, 5)) {
        const pin = s.pinned ? "📌 " : "";
        const preview = s.preview ? ` — ${s.preview}` : "";
        console.log(
          `  ${pin}${s.sessionId.slice(0, 8)}... — ${s.messageCount} msgs — ${new Date(s.updatedAt).toLocaleString()}${preview}`,
        );
      }
      console.log("  Use --session=<id> to resume, or continue for a new session.");
      console.log("");
    }
  }

  // Generate or resume session
  if (sessionId) {
    const existing = await persistence.load(sessionId);
    if (existing) {
      // F5: a session resumed after a long idle starts cheaper — old
      // compactable tool results are cleared (config-gated, idempotent).
      messages.push(
        ...microCompactByTime(existing.messages, Date.parse(existing.updatedAt)).messages,
      );
      if (cliArgs.forkSession) {
        const sourceId = sessionId;
        sessionId = persistence.generateId();
        if (verbose)
          console.log(`Forked session ${sourceId.slice(0, 8)}... as ${sessionId.slice(0, 8)}...`);
      }
      if (verbose) {
        console.log(
          `Resumed session ${sessionId.slice(0, 8)}... (${existing.messageCount} messages)`,
        );
      }
    } else {
      console.log(`Session ${sessionId.slice(0, 8)}... not found. Starting new session.`);
      sessionId = persistence.generateId();
    }
  } else {
    sessionId = persistence.generateId();
  }
  if (verbose) {
    console.log(`Session: ${sessionId.slice(0, 8)}...`);
    console.log("");
  }

  const session = { id: sessionId };
  // Official `-n, --name <name>`: a human label for the session, kept in the
  // session file so /resume and /sessions can show something better than a
  // truncated id. Applies to a resumed session too — relabelling is the point.
  const sessionName = parseSessionName(process.argv);
  if (sessionName) {
    persistence.setSessionName(sessionId, sessionName);
    if (verbose) console.log(`Session name: ${sessionName}`);
  }
  // Official `--from-pr [value]` linkage. Applied to a resumed session too:
  // re-stating the same PR is a no-op, and re-stating a DIFFERENT one is the
  // user deliberately re-pointing the session at that PR.
  if (pullRequest) persistence.setSessionPullRequest(sessionId, pullRequest);
  if (!cliArgs.forkSession) restoreSessionRuntime(workspaceRoot, sessionId);
  bindCheckpointSession(session.id, workspaceRoot);
  const recordTranscript: SessionState["recordTranscript"] = (entry) => {
    transcript.append(session.id, entry).catch((err) => {
      console.error("Warning: transcript append failed:", formatCliError(err));
    });
  };

  return { persistence, transcript, stats, telemetry, session, recordTranscript };
}

/**
 * /resume support: swap the live session for a stored one, replacing the
 * shared messages array in place (agent-loop relies on array identity).
 */
export function createResumeSession(deps: {
  persistence: PersistenceManager;
  session: { id: string };
  messages: Message[];
  onResume?: () => void;
}): (idOrPrefix: string) => Promise<boolean> {
  const { persistence, session, messages } = deps;
  return async (idOrPrefix: string): Promise<boolean> => {
    const sessions = await persistence.searchSessions(idOrPrefix);
    const matches = sessions.filter((s) => s.sessionId.startsWith(idOrPrefix));
    if (matches.length !== 1) return false;
    const existing = await persistence.load(matches[0]!.sessionId);
    if (!existing) return false;
    if (session.id !== existing.sessionId) {
      saveSessionRuntime(persistence.workspaceRoot, session.id);
      releaseSessionGoal(session.id);
      releaseSessionSchedules(session.id);
      // Review fix ("通知状态泄漏"): background-completion notifications are
      // queued PER SESSION id. Swapping sessions without clearing strands the
      // old session's queue forever (its producers were just released above,
      // so nothing will ever drain it) — and the queued XML mentions work the
      // resumed session knows nothing about.
      resetNotifications(session.id);
    }
    session.id = existing.sessionId;
    bindCheckpointSession(session.id, persistence.workspaceRoot);
    restoreSessionRuntime(persistence.workspaceRoot, session.id);
    deps.onResume?.();
    messages.length = 0;
    // F5: same idle-time clearing as startup resume.
    messages.push(
      ...microCompactByTime(existing.messages, Date.parse(existing.updatedAt)).messages,
    );
    console.log(
      chalk.gray(`  Resumed session ${session.id.slice(0, 8)}... (${messages.length} messages)`),
    );
    return true;
  };
}
