// ============================================================
// ToolCard — live + completed tool rendering with collapse (9.3 / 9.4)
// ============================================================
// A completed tool is shown as "● Name(detail)" followed by a "⎿ result"
// branch. Long results (read/grep) collapse to a preview with a hint; the
// active row (ctrl+r) can toggle expansion via the App's expanded set.
//
// M26: Tool status indicator:
// - Active tool (executing): gray blinking dot
// - Completed tool: green static dot
// ============================================================

import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { parseError } from "../tui/markdown.js";
import type { ToolExecutionResult } from "./../types.js";
import { actionLabel, STATUS_GRAY, STATUS_GRAY_BRIGHT, STATUS_GREEN } from "./spinner-core.js";
import { palette } from "./theme.js";
import { toolResultSummary } from "./tool-result-summary.js";

const PREVIEW_LINES = 12;

function colorizeLine(line: string): React.ReactNode {
  if (line.startsWith("+ ")) return <Text color={palette.success}>{line}</Text>;
  if (line.startsWith("- ")) return <Text color={palette.error}>{line}</Text>;
  if (line.startsWith("Error:")) return <Text color={palette.error}>{line}</Text>;
  return <Text>{line}</Text>;
}

/** Tool status glyph: gray blinking while executing, green static when done */
function ToolStatusGlyph({ isActive }: { isActive: boolean }) {
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!isActive) return;
    // Blink between gray and bright-gray at ~500ms interval
    const t = setInterval(() => setFlash((f) => !f), 500);
    return () => clearInterval(t);
  }, [isActive]);

  if (isActive) {
    return <Text color={flash ? STATUS_GRAY_BRIGHT : STATUS_GRAY}>●</Text>;
  } else {
    return <Text color={STATUS_GREEN}>●</Text>;
  }
}

/** The live "tool is running" card: gray blinking glyph + concrete action. */
export function ActiveToolCard({ name, detail }: { name: string; detail: string }) {
  return (
    <Box>
      <ToolStatusGlyph isActive={true} />
      <Text> {actionLabel(name, detail)}</Text>
    </Box>
  );
}

export function CompletedToolCard({
  result,
  detail,
  expanded,
}: {
  result: ToolExecutionResult;
  detail: string;
  expanded: boolean;
}) {
  const title = (
    <Box>
      <ToolStatusGlyph isActive={false} />
      <Text bold> {capitalize(result.toolName)}</Text>
      {detail ? <Text dimColor>({truncate(detail, 100)})</Text> : null}
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

  const allLines = (result.formatted ?? "").split("\n");
  const isLong = allLines.length > PREVIEW_LINES;

  // Read/Grep/Glob collapse to a single summary line ("Read N lines"); expanding
  // (or a tool whose output IS the point, like Bash/Edit/Write) shows content.
  const summary = toolResultSummary(result);
  const collapsedToSummary = !!summary && !expanded;
  const shown = collapsedToSummary
    ? [summary]
    : expanded || !isLong
      ? allLines
      : allLines.slice(0, PREVIEW_LINES);

  return (
    <Box flexDirection="column">
      {title}
      <Box flexDirection="column" paddingLeft={2}>
        {shown.map((line, i) => (
          <Box key={i}>
            <Text dimColor>{i === 0 ? "⎿ " : "  "}</Text>
            {colorizeLine(line)}
          </Box>
        ))}
        {collapsedToSummary && allLines.length > 0 ? (
          <Text dimColor>{`  (ctrl+r to expand)`}</Text>
        ) : isLong && !expanded ? (
          <Text dimColor>{`  … +${allLines.length - PREVIEW_LINES} lines (ctrl+r to expand)`}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
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
        <Text dimColor>{"  ⎿ "}</Text>
        <Text color={errorColor} bold>
          {parsed.type}
        </Text>
      </Box>
      <Box paddingLeft={4}>
        <Text>{parsed.message}</Text>
      </Box>
      {stack && (
        <Box flexDirection="column" paddingLeft={4}>
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
