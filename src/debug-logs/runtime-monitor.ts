// ============================================================
// runtime-monitor.ts — Streaming & Rendering Diagnostics
// ============================================================
// Generates detailed runtime logs for debugging streaming issues.
// Logs are written to: debug-logs/runtime-YYYY-MM-DD_HH-mm-ss.log
//
// Usage:
//   1. Enable logging: set DEBUG_STREAM=1 or DEBUG_STREAM=verbose
//   2. Or import and call RuntimeMonitor.enable('verbose')
//   3. Run your test
//   4. Check debug-logs/ for the log files
//
// Log levels:
//   - 'info': Basic events (stream start, text delta, commit)
//   - 'warn': Suspicious patterns (rapid updates, unusual boundaries)
//   - 'debug': Detailed timing and state snapshots
//   - 'verbose': Every character delta + render cycle
// ============================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type LogLevel = "info" | "warn" | "debug" | "verbose" | "off";

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  category: string;
  message: string;
  data?: unknown;
}

export interface StreamSnapshot {
  streamingText: string;
  streamingTextLen: number;
  delta: string;
  deltaLen: number;
  tokens: number;
}

export interface RenderSnapshot {
  text: string;
  textLen: number;
  stablePrefix: string;
  stablePrefixLen: number;
  unstableSuffix: string;
  unstableSuffixLen: number;
  tokenCount: number;
  blockCount: number;
}

class RuntimeMonitor {
  private static instance: RuntimeMonitor | null = null;
  private logFile: string | null = null;
  private level: LogLevel = "off";
  private entries: LogEntry[] = [];
  private streamSnapshots: StreamSnapshot[] = [];
  private renderSnapshots: RenderSnapshot[] = [];
  private streamStartTime = 0;
  private lastDeltaTime = 0;
  private deltaCount = 0;
  private totalChars = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  static getInstance(): RuntimeMonitor {
    if (!RuntimeMonitor.instance) {
      RuntimeMonitor.instance = new RuntimeMonitor();
    }
    return RuntimeMonitor.instance;
  }

  /**
   * Enable runtime monitoring and start logging to a file.
   * @param level Log verbosity level
   * @param customPath Optional custom log file path
   */
  enable(level: LogLevel = "info", customPath?: string): void {
    if (this.level !== "off") return; // Already enabled

    this.level = level;
    this.streamStartTime = Date.now();
    this.deltaCount = 0;
    this.totalChars = 0;

    // Create log file with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logDir = customPath || path.join(process.cwd(), "debug-logs");

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    this.logFile = path.join(logDir, `runtime-${timestamp}.log`);

    // Write header
    const header = this.generateHeader();
    fs.writeFileSync(this.logFile, header);

    this.info("monitor", "=== Runtime Monitor Started ===");
    this.info("monitor", `Log file: ${this.logFile}`);
    this.info("monitor", `Log level: ${level}`);
    this.info("monitor", `Platform: ${os.platform()} ${os.release()}`);
    this.info("monitor", `Node: ${process.version}`);
    this.info("monitor", `CWD: ${process.cwd()}`);

    // Start periodic flush (every 5 seconds)
    this.flushTimer = setInterval(() => this.flush(), 5000);

    // Check env var
    const envLevel = process.env.DEBUG_STREAM?.toLowerCase();
    if (envLevel && envLevel !== "off") {
      if (["info", "warn", "debug", "verbose"].includes(envLevel)) {
        this.level = envLevel as LogLevel;
        this.info("monitor", `Overridden by DEBUG_STREAM env: ${this.level}`);
      }
    }
  }

  disable(): void {
    if (this.level === "off") return;

    this.info("monitor", "=== Runtime Monitor Stopped ===");
    this.flush();

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.level = "off";
    this.logFile = null;
  }

  private generateHeader(): string {
    const lines = [
      "=".repeat(70),
      "RUNTIME MONITOR LOG",
      "=".repeat(70),
      `Generated: ${new Date().toISOString()}`,
      `PID: ${process.pid}`,
      "",
      "Categories:",
      "  [stream]    - Text streaming events (delta, commit, flush)",
      "  [render]    - Markdown rendering events",
      "  [store]     - Store state changes",
      "  [boundary]  - Block boundary detection",
      "  [timing]    - Performance measurements",
      "  [warn]      - Suspicious patterns",
      "  [monitor]   - Monitor lifecycle events",
      "",
      "Legend:",
      "  → = delta received",
      "  ✓ = block settled",
      "  ◉ = commit",
      "  ⚠ = warning",
      "",
      "=".repeat(70),
      "",
    ];
    return lines.join("\n");
  }

