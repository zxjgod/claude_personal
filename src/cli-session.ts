// ============================================================
// CLI session state — persistence, append-only transcript, stats,
// local telemetry, and session-id resolution/resume. The id lives
// in a mutable holder because /resume swaps it mid-session; every
// consumer reads `session.id` at use time (no stale captures, no
// non-null assertions).
// ============================================================

import chalk from "chalk";
import { parseCliArgs } from "./cli-args.js";
import { formatCliError } from "./cli-errors.js";
import { PersistenceManager } from "./persistence.js";
import { microCompactByTime } from "./services/time-micro-compact.js";
import { Telemetry } from "./telemetry.js";
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
}): Promise<SessionState> {
  const { workspaceRoot, messages, verbose } = deps;

  const persistence = new PersistenceManager(workspaceRoot);
  // M19.2: append-only event log (tool_use/tool_result/usage/…) alongside the
  // session snapshot. Best-effort: every record call is wrapped so a write
  // failure warns but never blocks the turn.
  const transcript = new SessionTranscript(workspaceRoot);
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
  if (!sessionId && cliArgs.continue) {
    const recent = await persistence.searchSessions("");
    sessionId = recent[0]?.sessionId;
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
}): (idOrPrefix: string) => Promise<boolean> {
  const { persistence, session, messages } = deps;
  return async (idOrPrefix: string): Promise<boolean> => {
    const sessions = await persistence.searchSessions(idOrPrefix);
    const matches = sessions.filter((s) => s.sessionId.startsWith(idOrPrefix));
    if (matches.length !== 1) return false;
    const existing = await persistence.load(matches[0]!.sessionId);
    if (!existing) return false;
    session.id = existing.sessionId;
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
