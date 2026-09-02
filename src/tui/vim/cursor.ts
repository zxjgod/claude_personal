// ============================================================
// Vim Mode — Cursor + character classification (focused port)
// ============================================================
// A framework-agnostic text cursor over a plain string (offset = UTF-16 code
// unit index), grapheme-aware for stepping. "Logical line" == `\n`-delimited
// line (the reference's *LogicalLine methods); soft-wrap line navigation is
// not needed for a plain input box and is intentionally omitted.
// ============================================================

// --- character classification (vim semantics) ---

export function isVimWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

export function isVimWordChar(ch: string): boolean {
  return /[\w]/.test(ch) && !isVimWhitespace(ch);
}

export function isVimPunctuation(ch: string): boolean {
  return !isVimWhitespace(ch) && !isVimWordChar(ch);
}

// --- grapheme stepping ---

function segmenter(): Intl.Segmenter {
  return new Intl.Segmenter(undefined, { granularity: "grapheme" });
}

/** Code-unit length of the grapheme starting at `offset`. */
function graphemeLenAt(text: string, offset: number): number {
  if (offset >= text.length) return 0;
  for (const { segment, index } of segmenter().segment(text)) {
    if (index === offset) return segment.length;
    if (index > offset) break;
  }
  return 1;
}

/** Offset of the next grapheme boundary after `offset` (== length when at end). */
export function nextGraphemeOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  return offset + graphemeLenAt(text, offset);
}

/** Offset of the previous grapheme boundary before `offset`. */
function prevGraphemeOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  let last = 0;
  for (const { index } of segmenter().segment(text)) {
    if (index >= offset) break;
    last = index;
  }
  return last;
}

function firstGrapheme(text: string, offset: number): string {
  const len = graphemeLenAt(text, offset);
  return text.slice(offset, offset + len);
}

export function lastGrapheme(text: string): string {
  if (text.length === 0) return "";
  const prev = prevGraphemeOffset(text, text.length);
  return text.slice(prev);
}

// --- Cursor ---

export class Cursor {
  constructor(
    readonly text: string,
    readonly offset: number,
  ) {}

  // -- basic stepping --
  left(): Cursor {
    return new Cursor(this.text, prevGraphemeOffset(this.text, this.offset));
  }
  right(): Cursor {
    return new Cursor(this.text, nextGraphemeOffset(this.text, this.offset));
  }
  isAtEnd(): boolean {
    return this.offset >= this.text.length;
  }
  equals(other: Cursor): boolean {
    return this.text === other.text && this.offset === other.offset;
  }

  // -- logical-line navigation (track a target column) --
  private column(): number {
    const lineStart = this.text.lastIndexOf("\n", this.offset - 1) + 1;
    return this.offset - lineStart;
  }

  startOfLogicalLine(): Cursor {
    const idx = this.text.lastIndexOf("\n", this.offset - 1);
    return new Cursor(this.text, idx + 1);
  }
  endOfLogicalLine(): Cursor {
    const idx = this.text.indexOf("\n", this.offset);
    return new Cursor(this.text, idx === -1 ? this.text.length : idx);
  }
  firstNonBlankInLogicalLine(): Cursor {
    const start = this.startOfLogicalLine().offset;
    const end = this.endOfLogicalLine().offset;
    let i = start;
    while (i < end && isVimWhitespace(this.text[i]!)) i++;
    return new Cursor(this.text, i);
  }
  upLogicalLine(): Cursor {
    if (this.offset === 0) return this;
    const lineStart = this.startOfLogicalLine().offset;
    if (lineStart === 0) return this;
    const prevStart = this.text.lastIndexOf("\n", lineStart - 2) + 1;
    return new Cursor(this.text, this.atColumnFor(prevStart, this.column()));
  }
  downLogicalLine(): Cursor {
    const end = this.endOfLogicalLine().offset;
    if (end >= this.text.length) return this;
    const nextStart = end + 1;
    return new Cursor(this.text, this.atColumnFor(nextStart, this.column()));
  }
  private atColumnFor(lineStart: number, targetCol: number): number {
    const lineEnd = this.text.indexOf("\n", lineStart);
    const effectiveEnd = lineEnd === -1 ? this.text.length : lineEnd;
    let o = lineStart;
    let col = 0;
    while (col < targetCol && o < effectiveEnd) {
      o = nextGraphemeOffset(this.text, o);
      col++;
    }
    return o;
  }

