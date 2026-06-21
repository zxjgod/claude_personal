// ============================================================
// EffortPrompt — interactive /effort slider overlay (M13.7)
// ============================================================
// Mirrors Claude Code's /effort slider. Owns animation timing + key input;
// the per-frame visuals live in effort-fx.ts (buildEffortFrame).
//   • max       → rainbow flowing track + label
//   • ultracode → purple energy burst (halo, expanding ring, particles,
//                 edge glitch, breathing glow) — denser than max.
// ============================================================

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Overlay } from "./store.js";
import { buildEffortFrame, ORDER } from "./effort-fx.js";
import { terminalColumns } from "./../terminal-width.js";

export function EffortPrompt({
  overlay,
}: {
  overlay: Extract<Overlay, { kind: "effort" }>;
}) {
  const [idx, setIdx] = useState(Math.max(0, ORDER.indexOf(overlay.current)));
  const [phase, setPhase] = useState(0);

  const active = ORDER[idx]!;
  const animated = active === "max" || active === "ultracode";
  // Ultracode runs a brisker clock for a more intense, denser effect.
  const stepMs = active === "ultracode" ? 70 : 110;

  useEffect(() => {
    if (!animated) return;
    const t = setInterval(() => setPhase((p) => p + (active === "ultracode" ? 9 : 6)), stepMs);
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

  const lines = buildEffortFrame({ active, phase, cols: terminalColumns() });

  return (
    <Box flexDirection="column">
      {lines.map((ln, i) => (
        <Text key={i}>{ln.length > 0 ? ln : " "}</Text>
      ))}
    </Box>
  );
}
