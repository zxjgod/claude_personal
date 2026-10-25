// ============================================================
// SessionTranscript — append-only event log (M19.2)
// ============================================================
// A lightweight, append-only JSONL record of what actually happened during a
// session: user prompts, tool_use calls, tool results, token usage, compaction,
// turn boundaries, errors. Stored alongside the session snapshot at
//   <workspace>/.claude/sessions/<sessionId>.transcript.jsonl
//
// Unlike SessionMemory (which keeps the live Message[] for resuming the model),
// the transcript is an audit/replay log: one JSON object per line, never
// rewritten. It survives a crash mid-write (the last partial line is simply
// skipped on read) and can be folded into a summary via replay().
//
// Deliberately NOT the reference's parent-UUID JSONL chain — no branching, no
// leaf selection. Just a flat, ordered event stream.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { isValidSessionId } from "../session-memory.js";
import { withFileLock } from "../utils/file-lock.js";

// --- Entry types ---

interface BaseEntry {
  /** Monotonic per-session sequence number (0-based). */
  seq: number;
  /** ISO 8601 write time. */
  ts: string;
  /**
   * Sidechain marker (official 2.1.202 parity, 拍板 #22): events emitted by a
   * SUB-AGENT's own loop, not the main line. Audit folds (/recap, replay)
   * skip them; a future Resume subsystem (#19) filters them out of the
   * restored main conversation — exactly like official `"isSidechain":true`.
   */
  isSidechain?: boolean;
  /** Name of the sub-agent that emitted a sidechain entry. */
  agentName?: string;
}

export type TranscriptEntry =
  | (BaseEntry & { type: "user_prompt"; text: string })
  | (BaseEntry & {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    })
  | (BaseEntry & {
      type: "tool_result";
      name: string;
      durationMs?: number;
      error?: string;
      /** Truncated preview of the formatted result. */
      preview: string;
    })
  | (BaseEntry & {
      type: "usage";
      input: number;
      output: number;
      cacheRead?: number;
      cacheCreation?: number;
    })
  | (BaseEntry & { type: "compacted"; summary: string })
  | (BaseEntry & { type: "done"; finishReason: string; turns: number })
  | (BaseEntry & { type: "error"; message: string })
  | (BaseEntry & { type: "aborted"; reason: string })
  | (BaseEntry & {
      /** A sub-agent's final report (always sidechain-marked, 拍板 #22). */
      type: "subagent_report";
      /** Truncated final report text. */
      report: string;
      durationMs?: number;
      toolCalls?: number;
    });

/** The fields a caller supplies; seq/ts are stamped by append(). */
export type TranscriptInput = SidechainMarker &
  (
    | { type: "user_prompt"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; name: string; durationMs?: number; error?: string; preview: string }
    | { type: "usage"; input: number; output: number; cacheRead?: number; cacheCreation?: number }
    | { type: "compacted"; summary: string }
    | { type: "done"; finishReason: string; turns: number }
    | { type: "error"; message: string }
    | { type: "aborted"; reason: string }
    | { type: "subagent_report"; report: string; durationMs?: number; toolCalls?: number }
  );

/** Sidechain marker fields any input variant may carry (拍板 #22). */
type SidechainMarker = { isSidechain?: boolean; agentName?: string };

/** A folded summary of a transcript, for /recap and debugging. */
export interface TranscriptReplay {
  prompts: number;
  toolCalls: number;
  turns: number;
  totalUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  /** Per-tool call counts, e.g. { edit: 3, bash: 1 }. */
  toolCounts: Record<string, number>;
}

/** Max characters kept from a tool result's formatted output. */
const PREVIEW_CAP = 2000;

export class SessionTranscript {
  private sessionsDir: string;
  /**
   * Per-session append queue. Appends are fire-and-forget from the caller's
   * perspective but must land in order; chaining onto a single promise per
   * session keeps the seq counter and the on-disk line order consistent even
   * when several events fire in the same tick.
   */
  private chains = new Map<string, Promise<void>>();
  /** Next sequence number per session (in-memory; reset per process). */
  private seqs = new Map<string, number>();

  constructor(workspaceRoot: string) {
    this.sessionsDir = path.join(workspaceRoot, ".claude", "sessions");
  }

  /**
   * Shared per-workspace instance (拍板 #22). Two SessionTranscript objects
   * over the SAME directory keep independent seq caches and append chains —
   * interleaved writes from the main line (cli-session) and the sidechain
   * recorder would collide on duplicate seq numbers and reorder lines.
   * Everyone writing the same workspace's transcripts must go through here.
   */
  private static shared = new Map<string, SessionTranscript>();
  static forWorkspace(workspaceRoot: string): SessionTranscript {
    let t = SessionTranscript.shared.get(workspaceRoot);
    if (!t) {
      t = new SessionTranscript(workspaceRoot);
      SessionTranscript.shared.set(workspaceRoot, t);
    }
    return t;
  }
  /** Test hook: drop all shared instances (fresh seq caches). */
  static resetShared(): void {
    SessionTranscript.shared.clear();
  }

