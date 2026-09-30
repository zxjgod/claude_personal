// ============================================================
// EffortPrompt — interactive /effort slider overlay (M13.7)
// ============================================================
// Mirrors Claude Code's /effort slider. Owns animation timing + key input;
// the per-frame visuals live in effort-fx.ts (buildEffortFrame).
// ============================================================

import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { buildEffortFrame, ORDER } from "./effort-fx.js";
import { isReducedMotion } from "./spinner-core.js";
import type { Overlay } from "./store.js";
import { terminalColumns } from "./terminal-width.js";

const FADE_FRAMES = 32;

export function EffortPrompt({ overlay }: { overlay: Extract<Overlay, { kind: "effort" }> }) {
  const [idx, setIdx] = useState(Math.max(0, ORDER.indexOf(overlay.current)));
  const [phase, setPhase] = useState(0);
  // Frame counter since the active tier last changed (drives fade-in).
  const [sinceSwitch, setSinceSwitch] = useState(0);
  // Synced selection ref (see RewindPicker): arrows and Enter can arrive in
  // ONE stdin chunk without a re-render between them — Enter must resolve
  // the tier the arrows actually moved to, not the render-time selection.
  const idxRef = useRef(idx);

  const active = ORDER[idx]!;
  const reducedMotion = isReducedMotion();
  const animated =
    !reducedMotion && (active === "xhigh" || active === "max" || active === "ultracode");
  const stepMs = active === "xhigh" ? 160 : active === "max" ? 60 : 70;

  useEffect(() => {
    if (!animated) return;
    const t = setInterval(() => {
      setPhase((p) => p + (active === "ultracode" ? 9 : active === "max" ? 20 : 1));
      setSinceSwitch((n) => Math.min(FADE_FRAMES, n + 1));
    }, stepMs);
    return () => clearInterval(t);
  }, [animated, active, stepMs]);

  const select = (n: number) => {
    if (idxRef.current === n) return;
    idxRef.current = n;
    setPhase(0);
    setSinceSwitch(0);
    setIdx(n);
  };

  useInput((input, key) => {
    if (key.leftArrow) select(Math.max(0, idxRef.current - 1));
    else if (key.rightArrow) select(Math.min(ORDER.length - 1, idxRef.current + 1));
    else if (key.return) overlay.resolve(ORDER[idxRef.current] ?? null);
    else if (key.escape) overlay.resolve(null);
    else if (/^[1-6]$/.test(input)) {
      const n = parseInt(input, 10) - 1;
      if (n < ORDER.length) select(n);
    }
  });

  const fade =
    active === "ultracode" && !reducedMotion ? Math.min(1, sinceSwitch / FADE_FRAMES) : 1;
  const lines = buildEffortFrame({ active, phase, cols: terminalColumns(), fade });

  return (
    <Box flexDirection="column">
      {lines.map((ln, i) => (
        <Text key={i}>{ln.length > 0 ? ln : " "}</Text>
      ))}
    </Box>
  );
}
