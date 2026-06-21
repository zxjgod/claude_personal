// ============================================================
// EffortPrompt — interactive /effort slider overlay (M13.7)
// ============================================================
// Mirrors Claude Code's /effort slider. Owns animation timing + key input;
// the per-frame visuals live in effort-fx.ts (buildEffortFrame).
//   • max       → official rainbow flow on track + label
//   • ultracode → full-panel violet pixel gradient + vertical glitch jitter +
//                 bloom glow + fade-in diffusion on entry.
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Overlay } from "./store.js";
import { buildEffortFrame, ORDER } from "./effort-fx.js";
import { terminalColumns } from "./../terminal-width.js";

// Frames of fade-in diffusion when switching INTO an animated tier.
const FADE_FRAMES = 12;

export function EffortPrompt({
  overlay,
}: {
  overlay: Extract<Overlay, { kind: "effort" }>;
}) {
  const [idx, setIdx] = useState(Math.max(0, ORDER.indexOf(overlay.current)));
  const [phase, setPhase] = useState(0);
  // Frame counter since the active tier last changed (drives fade-in).
  const [sinceSwitch, setSinceSwitch] = useState(0);
  const prevIdx = useRef(idx);

  const active = ORDER[idx]!;
  const animated = active === "max" || active === "ultracode";
  // Ultracode runs a brisker clock for a denser, more intense field.
  const stepMs = active === "ultracode" ? 70 : 110;

  // Reset the fade counter whenever the selected tier changes.
  if (prevIdx.current !== idx) {
    prevIdx.current = idx;
    if (sinceSwitch !== 0) setSinceSwitch(0);
  }

  useEffect(() => {
    if (!animated) return;
    const t = setInterval(() => {
      setPhase((p) => p + (active === "ultracode" ? 9 : 6));
      setSinceSwitch((n) => Math.min(FADE_FRAMES, n + 1));
    }, stepMs);
    return () => clearInterval(t);
  }, [animated, active, stepMs]);

  useInput((input, key) => {
    if (key.leftArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.rightArrow) setIdx((i) => Math.min(ORDER.length - 1, i + 1));
    else if (key.return) overlay.resolve(active);
    else if (key.escape) overlay.resolve(null);
    else if (/^[1-6]$/.test(input)) {
      const n = parseInt(input, 10) - 1;
      if (n < ORDER.length) setIdx(n);
    }
  });

  const fade = active === "ultracode" ? Math.min(1, sinceSwitch / FADE_FRAMES) : 1;
  const lines = buildEffortFrame({ active, phase, cols: terminalColumns(), fade });

  return (
    <Box flexDirection="column">
      {lines.map((ln, i) => (
        <Text key={i}>{ln.length > 0 ? ln : " "}</Text>
      ))}
    </Box>
  );
}
