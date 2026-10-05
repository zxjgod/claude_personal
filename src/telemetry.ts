// ============================================================
// Local Telemetry / Analytics (11.4)
// ============================================================
// An opt-in, LOCAL-ONLY event recorder. It appends newline-delimited JSON
// events to a file under the workspace (.claude/telemetry/events.jsonl by
// default). Nothing is ever sent over the network — this is for the user's
// own inspection of their session (tool usage, turns, token totals).
//
// Privacy by default: telemetry is DISABLED unless explicitly turned on via
// CCR_TELEMETRY=1 / LLM_TELEMETRY=1 or `.claude/settings.json` { telemetry:
// { enabled: true } }. When enabled we still avoid recording prompt/response
// content — only event names, counts, and coarse metadata.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { readSettings } from "./settings.js";
import { renameSyncWithRetry } from "./utils/atomic-rename.js";
import { ccrPath } from "./workspace-config.js";

export interface TelemetryEvent {
  /** Event name, e.g. "session_start", "turn", "tool_call". */
  event: string;
  /** Arbitrary non-sensitive metadata (counts, ids, model name). */
  props?: Record<string, unknown>;
}

export interface TelemetryOptions {
  enabled: boolean;
  /** Absolute path to the JSONL sink. */
  filePath: string;
}

/**
 * Resolve telemetry settings from env + project settings.json. Env wins.
 * Returns { enabled:false } unless the user explicitly opted in.
 */
export function resolveTelemetryOptions(workspaceRoot: string): TelemetryOptions {
  const filePath = ccrPath(workspaceRoot, "telemetry", "events.jsonl");

  // Env toggle (highest priority, both on and off forms).
  const env = process.env.CCR_TELEMETRY ?? process.env.LLM_TELEMETRY;
  if (env === "1" || env === "true") return { enabled: true, filePath };
  if (env === "0" || env === "false") return { enabled: false, filePath };

  // settings.json { telemetry: { enabled: bool } } — resolved through the
  // normal layered reader (user → project → local → managed, later wins)
  // instead of reading the PROJECT file directly. The direct read meant:
  //   * a user-level `telemetry.enabled: true` was ignored for a global
  //     install (the toggle was written to the user file and then never read
  //     back), and
  //   * managed settings could not force recording OFF.
  // Precedence within the settings layers follows the documented merge order;
  // env (above) still overrides everything.
  try {
    const telemetry = readSettings(workspaceRoot).telemetry as { enabled?: unknown } | undefined;
    if (telemetry?.enabled === true) {
      return { enabled: true, filePath };
    }
  } catch {
    // No settings file / unparseable — fall through to disabled.
  }

  return { enabled: false, filePath };
}

/**
 * Local telemetry recorder. When disabled, every method is a cheap no-op.
 */
export class Telemetry {
  readonly enabled: boolean;
  private readonly filePath: string;
  private dirReady = false;

  constructor(opts: TelemetryOptions) {
    this.enabled = opts.enabled;
    this.filePath = opts.filePath;
  }

  /** Convenience: build from workspace settings/env. */
  static fromWorkspace(workspaceRoot: string): Telemetry {
    return new Telemetry(resolveTelemetryOptions(workspaceRoot));
  }

  /** Append one event. No-op when disabled. Never throws. */
  record(event: string, props?: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      if (!this.dirReady) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.dirReady = true;
      }
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...(props ? { props } : {}),
      } satisfies Record<string, unknown>);
      fs.appendFileSync(this.filePath, line + "\n");
      // Review fix (§五 "events.jsonl 无限增长"): an opted-in workspace
      // accumulated events forever. Rotate past a cap: keep the newest tail
      // and rewrite atomically (tmp + rename). Events are diagnostic, so
      // dropping the oldest half loses nothing the user depends on.
      const MAX_BYTES = 5 * 1024 * 1024;
      if (fs.statSync(this.filePath).size > MAX_BYTES) {
        const KEEP_BYTES = 2 * 1024 * 1024;
        const fd = fs.openSync(this.filePath, "r");
        let tail: string;
        try {
          const buf = Buffer.alloc(KEEP_BYTES);
          const size = fs.fstatSync(fd).size;
          fs.readSync(fd, buf, 0, KEEP_BYTES, size - KEEP_BYTES);
          tail = buf.toString("utf-8");
        } finally {
          // Close BEFORE the rename: replacing a file that is still open for
          // reading fails with EPERM/EBUSY on Windows, and the swallowed catch
          // would then leave the sink un-rotated (and a stray .tmp behind).
          fs.closeSync(fd);
        }
        // Drop the first partial line so the tail stays valid JSONL.
        const firstNl = tail.indexOf("\n");
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, firstNl >= 0 ? tail.slice(firstNl + 1) : tail);
        renameSyncWithRetry(tmp, this.filePath);
      }
    } catch {
      // Telemetry must never break the session.
    }
  }
}