  private shouldLog(level: LogLevel): boolean {
    if (this.level === "off") return false;
    const levels: LogLevel[] = ["info", "warn", "debug", "verbose"];
    const currentIdx = levels.indexOf(this.level);
    const entryIdx = levels.indexOf(level);
    return entryIdx <= currentIdx;
  }

  private formatEntry(entry: LogEntry): string {
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    const levelStr = entry.level.padEnd(7).slice(0, 7);
    const catStr = `[${entry.category.padEnd(8)}]`;

    let line = `${time} ${levelStr} ${catStr} ${entry.message}`;

    if (entry.data !== undefined) {
      if (this.level === "verbose") {
        line += "\n  Data: " + JSON.stringify(entry.data, null, 2).replace(/\n/g, "\n  ");
      } else {
        line += " | " + JSON.stringify(entry.data);
      }
    }

    return line;
  }

  private write(line: string): void {
    if (this.logFile) {
      fs.appendFileSync(this.logFile, line + "\n");
    }
    this.entries.push({
      timestamp: Date.now(),
      level: this.level,
      category: "raw",
      message: line,
    });
  }

  private flush(): void {
    if (this.entries.length === 0) return;

    // Write all buffered entries
    const lines = this.entries.map((e) => this.formatEntry(e));
    if (this.logFile && lines.length > 0) {
      fs.appendFileSync(this.logFile, lines.join("\n") + "\n");
    }

    this.entries = [];
  }

  private log(level: LogLevel, category: string, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = { timestamp: Date.now(), level, category, message, data };
    this.entries.push(entry);

    // Also log to stderr for real-time viewing
    if (process.env.DEBUG_STREAM === "verbose") {
      console.error(`[${category}] ${message}`, data !== undefined ? data : "");
    }
  }

  info(category: string, message: string, data?: unknown): void {
    this.log("info", category, message, data);
  }

  warn(category: string, message: string, data?: unknown): void {
    this.log("warn", category, message, data);
  }

  debug(category: string, message: string, data?: unknown): void {
    this.log("debug", category, message, data);
  }

  verbose(category: string, message: string, data?: unknown): void {
    this.log("verbose", category, message, data);
  }

  // --- Stream-specific logging ---

  /**
   * Log a text delta event from the stream.
   */
  logDelta(delta: string, totalSoFar: number): void {
    this.deltaCount++;
    const now = Date.now();
    const elapsed = this.lastDeltaTime > 0 ? now - this.lastDeltaTime : 0;
    this.lastDeltaTime = now;
    this.totalChars += delta.length;

    if (this.level === "verbose") {
      this.verbose(
        "stream",
        `→ delta #${this.deltaCount} (+${delta.length} chars, total: ${totalSoFar}, gap: ${elapsed}ms)`,
        {
          delta: delta.length > 100 ? delta.slice(0, 100) + "..." : delta,
          elapsed,
        },
      );
    } else if (this.level === "debug") {
      this.debug(
        "stream",
        `→ delta #${this.deltaCount} (+${delta.length} chars, total: ${totalSoFar})`,
        {
          deltaPreview: delta.slice(0, 50),
          elapsed,
        },
      );
    }

    // Track snapshots for analysis
    this.streamSnapshots.push({
      streamingText: "",
      streamingTextLen: totalSoFar,
      delta,
      deltaLen: delta.length,
      tokens: Math.round(totalSoFar / 4),
    });

    // Warn if rapid updates (>50ms apart is normal, <10ms is rapid)
    if (elapsed > 0 && elapsed < 10 && this.deltaCount > 5) {
      this.warn("timing", `⚠ Rapid delta (${elapsed}ms gap)`, { deltaCount: this.deltaCount });
    }
  }

  /**
   * Log a stream flush event.
   */
  logFlush(bufferedChars: number): void {
    this.info("stream", `○ flush (${bufferedChars} chars buffered)`);
  }

  /**
   * Log a stream commit event.
   */
  logCommit(text: string, charCount: number): void {
    const duration = Date.now() - this.streamStartTime;
    this.info(
      "stream",
      `◉ commit (${charCount} chars in ${duration}ms, ${this.deltaCount} deltas)`,
    );

    // Summary
    const summary = {
      totalChars: this.totalChars,
      totalDeltas: this.deltaCount,
      duration,
      charsPerSecond: Math.round((charCount / duration) * 1000),
    };
    this.info("stream", "Stream summary", summary);

    // Reset for next stream
    this.streamStartTime = Date.now();
    this.deltaCount = 0;
    this.totalChars = 0;
  }

