// ============================================================
// Terminal width — visual column measurement + ANSI helpers
// ============================================================
// A tiny replacement for the `string-width` / `strip-ansi` packages so the
// spinner and table renderers can size text correctly without new deps.
// CJK / fullwidth glyphs and most emoji count as 2 columns; zero-width and
// combining marks count as 0. Grapheme clustering uses Intl.Segmenter when
// available so emoji + ZWJ sequences are measured as a single unit.
// ============================================================

// Matches ANSI SGR / cursor escape sequences.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;]*[A-Za-z]|\][^]*/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

// Lazily constructed grapheme segmenter (not available on very old runtimes).
let segmenter: Intl.Segmenter | undefined;
function getSegmenter(): Intl.Segmenter | undefined {
  if (segmenter) return segmenter;
  try {
    segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  } catch {
    segmenter = undefined;
  }
  return segmenter;
}

/** True if a code point is rendered as a fullwidth (2-column) glyph. */
function isFullWidthCodePoint(cp: number): boolean {
  if (Number.isNaN(cp)) return false;
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f || // Hangul Jamo
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals .. Kangxi
      (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK symbols
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
      (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
      (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical forms
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) || // emoji / symbols & pictographs
      (cp >= 0x20000 && cp <= 0x3fffd)) // CJK Ext B+
  );
}

/** True if a code point contributes 0 columns (combining / zero-width). */
function isZeroWidthCodePoint(cp: number): boolean {
  if (cp === 0x200d) return true; // ZWJ
  if (cp >= 0x0300 && cp <= 0x036f) return true; // combining diacritics
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // variation selectors
  if (cp === 0x200b) return true; // zero-width space
  return false;
}

function graphemeWidth(grapheme: string): number {
  // A grapheme cluster (e.g. emoji + ZWJ + emoji) renders in one or two
  // columns. Use the first non-zero-width code point as the deciding glyph.
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || isZeroWidthCodePoint(cp)) continue;
    return isFullWidthCodePoint(cp) ? 2 : 1;
  }
  return 0;
}

/** Visual column width of a string, ANSI-aware. */
export function visualWidth(input: string): number {
  const text = stripAnsi(input);
  const seg = getSegmenter();
  let width = 0;
  if (seg) {
    for (const { segment } of seg.segment(text)) {
      width += graphemeWidth(segment);
    }
    return width;
  }
  // Fallback: iterate code points.
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || isZeroWidthCodePoint(cp)) continue;
    width += isFullWidthCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/** Iterate grapheme clusters with their visual widths. */
export function* graphemes(input: string): Generator<{ segment: string; width: number }> {
  const seg = getSegmenter();
  if (seg) {
    for (const { segment } of seg.segment(input)) {
      yield { segment, width: graphemeWidth(segment) };
    }
    return;
  }
  for (const ch of input) {
    yield { segment: ch, width: graphemeWidth(ch) };
  }
}

/**
 * Truncate `value` to at most `max` VISUAL columns, appending an ellipsis when
 * anything was cut. Unlike String.slice-based helpers, a CJK/fullwidth string
 * is measured in display columns: truncation can never leave a wide glyph
 * half-cut at the screen edge, and the result never overflows `max` columns.
 * Never splits a surrogate pair or combining sequence.
 */
export function truncateVisual(value: string, max: number): string {
  if (max <= 1) return "";
  if (visualWidth(value) <= max) return value;
  let out = "";
  let w = 0;
  for (const { segment, width } of graphemes(value)) {
    if (w + width > max - 1) break;
    out += segment;
    w += width;
  }
  return out + "…";
}

/**
 * Pad a (possibly ANSI-styled) string to a target visual width.
 * `textWidth` is the pre-computed visual width of `text` (without padding).
 */
export function padAligned(
  text: string,
  textWidth: number,
  targetWidth: number,
  align: "left" | "center" | "right" = "left",
): string {
  const pad = Math.max(0, targetWidth - textWidth);
  if (align === "right") return " ".repeat(pad) + text;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + text + " ".repeat(pad - left);
  }
  return text + " ".repeat(pad);
}

/** The terminal's column count, with a sensible fallback. */
export function terminalColumns(): number {
  return process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
}

/** The terminal's row count, with a sensible fallback. */
export function terminalRows(): number {
  return process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;
}
