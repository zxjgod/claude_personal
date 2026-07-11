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

// --- Entry types ---

interface BaseEntry {
  /** Monotonic per-session sequence number (0-based). */
  seq: number;
  /** ISO 8601 write time. */
  ts: string;
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
  | (BaseEntry & { type: "aborted"; reason: string });

/** The fields a caller supplies; seq/ts are stamped by append(). */
export type TranscriptInput =
  | { type: "user_prompt"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; durationMs?: number; error?: string; preview: string }
  | { type: "usage"; input: number; output: number; cacheRead?: number; cacheCreation?: number }
  | { type: "compacted"; summary: string }
  | { type: "done"; finishReason: string; turns: number }
  | { type: "error"; message: string }
  | { type: "aborted"; reason: string };

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

  private filePath(sessionId: string): string {
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

  private writeSerialized(sessionId: string, entry: TranscriptInput): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });

    const seq = this.seqs.get(sessionId) ?? 0;
    this.seqs.set(sessionId, seq + 1);

    const full: TranscriptEntry = {
      seq,
      ts: new Date().toISOString(),
      ...entry,
    } as TranscriptEntry;

    // One compact JSON object per line. appendFile is atomic enough for our
    // needs: a kill mid-write only ever truncates the final line, which read()
    // tolerates.
    fs.appendFileSync(this.filePath(sessionId), `${JSON.stringify(full)}\n`, "utf-8");
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
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
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
