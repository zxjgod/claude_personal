// ============================================================
// Debug Logger — runtime monitoring for TUI debug mode
// ============================================================
// Enabled via DEBUG_STREAM environment variable:
//   DEBUG_STREAM=1         — log all events
//   DEBUG_STREAM=text      — log text deltas
//   DEBUG_STREAM=tools     — log tool calls/results
//   DEBUG_STREAM=all       — log everything
//   DEBUG_STREAM=off       — disable (explicit)
//
// Usage:
//   import { debugLogger } from "./debug-logger.js";
//   debugLogger.enable("all");
//   debugLogger.info("tui", "Turn started", { turn: 1 });
//   debugLogger.logDelta("Hello", 5);
// ============================================================

export interface DebugLogger {
  enable(mode: string): void;
  info(category: string, message: string, data?: Record<string, unknown>): void;
  logDelta(delta: string, totalChars: number): void;
  logCommit(fullText: string, totalChars: number): void;
  isEnabled(): boolean;
}

class DebugLoggerImpl implements DebugLogger {
  private enabled = false;
  private modes: Set<string> = new Set();

  enable(mode: string): void {
    if (mode === "off") {
      this.enabled = false;
      this.modes.clear();
      return;
    }
    this.enabled = true;
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
    this.info("debug", `Debug mode enabled: ${mode}`, { modes: Array.from(this.modes) });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  info(category: string, message: string, data?: Record<string, unknown>): void {
    if (!this.enabled || !this.modes.has("info")) return;
    const timestamp = new Date().toISOString().split("T")[1]?.slice(0, 8) ?? "";
    const prefix = data
      ? `${timestamp} [${category}] ${message}`
      : `${timestamp} [${category}] ${message}`;
    if (data) {
      console.error(prefix, data);
    } else {
      console.error(prefix);
    }
  }

  logDelta(delta: string, totalChars: number): void {
    if (!this.enabled || !this.modes.has("text")) return;
    const preview = delta.length > 50 ? `${delta.slice(0, 50)}...` : delta;
    console.error(`[text_delta] "${preview}" (total: ${totalChars})`);
  }

  logCommit(fullText: string, totalChars: number): void {
    if (!this.enabled || !this.modes.has("commit")) return;
    const preview = fullText.length > 100 ? `${fullText.slice(0, 100)}...` : fullText;
    console.error(`[commit] "${preview}" (${totalChars} chars)`);
  }
}

export const debugLogger: DebugLogger = new DebugLoggerImpl();
