// ============================================================
// streaming-hooks.ts — Integrate RuntimeMonitor into TUI stream
// ============================================================
// Hooks the runtime monitor into the TUI streaming pipeline to capture
// detailed logs about streaming, rendering, and state changes.
//
// Usage in TUI code:
//
//   import { enableDebug, logDelta, logFlush, logCommit, logRender } from './debug-logs/streaming-hooks.js';
//
//   // At the start of a turn:
//   enableDebug('info');  // or 'verbose' for full detail
//
//   // In the stream processing loop:
//   streamBuffer.push(event.delta);
//   logDelta(event.delta, streamingText.length);
//
//   // In the render component:
//   logRender({ text, stablePrefix, unstableSuffix, tokenCount, blockCount });
//
//   // On commit:
//   logCommit(streamingText, streamingText.length);
//
//   // At the end:
//   runtimeMonitor.disable();
//
// ============================================================

import { disableDebug, enableDebug, runtimeMonitor } from "./runtime-monitor.js";

// Re-export for convenience
export {
  disableDebug,
  enableDebug,
  logBoundary,
  logCommit,
  logDelta,
  logFlush,
  logRender,
  logStoreChange,
  runtimeMonitor,
} from "./runtime-monitor.js";

import type { LogLevel } from "./runtime-monitor.js";

/**
 * Auto-enable debug mode based on environment variable.
 * Call this once at app startup.
 */
export function autoEnableDebugFromEnv(): void {
  const envLevel = process.env.DEBUG_STREAM?.toLowerCase();
  if (envLevel && envLevel !== "off" && ["info", "warn", "debug", "verbose"].includes(envLevel)) {
    console.error(`[debug] Auto-enabling runtime monitor with level: ${envLevel}`);
    runtimeMonitor.enable(envLevel as LogLevel);
  }
}

/**
 * Create a debug wrapper for the StreamBuffer class.
 * Wraps the push and flush methods to log all activity.
 */
export function createDebugStreamBuffer(
  originalPush: (delta: string) => void,
  originalFlush: () => void,
  getStreamingText: () => string,
) {
  return {
    push: (delta: string): void => {
      originalPush(delta);
      runtimeMonitor.logDelta(delta, getStreamingText().length);
    },
    flush: (): void => {
      const pending = getStreamingText().length;
      originalFlush();
      runtimeMonitor.logFlush(pending);
    },
  };
}

/**
 * Create a debug wrapper for the TuiStore.
 * Wraps set/push methods to log state changes.
 */
export function createDebugStoreWrapper(store: {
  getSnapshot: () => Record<string, unknown>;
  set: (patch: Record<string, unknown>) => void;
}) {
  const origGetSnapshot = store.getSnapshot.bind(store);
  const origSet = store.set.bind(store);
  let lastSnapshot: Record<string, unknown> = {};

  return {
    getSnapshot: (): Record<string, unknown> => {
      const snapshot = origGetSnapshot();

      // Log changes
      for (const key of Object.keys(snapshot)) {
        const oldVal = lastSnapshot[key];
        const newVal = snapshot[key];

        if (oldVal !== newVal) {
          // Only log string changes that look like streaming content
          if (
            key === "streamingText" &&
            typeof newVal === "string" &&
            (newVal as string).length > 0
          ) {
            runtimeMonitor.logStoreChange(key, oldVal, newVal);
          }
        }
      }

      lastSnapshot = { ...snapshot };
      return snapshot;
    },
    set: (patch: Record<string, unknown>): void => {
      origSet(patch);
    },
  };
}

/**
 * Log a StreamingMarkdown render event with full details.
 */
export function logStreamingMarkdownRender(
  children: string,
  stablePrefix: string,
  unstableSuffix: string,
  tokenCount: number,
): void {
  runtimeMonitor.logRender({
    text: children,
    textLen: children.length,
    stablePrefix,
    stablePrefixLen: stablePrefix.length,
    unstableSuffix,
    unstableSuffixLen: unstableSuffix.length,
    tokenCount,
    blockCount: 0, // Calculated by marked.lexer
  });
}

/**
 * Generate a markdown report from captured snapshots.
 */
export function generateDebugReport(): string {
  return runtimeMonitor.generateSummary();
}

/**
 * Get the current snapshots for external analysis.
 */
export function getDebugSnapshots() {
  return runtimeMonitor.getSnapshots();
}
