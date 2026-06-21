// ============================================================
// ParticleSpinner — thinking/responding glyph (M13.7)
// ============================================================
// Cycles the official particle charset ['·','✢','✳','✶','✻','✽'] forwards
// then backwards, on a single frame clock (mirrors the CLI spinner + the
// reference Spinner glyph set).
// ============================================================

import React, { useEffect, useState } from "react";
import { Text } from "ink";

const BASE = ["·", "✢", "✳", "✶", "✻", "✽"];
const FRAMES = [...BASE, ...[...BASE].reverse()];
const FRAME_MS = 120;

export function ParticleSpinner({ color = "yellow" }: { color?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(t);
  }, []);
  return <Text color={color}>{FRAMES[i]}</Text>;
}
