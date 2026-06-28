// ============================================================
// ToolCard — live + completed tool rendering with collapse (9.3 / 9.4)
// ============================================================
// A completed tool is shown as "● Name(detail)" followed by a "⎿ result"
// branch. Long results (read/grep) collapse to a preview with a hint; the
// active row (ctrl+r) can toggle expansion via the App's expanded set.
// ============================================================

import { Box, Text } from "ink";
import type React from "react";
import { actionLabel } from "./../spinner-core.js";
import type { ToolExecutionResult } from "./../types.js";
import { SpinnerGlyph } from "./SpinnerGlyph.js";

const ORANGE = "#d77757";
const PREVIEW_LINES = 12;

function colorizeLine(line: string): React.ReactNode {
  if (line.startsWith("+ ")) return <Text color="green">{line}</Text>;
  if (line.startsWith("- ")) return <Text color="red">{line}</Text>;
  if (line.startsWith("Error:")) return <Text color="red">{line}</Text>;
  return <Text>{line}</Text>;
}

/** The live "tool is running" card: shared orange glyph + concrete action. */
export function ActiveToolCard({ name, detail }: { name: string; detail: string }) {
  return (
    <Box>
      <SpinnerGlyph />
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
      <Text color={ORANGE}>●</Text>
      <Text bold> {capitalize(result.toolName)}</Text>
      {detail ? <Text dimColor>({truncate(detail, 100)})</Text> : null}
    </Box>
  );

  if (result.error) {
    return (
      <Box flexDirection="column">
        {title}
        <Box>
          <Text dimColor>{"  ⎿ "}</Text>
          <Text color="red">{result.error}</Text>
        </Box>
      </Box>
    );
  }

  const allLines = (result.formatted ?? "").split("\n");
  const isLong = allLines.length > PREVIEW_LINES;
  const shown = expanded || !isLong ? allLines : allLines.slice(0, PREVIEW_LINES);

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
        {isLong && !expanded ? (
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
