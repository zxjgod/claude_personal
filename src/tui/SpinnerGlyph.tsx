// ============================================================
// SpinnerGlyph — isolated animated particle glyph (M23.2 / M23.8)
// ============================================================
// The orange particle glyph (·✢✶✻✽…) on its own frame clock. It owns its
// `setInterval`, so an animation tick re-renders only this tiny leaf — it never
// touches the <Static> transcript or the input box. Used by both the status
// line and the active tool cards so the whole TUI shares one glyph + colour.
// ============================================================

import { Text } from "ink";
import { useEffect, useState } from "react";
import { GLYPH_FRAME_MS, ORANGE_HEX, SPINNER_FRAMES } from "./../spinner-core.js";

export function SpinnerGlyph({ color = ORANGE_HEX }: { color?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % SPINNER_FRAMES.length), GLYPH_FRAME_MS);
    return () => clearInterval(t);
  }, []);
  return <Text color={color}>{SPINNER_FRAMES[i]}</Text>;
}
