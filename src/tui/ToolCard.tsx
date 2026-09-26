// ============================================================
// ToolCard — live + completed tool rendering with collapse (9.3 / 9.4)
// ============================================================
// A completed tool is shown as "⏺ Name(detail)" followed by a "⎿ result"
// branch. Long results (read/grep) collapse to a preview whose hint points at
// the verbose transcript viewer (ctrl+o) — the viewer is the ONLY full-output
// path (#45: the never-wired ctrl+r "expanded copy" mechanism was removed
// rather than kept as dead code).
//
// M26: Tool status indicator:
// - Active tool (executing): gray blinking dot
// - Completed tool: green static dot
// ============================================================

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { ToolExecutionResult } from "./../types.js";
import { BLACK_CIRCLE, TOOL_RESULT } from "./figures.js";
import { t } from "./i18n.js";
import { parseError } from "./markdown.js";
import {
  actionLabel,
  formatDuration,
  isReducedMotion,
  STATUS_GRAY,
  STATUS_GRAY_BRIGHT,
} from "./spinner-core.js";
import { truncateVisual } from "./terminal-width.js";
import { palette } from "./theme.js";
import { toolOutputLines } from "./tool-output.js";
import { toolResultSummary } from "./tool-result-summary.js";

const PREVIEW_LINES = 12;

/**
 * True when a completed card renders collapsed with an expand hint — i.e.
 * ctrl+o (the verbose transcript viewer) would reveal more content. Mirrors
 * the collapse logic inside CompletedToolCard (summary-collapse OR clipped
 * preview); exported so tests can assert expandability without duplicating
 * the rule.
 */
export function isToolExpandable(result: ToolExecutionResult): boolean {
  if (result.error) return false;
  if (toolResultSummary(result)) return true;
  return (result.formatted ?? "").split("\n").length > PREVIEW_LINES;
}

/** Tool status glyph: gray blinking while executing, green static when done,
 *  RED when the tool failed (official three-state dot: dim→green/red).
 *  The blink is decorative — under reduced motion (CCR_REDUCED_MOTION=1) the
 *  dot stays a static gray instead. */
function ToolStatusGlyph({ isActive, isError }: { isActive: boolean; isError?: boolean }) {
  const [flash, setFlash] = useState(false);
  const reduced = isReducedMotion();

  useEffect(() => {
    if (!isActive || reduced) return;
    // Blink between gray and bright-gray at ~500ms interval
    const t = setInterval(() => setFlash((f) => !f), 500);
    return () => clearInterval(t);
  }, [isActive, reduced]);

  if (isActive) {
    return <Text color={flash ? STATUS_GRAY_BRIGHT : STATUS_GRAY}>{BLACK_CIRCLE}</Text>;
  } else {
    return <Text color={isError ? palette.error : palette.success}>{BLACK_CIRCLE}</Text>;
  }
}

/**
 * The live "tool is running" card: gray blinking glyph + concrete action +
 * a running elapsed clock ("Reading App.tsx (12s)") so a long npm install
 * shows how long it's been running, not just that it started. ONE interval
 * drives both the blink and the seconds; under reduced motion the blink is
 * off but the clock keeps ticking — elapsed time is information, not
 * decoration.
 */
export function ActiveToolCard({
  name,
  detail,
  startedAt,
}: {
  name: string;
  detail: string;
  startedAt?: number;
}) {
  const reduced = isReducedMotion();
  const [flash, setFlash] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      setTick((n) => n + 1);
      if (!reduced) setFlash((f) => !f);
    }, 500);
    return () => clearInterval(t);
  }, [reduced]);

  const elapsed = startedAt ? ` (${formatDuration(Date.now() - startedAt)})` : "";
  return (
    <Box>
      <Text color={reduced || !flash ? STATUS_GRAY : STATUS_GRAY_BRIGHT}>{BLACK_CIRCLE}</Text>
      <Text>
        {` ${actionLabel(name, detail)}`}
        {elapsed ? <Text dimColor>{elapsed}</Text> : null}
      </Text>
    </Box>
  );
}

export function CompletedToolCard({
  result,
  detail,
}: {
  result: ToolExecutionResult;
  detail: string;
}) {
  // Official head: `⏺ Name(detail)` — colored glyph + BOLD plain-color name
  // (the head itself carries no accent tint). Failed tools get the red dot.
  const title = (
    <Box>
      <ToolStatusGlyph isActive={false} isError={!!result.error} />
      <Text color={palette.text} bold>
        {" "}
        {capitalize(result.toolName)}
      </Text>
      {detail ? <Text color={palette.text}>({truncate(detail, 100)})</Text> : null}
    </Box>
  );

  if (result.error) {
    return (
      <Box flexDirection="column">
        {title}
        <StructuredError error={result.error} />
      </Box>
    );
  }

  const allLines = toolOutputLines(result, detail);
  const isLong = allLines.length > PREVIEW_LINES;

  // Read/Grep/Glob collapse to a single summary line ("Read N lines"); a tool
  // whose output IS the point (Bash/Edit/Write) shows content, clipped to the
  // preview window — ctrl+o reveals the rest.
  const summary = toolResultSummary(result);
  const collapsedToSummary = !!summary;
  const shown = collapsedToSummary
    ? [summary]
    : isLong
      ? allLines.slice(0, PREVIEW_LINES)
      : allLines;

  return (
    <Box flexDirection="column">
      {title}
      {/* Official branch geometry: two spaces + ⎿ + two spaces on the first
          line, continuation lines indented to the same content column. */}
      <Box flexDirection="column" paddingLeft={2}>
        {shown.map((line, i) => (
          <Box key={i}>
            <Text color={palette.muted}>{i === 0 ? `${TOOL_RESULT}  ` : "   "}</Text>
            <Text color={palette.text}>{line}</Text>
          </Box>
        ))}
        {collapsedToSummary && allLines.length > 0 ? (
          <Text dimColor>{`  ${t("ui.tool.expandHint")}`}</Text>
        ) : isLong ? (
          <Text
            dimColor
          >{`  ${t("ui.tool.expandMore", { n: allLines.length - PREVIEW_LINES })}`}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

function truncate(value: string, max: number): string {
  // P3-15: column-aware truncation (see truncateVisual).
  return truncateVisual(value, max);
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

/** Get error color based on type */
function getErrorColor(type: string): string {
  if (type.includes("Permission")) return palette.error;
  if (type.includes("TypeScript")) return "#f0883e"; // amber
  return palette.error;
}

/** Structured error display with type, message, and optional stack.
 *  Uses the shared parseError function from markdown.ts. */
function StructuredError({ error }: { error: string }) {
  const parsed = parseError(error);
  const errorColor = getErrorColor(parsed.type);

  // Extract stack trace if present (max 3 lines)
  const stackMatch = error.match(/\n\s+at\s+.+/g);
  const stack = stackMatch ? stackMatch.slice(0, 3) : undefined;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        {/* Official branch geometry: ⎿ + two spaces, content at column 5 —
            matches the normal result body above (was 2+⎿+1, off by two). */}
        <Text dimColor>{`${TOOL_RESULT}  `}</Text>
        <Text color={errorColor} bold>
          {parsed.type}
        </Text>
      </Box>
      <Box paddingLeft={3}>
        <Text>{parsed.message}</Text>
      </Box>
      {stack && (
        <Box flexDirection="column" paddingLeft={3}>
          {stack.map((line, i) => (
            <Text key={i} dimColor>
              {line.trim()}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
