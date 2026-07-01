// ============================================================
// StatusLine — live working-status row (M23.2 / M23.3 / M23.8)
// ============================================================
// The single animated status row shown while the agent is busy, e.g.
//
//   ✶ Reading App.tsx (16s · ↑ 1.2k tokens)
//
// It mirrors the reference SpinnerWithVerb: an orange particle glyph, a label
// with a shimmer sweep, a live elapsed clock, and a real output-token count.
// The component owns ONE `setInterval` and re-renders only itself each frame —
// the <Static> transcript and the input box are never disturbed by the
// animation (this is the "isolated animation subtree" of M23.8).
//
// The label is computed by the caller (App) from the spinner mode + active
// tool, so this stays a dumb renderer. Pure pieces come from spinner-core.
// ============================================================

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import {
  computeGlimmerIndex,
  computeShimmerSegments,
  formatDuration,
  formatTokens,
  glyphAt,
  ORANGE_HEX,
  SHIMMER_HEX,
  SHIMMER_INTERVAL_MS,
  UP_ARROW,
  verbAt,
} from "./../spinner-core.js";
import { visualWidth } from "./../terminal-width.js";

// Redraw cadence for the status row's own clock. 80ms ≈ 12.5fps — enough for a
// smooth glyph/shimmer without spamming re-renders.
const TICK_MS = 80;

/** Split `label` into before/shimmer/after spans for the sweep at `elapsedMs`. */
export function shimmerParts(label: string, elapsedMs: number) {
  const width = visualWidth(label);
  const tick = Math.floor(elapsedMs / SHIMMER_INTERVAL_MS);
  const glimmer = computeGlimmerIndex(tick, width);
  return computeShimmerSegments(label, glimmer);
}

export function StatusLine({
  label,
  startedAt,
  tokens,
  cycleVerbs,
}: {
  /** Present-continuous status, e.g. "Thinking" or "Reading App.tsx". */
  label: string;
  /** Epoch ms when the turn began (0 ⇒ no clock yet). */
  startedAt: number;
  /** Live output-token estimate / count. */
  tokens: number;
  /** When true (pure thinking phase, no tool running), rotate through the
   *  playful gerunds instead of showing the static `label`. The verb advances
   *  every VERB_CYCLE_MS, seeded by `startedAt` so turns don't all start alike. */
  cycleVerbs?: boolean;
}) {
  // A monotonically increasing tick drives the clock + glyph + shimmer. We read
  // the wall clock on each tick rather than storing elapsed, so a paused render
  // can't drift.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const elapsedMs = startedAt > 0 ? Date.now() - startedAt : 0;
  const glyph = glyphAt(elapsedMs);
  // The thinking phase cycles verbs; every other phase keeps its concrete label
  // ("Reading App.tsx", "Responding") unchanged.
  const shown = cycleVerbs ? verbAt(elapsedMs, startedAt) : label;
  const { before, shimmer, after } = shimmerParts(shown, elapsedMs);

  const suffixParts: string[] = [formatDuration(elapsedMs)];
  if (tokens > 0) suffixParts.push(`${UP_ARROW} ${formatTokens(tokens)} tokens`);
  const suffix = ` (${suffixParts.join(" · ")})`;

  return (
    <Box>
      <Text color={ORANGE_HEX}>{glyph}</Text>
      <Text> </Text>
      <Text color={ORANGE_HEX}>{before}</Text>
      <Text color={SHIMMER_HEX}>{shimmer}</Text>
      <Text color={ORANGE_HEX}>{after}</Text>
      <Text dimColor>{suffix}</Text>
    </Box>
  );
}
