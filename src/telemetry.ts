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
  const filePath = path.join(
    workspaceRoot,
    ".claude",
    "telemetry",
    "events.jsonl",
  );

  // Env toggle (highest priority, both on and off forms).
  const env = process.env.CCR_TELEMETRY ?? process.env.LLM_TELEMETRY;
  if (env === "1" || env === "true") return { enabled: true, filePath };
  if (env === "0" || env === "false") return { enabled: false, filePath };

  // settings.json { telemetry: { enabled: bool } }
  try {
    const settingsPath = path.join(workspaceRoot, ".claude", "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    if (settings?.telemetry?.enabled === true) {
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
    } catch {
      // Telemetry must never break the session.
    }
  }
}