  startOfFirstLine(): Cursor {
    return new Cursor(this.text, 0);
  }
  startOfLastLine(): Cursor {
    return new Cursor(this.text, this.text.lastIndexOf("\n") + 1);
  }
  goToLine(lineNumber: number): Cursor {
    const target = Math.max(1, lineNumber);
    let line = 1;
    for (let i = 0; i < this.text.length; i++) {
      if (line === target) return new Cursor(this.text, i);
      if (this.text[i] === "\n") line++;
    }
    return new Cursor(this.text, this.text.length);
  }

  // -- word / WORD motions (vim semantics) --
  private classify(o: number): "word" | "ws" | "punct" {
    if (o >= this.text.length) return "ws";
    const ch = firstGrapheme(this.text, o);
    if (isVimWhitespace(ch)) return "ws";
    if (isVimWordChar(ch)) return "word";
    return "punct";
  }

  nextVimWord(): Cursor {
    let o = this.offset;
    const kind = this.classify(o);
    // advance past the current run (word or punctuation)
    while (o < this.text.length && this.classify(o) === kind) o = nextGraphemeOffset(this.text, o);
    // skip whitespace
    while (o < this.text.length && this.classify(o) === "ws") o = nextGraphemeOffset(this.text, o);
    return new Cursor(this.text, o);
  }
  endOfVimWord(): Cursor {
    let o = this.offset;
    const kind = this.classify(o);
    while (o < this.text.length && this.classify(o) === kind) o = nextGraphemeOffset(this.text, o);
    // `e` lands on the last char of the run
    return new Cursor(this.text, prevGraphemeOffset(this.text, o));
  }
  prevVimWord(): Cursor {
    let o = prevGraphemeOffset(this.text, this.offset);
    while (o > 0 && this.classify(o) === "ws") o = prevGraphemeOffset(this.text, o);
    const kind = this.classify(o);
    while (o > 0 && this.classify(prevGraphemeOffset(this.text, o)) === kind) {
      o = prevGraphemeOffset(this.text, o);
    }
    return new Cursor(this.text, o);
  }
  nextWORD(): Cursor {
    let o = this.offset;
    while (o < this.text.length && !isVimWhitespace(firstGrapheme(this.text, o))) {
      o = nextGraphemeOffset(this.text, o);
    }
    while (o < this.text.length && isVimWhitespace(firstGrapheme(this.text, o))) {
      o = nextGraphemeOffset(this.text, o);
    }
    return new Cursor(this.text, o);
  }
  endOfWORD(): Cursor {
    let o = this.offset;
    while (o < this.text.length && !isVimWhitespace(firstGrapheme(this.text, o))) {
      o = nextGraphemeOffset(this.text, o);
    }
    return new Cursor(this.text, prevGraphemeOffset(this.text, o));
  }
  prevWORD(): Cursor {
    let o = prevGraphemeOffset(this.text, this.offset);
    while (o > 0 && isVimWhitespace(firstGrapheme(this.text, o))) {
      o = prevGraphemeOffset(this.text, o);
    }
    while (o > 0 && !isVimWhitespace(firstGrapheme(this.text, prevGraphemeOffset(this.text, o)))) {
      o = prevGraphemeOffset(this.text, o);
    }
    return new Cursor(this.text, o);
  }

  // -- find (f/F/t/T) --
  findCharacter(char: string, type: "f" | "F" | "t" | "T", count: number): number | null {
    const forward = type === "f" || type === "t";
    let matches = 0;
    if (forward) {
      let o = nextGraphemeOffset(this.text, this.offset);
      while (o < this.text.length) {
        if (firstGrapheme(this.text, o) === char) {
          matches++;
          if (matches === count) {
            return type === "t" ? prevGraphemeOffset(this.text, o) : o;
          }
        }
        o = nextGraphemeOffset(this.text, o);
      }
    } else {
      let o = prevGraphemeOffset(this.text, this.offset);
      while (o >= 0) {
        if (o < this.text.length && firstGrapheme(this.text, o) === char) {
          matches++;
          if (matches === count) {
            return type === "T" ? nextGraphemeOffset(this.text, o) : o;
          }
        }
        if (o === 0) break;
        o = prevGraphemeOffset(this.text, o);
      }
    }
    return null;
  }

  // -- position (0-based line index) --
  getPosition(): { line: number } {
    let line = 0;
    for (let i = 0; i < this.offset; i++) if (this.text[i] === "\n") line++;
    return { line };
  }

  /** Advance past the grapheme at `offset` (image-ref snapping is a no-op here). */
  get measuredText(): { nextOffset: (offset: number) => number } {
    return { nextOffset: (offset) => nextGraphemeOffset(this.text, offset) };
  }

  snapOutOfImageRef(offset: number): number {
    return offset; // no image refs in this input model
  }
}
