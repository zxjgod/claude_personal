// ============================================================
// Tool-result summary — compact terminal line for a finished tool
// ============================================================
// The official Claude Code terminal does NOT dump a Read/Grep/Glob result's raw
// content. It shows a one-line summary ("Read 200 lines", "12 matches",
// "8 files") and keeps the full output behind an expand affordance. This module
// resolves that summary; the two renderers (line-based cli-renderer and the Ink
// ToolCard) share it so the two UIs never drift.
//
// Read/Grep/Glob set `metadata.summary` (display-only; the model still receives
// the full `content`). When a result has no summary — an error, or a tool like
// Bash/Edit/Write whose output IS the point — this returns null and the renderer
// falls back to a folded content preview.
// ============================================================

import type { ToolExecutionResult } from "../types.js";
import { sanitizeTerminalText } from "./terminal-width.js";

/**
 * Resolve the compact one-line summary for a finished tool result, or null when
 * the tool's raw output should be shown instead (Bash/Edit/Write, or any result
 * without a summary).
 */
export function toolResultSummary(result: ToolExecutionResult): string | null {
  const summary = result.result?.metadata?.summary;
  // Summary text is tool-controlled — sanitize before it reaches the terminal.
  return typeof summary === "string" ? sanitizeTerminalText(summary) : null;
}
