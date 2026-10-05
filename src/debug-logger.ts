// ============================================================
// Debug Logger — runtime monitoring for TUI debug mode
// ============================================================
// Enabled via the DEBUG_STREAM environment variable or the official CLI
// flags `--debug [filter]` and `--debug-file <path>`:
//   DEBUG_STREAM=1         — log all events
//   DEBUG_STREAM=text      — log text deltas
//   DEBUG_STREAM=tools     — log tool calls/results
//   DEBUG_STREAM=all       — log everything
//   DEBUG_STREAM=off       — disable (explicit)
//
// Usage:
//   import { debugLogger } from "./debug-logger.js";
//   debugLogger.enable("all", { file: ".claude/debug.log" });
//   debugLogger.info("tui", "Turn started", { turn: 1 });
//   debugLogger.logDelta("Hello", 5);
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

export interface DebugLogger {
  enable(mode: string, options?: { file?: string }): void;
  info(category: string, message: string, data?: Record<string, unknown>): void;
  logDelta(delta: string, totalChars: number): void;
  logCommit(fullText: string, totalChars: number): void;
  isEnabled(): boolean;
}

class DebugLoggerImpl implements DebugLogger {
  private enabled = false;
  private modes: Set<string> = new Set();
  /** Append-only sink installed by `--debug-file`; null keeps stderr output. */
  private sink: string | null = null;

  enable(mode: string, options?: { file?: string }): void {
    if (mode === "off") {
      this.enabled = false;
      this.modes.clear();
      return;
    }
    this.enabled = true;
    if (options?.file) {
      try {
        const target = path.resolve(options.file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Truncate on open so one debug run is a self-contained artifact.
        fs.writeFileSync(target, "", "utf-8");
        this.sink = target;
      } catch {
        // An unwritable debug path must never take the session down.
        this.sink = null;
        console.error(`debug: cannot write the debug log to ${options.file}; logging to stderr`);
      }
    }
    if (mode === "all" || mode === "1") {
      this.modes.add("info");
      this.modes.add("text");
      this.modes.add("tools");
      this.modes.add("commit");
    } else {
      for (const m of mode.split(",")) {
        this.modes.add(m.trim());
      }
    }
    this.info("debug", `Debug mode enabled: ${mode}`, {
      modes: Array.from(this.modes),
      ...(this.sink ? { file: this.sink } : {}),
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** One sink for every category, so the file keeps stderr's ordering. */
  private write(line: string): void {
    if (this.sink) {
      try {
        fs.appendFileSync(this.sink, `${line}\n`, "utf-8");
        return;
      } catch {
        // Disk full / file removed mid-run: degrade to stderr instead of
        // throwing from a debug call that must never break the loop.
        this.sink = null;
      }
    }
    console.error(line);
  }

  info(category: string, message: string, data?: Record<string, unknown>): void {
    if (!this.enabled || !this.modes.has("info")) return;
    const timestamp = new Date().toISOString().split("T")[1]?.slice(0, 8) ?? "";
    const prefix = `${timestamp} [${category}] ${message}`;
    this.write(data ? `${prefix} ${JSON.stringify(data)}` : prefix);
  }

  logDelta(delta: string, totalChars: number): void {
    if (!this.enabled || !this.modes.has("text")) return;
    const preview = delta.length > 50 ? `${delta.slice(0, 50)}...` : delta;
    this.write(`[text_delta] "${preview}" (total: ${totalChars})`);
  }

  logCommit(fullText: string, totalChars: number): void {
    if (!this.enabled || !this.modes.has("commit")) return;
    const preview = fullText.length > 100 ? `${fullText.slice(0, 100)}...` : fullText;
    this.write(`[commit] "${preview}" (${totalChars} chars)`);
  }
}

export const debugLogger: DebugLogger = new DebugLoggerImpl();