  /**
   * Log a rendering event.
   */
  logRender(snapshot: RenderSnapshot): void {
    this.renderSnapshots.push(snapshot);

    if (this.level === "verbose") {
      this.verbose(
        "render",
        `render (text: ${snapshot.textLen}, stable: ${snapshot.stablePrefixLen}, unstable: ${snapshot.unstableSuffixLen})`,
        {
          stablePreview: snapshot.stablePrefix.slice(-50),
          unstablePreview: snapshot.unstableSuffix.slice(-50),
          tokenCount: snapshot.tokenCount,
          blockCount: snapshot.blockCount,
        },
      );
    }

    // Check for unusual patterns
    if (snapshot.stablePrefixLen > snapshot.textLen) {
      this.warn("boundary", "⚠ Stable prefix longer than text (possible reset)", {
        textLen: snapshot.textLen,
        stableLen: snapshot.stablePrefixLen,
      });
    }

    if (snapshot.stablePrefixLen > 0 && snapshot.unstableSuffixLen === 0) {
      this.warn("render", "⚠ Entire text marked as stable (no in-progress block)", {
        textLen: snapshot.textLen,
      });
    }
  }

  /**
   * Log store state change.
   */
  logStoreChange(field: string, oldValue: unknown, newValue: unknown): void {
    if (this.level === "verbose") {
      this.verbose("store", `state.${field} changed`, {
        from:
          typeof oldValue === "string" && oldValue.length > 100
            ? oldValue.slice(0, 100) + "..."
            : oldValue,
        to:
          typeof newValue === "string" && (newValue as string).length > 100
            ? (newValue as string).slice(0, 100) + "..."
            : newValue,
      });
    }
  }

  /**
   * Log block boundary detection.
   */
  logBoundary(detected: number, settled: number, total: number): void {
    this.debug(
      "boundary",
      `✓ ${detected} blocks detected, ${settled} settled, ${total} total chars`,
      {
        detectedBlocks: detected,
        settledChars: settled,
        totalChars: total,
      },
    );
  }

  /**
   * Generate a summary report.
   */
  generateSummary(): string {
    const lines = [
      "",
      "=".repeat(70),
      "RUNTIME SUMMARY",
      "=".repeat(70),
      `Stream snapshots: ${this.streamSnapshots.length}`,
      `Render snapshots: ${this.renderSnapshots.length}`,
      "",
    ];

    if (this.streamSnapshots.length > 0) {
      const totalChars = this.streamSnapshots.reduce((sum, s) => sum + s.deltaLen, 0);
      const avgDelta = totalChars / this.streamSnapshots.length;
      lines.push(`Total chars streamed: ${totalChars}`);
      lines.push(`Average delta size: ${avgDelta.toFixed(1)} chars`);
      lines.push(`Delta count: ${this.streamSnapshots.length}`);
    }

    if (this.renderSnapshots.length > 0) {
      lines.push(`Render count: ${this.renderSnapshots.length}`);

      // Check for instability
      const instabilities = this.renderSnapshots.filter(
        (s) => s.stablePrefixLen > s.textLen || s.stablePrefixLen < 0 || s.unstableSuffixLen < 0,
      );
      if (instabilities.length > 0) {
        lines.push(`⚠ Instability detected: ${instabilities.length} suspicious renders`);
      }
    }

    lines.push("=".repeat(70));
    return lines.join("\n");
  }

  /**
   * Get all snapshots for analysis.
   */
  getSnapshots(): { streams: StreamSnapshot[]; renders: RenderSnapshot[] } {
    return {
      streams: [...this.streamSnapshots],
      renders: [...this.renderSnapshots],
    };
  }
}

// Export singleton instance
export const runtimeMonitor = RuntimeMonitor.getInstance();

// Export convenience functions
export function enableDebug(level: LogLevel = "info"): void {
  runtimeMonitor.enable(level);
}

export function disableDebug(): void {
  runtimeMonitor.disable();
}

export function logDelta(delta: string, totalSoFar: number): void {
  runtimeMonitor.logDelta(delta, totalSoFar);
}

export function logFlush(bufferedChars: number): void {
  runtimeMonitor.logFlush(bufferedChars);
}

export function logCommit(text: string, charCount: number): void {
  runtimeMonitor.logCommit(text, charCount);
}

export function logRender(snapshot: RenderSnapshot): void {
  runtimeMonitor.logRender(snapshot);
}

export function logStoreChange(field: string, oldValue: unknown, newValue: unknown): void {
  runtimeMonitor.logStoreChange(field, oldValue, newValue);
}

export function logBoundary(detected: number, settled: number, total: number): void {
  runtimeMonitor.logBoundary(detected, settled, total);
}
