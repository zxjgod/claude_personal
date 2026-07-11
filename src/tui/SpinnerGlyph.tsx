// ============================================================
// SpinnerGlyph — isolated animated particle glyph (M23.2 / M23.8)
// ============================================================
// The orange particle glyph (·✢✶✻✽…) on its own frame clock. It owns its
// `setInterval`, so an animation tick re-renders only this tiny leaf — it never
// touches the <Static> transcript or the input box. Used by both the status
// line and the active tool cards so the whole TUI shares one glyph + colour.
//
// M26: Extended to support different colors and animation states:
// - blink (default): animated spinner frames (·✢✶✻✽…)
// - static: fixed bullet glyph (●) with a fixed color — used for completed tools
// ============================================================

import { Text } from "ink";
import { useEffect, useState } from "react";
import { GLYPH_FRAME_MS, SPINNER_FRAMES } from "./spinner-core.js";

export type AnimationMode = "blink" | "static";

export interface SpinnerGlyphProps {
  /** Color of the glyph */
  color?: string;
  /** Animation mode: blink = animated frames, static = single dot */
  animation?: AnimationMode;
}

export function SpinnerGlyph({ color = "#d77757", animation = "blink" }: SpinnerGlyphProps) {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (animation !== "blink") return;
    const t = setInterval(() => setI((n) => (n + 1) % SPINNER_FRAMES.length), GLYPH_FRAME_MS);
    return () => clearInterval(t);
  }, [animation]);

  // static: fixed bullet glyph; blink: animated spinner frames.
  const glyph = animation === "static" ? "●" : SPINNER_FRAMES[i];
  return <Text color={color}>{glyph}</Text>;
}