  private filePath(sessionId: string): string {
    // Same floor SessionMemory applies to its own path constructor: an id with
    // a separator or ".." would write the transcript outside .claude/sessions.
    // Callers today only pass generated ids, but every path constructor guards.
    if (!isValidSessionId(sessionId)) {
      throw new Error(`Invalid session id: ${JSON.stringify(sessionId.slice(0, 64))}`);
    }
    return path.join(this.sessionsDir, `${sessionId}.transcript.jsonl`);
  }

  /**
   * Append one event. Returns a promise that resolves once THIS line has been
   * written, but callers normally ignore it (best-effort logging). Failures
   * reject the returned promise but never poison the chain for later appends.
   */
  append(sessionId: string, entry: TranscriptInput): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.writeSerialized(sessionId, entry));
    this.chains.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Highest seq already on disk for this session, or -1 when there is no
   * (readable) transcript. Reads only the tail; a crash-truncated last line
   * is skipped by scanning upward for the first parseable entry.
   *
   * Review fix ("末行超 64KB 时 seq 从 0 重排"): a SINGLE transcript line
   * larger than the fixed 64KB tail window (a big tool_result event) leaves
   * the window holding only an unparseable fragment — the old code returned
   * -1 and restarted numbering at 0, reopening the exact duplicate-seq
   * corruption C2 fixed. Double the window until a seq is found or the whole
   * file has been scanned (capped at 16MB; a file with NO parseable seq at
   * all still degrades to -1).
   */
  private lastSeqOnDisk(sessionId: string): number {
    try {
      const file = this.filePath(sessionId);
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, "r");
      try {
        for (let window = 65_536; ; window = Math.min(window * 4, size, 16 * 1024 * 1024)) {
          const len = Math.min(size, window);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, size - len);
          const lines = buf.toString("utf-8").split("\n").filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i]!) as { seq?: unknown };
              if (typeof parsed.seq === "number") return parsed.seq;
            } catch {}
          }
          if (len >= size || window >= 16 * 1024 * 1024) break;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // No transcript yet — start at 0.
    }
    return -1;
  }

  private writeSerialized(sessionId: string, entry: TranscriptInput): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    const file = this.filePath(sessionId);

    // Review fix (跨进程 seq 重复 + 崩溃尾部粘连): the seq computation and the
    // append run inside the transcript file's cross-process lock, so two
    // terminals resuming one session can never mint the same seq, and a
    // crash-truncated tail (no trailing newline) gets one prepended instead
    // of fusing with our new line into an unreadable JSON blob.
    withFileLock(file, () => {
      let seq = this.seqs.get(sessionId);
      if (seq === undefined) seq = this.lastSeqOnDisk(sessionId) + 1;
      this.seqs.set(sessionId, seq + 1);

      const full: TranscriptEntry = {
        seq,
        ts: new Date().toISOString(),
        ...entry,
      } as TranscriptEntry;

      let prefix = "";
      try {
        const size = fs.statSync(file).size;
        if (size > 0) {
          const fd = fs.openSync(file, "r");
          try {
            const tail = Buffer.alloc(1);
            fs.readSync(fd, tail, 0, 1, size - 1);
            if (tail[0] !== 0x0a) prefix = "\n";
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch {
        /* no file yet — nothing to join */
      }
      // One compact JSON object per line. appendFile is atomic enough for our
      // needs: a kill mid-write only ever truncates the final line, which read()
      // tolerates.
      fs.appendFileSync(file, `${prefix}${JSON.stringify(full)}\n`, "utf-8");
    });
  }

  /**
   * Read all entries for a session. Malformed lines (e.g. a partial final line
   * from a crash) are skipped rather than throwing. Returns [] if no transcript
   * exists yet.
   */
  read(sessionId: string): TranscriptEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath(sessionId), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const entries: TranscriptEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.type === "string") {
          entries.push(parsed as TranscriptEntry);
        }
      } catch {
        // Skip a corrupt/partial line (tolerant tail).
      }
    }
    return entries;
  }

  /**
   * Fold a transcript into a small summary. Useful for /recap and debugging
   * without replaying every event.
   */
  replay(sessionId: string): TranscriptReplay {
    const summary: TranscriptReplay = {
      prompts: 0,
      toolCalls: 0,
      turns: 0,
      totalUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      toolCounts: {},
    };

    for (const e of this.read(sessionId)) {
      // 拍板 #22: sidechain (sub-agent) events never fold into the main-line
      // summary — official filters isSidechain out of /resume the same way.
      if (e.isSidechain) continue;
      switch (e.type) {
        case "user_prompt":
          summary.prompts += 1;
          break;
        case "tool_use":
          summary.toolCalls += 1;
          summary.toolCounts[e.name] = (summary.toolCounts[e.name] ?? 0) + 1;
          break;
        case "usage":
          summary.totalUsage.input += e.input;
          summary.totalUsage.output += e.output;
          summary.totalUsage.cacheRead += e.cacheRead ?? 0;
          summary.totalUsage.cacheCreation += e.cacheCreation ?? 0;
          break;
        case "done":
          summary.turns += e.turns;
          break;
      }
    }
    return summary;
  }

  /** Truncate a formatted tool result to the preview cap. */
  static preview(formatted: string): string {
    if (formatted.length <= PREVIEW_CAP) return formatted;
    return `${formatted.slice(0, PREVIEW_CAP)}… (${formatted.length - PREVIEW_CAP} more chars)`;
  }
}
