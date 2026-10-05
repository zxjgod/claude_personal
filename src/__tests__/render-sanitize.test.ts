// ============================================================
// Tests: terminal sanitization of the render chain (round 4)
// ============================================================
// Every renderer below feeds untrusted text (model replies, the live stream,
// tool output, an unknown tool's name) to a terminal. An OSC 52 sequence in any
// of them overwrites the user's clipboard; a private CSI can probe the
// terminal. sanitizeTerminalText is the single choke point — these tests pin
// that every entry into the chain routes through it.

import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { highlightCode, renderMarkdown } from "../tui/markdown.js";
import type { TranscriptItem } from "../tui/store.js";
import { renderNumberedDiffLine } from "../tui/tool-output.js";
import { transcriptToLines } from "../tui/transcript-lines.js";

chalk.level = 1;

/** An OSC 52 clipboard write, the payload every assertion below hunts for. */
const OSC52 = "\x1b]52;c;SGVsbG8hHGludmFkaW5nIQ==\x07";
/** A DEC private-mode CSI (cursor visibility) with the `?` marker. */
const PRIVATE_CSI = "\x1b[?25l";

/** TranscriptItem is a discriminated union; these fixtures only touch a few
 *  variants, so keep the cast local instead of restating the union. */
function item(partial: unknown): TranscriptItem {
  return { id: "i1", ...(partial as Record<string, unknown>) } as unknown as TranscriptItem;
}

describe("renderMarkdown", () => {
  it("strips OSC sequences from model text that has no markdown markers (fast path)", () => {
    // No markdown syntax at all, so this used to return the payload verbatim.
    const out = renderMarkdown(`hello ${OSC52}`);
    expect(out).toContain("hello");
    expect(out).not.toContain("52;c");
    expect(out).not.toContain("\x07");
  });

  it("strips terminal control sequences from rendered markdown (styled path)", () => {
    const out = renderMarkdown(`# Title\n\n${OSC52}\n\n- ${PRIVATE_CSI}item`);
    expect(out).toContain("Title");
    expect(out).toContain("item");
    expect(out).not.toContain("52;c");
    expect(out).not.toContain("[?25l");
  });

  it("keeps its own styling intact (sanitizing must not eat the SGR codes it adds)", () => {
    const out = renderMarkdown("**bold**");
    // chalk emits SGR on/off around the term; the sanitizer runs on the input,
    // so styling must survive.
    expect(out).toContain("\x1b[");
  });
});

describe("highlightCode", () => {
  it("strips terminal control sequences from code bodies", () => {
    const out = highlightCode(`const a = 1;${OSC52}${PRIVATE_CSI}`, "ts");
    // The highlighter emits SGR between tokens, so assert per token, not the
    // whole statement.
    expect(out).toContain("const");
    expect(out).not.toContain("52;c");
    expect(out).not.toContain("[?25l");
  });
});

describe("transcriptToLines (Ink path)", () => {
  it("strips terminal control sequences from assistant rows", () => {
    const lines = transcriptToLines([item({ kind: "assistant", text: `hi ${OSC52}` })], "");
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("hi");
    expect(text).not.toContain("52;c");
    expect(text).not.toContain("\x07");
  });

  it("strips terminal control sequences from the live thinking + assistant stream", () => {
    const lines = transcriptToLines(
      [],
      "",
      `reasoning ${OSC52}`,
      // force the verbose reasoning branch, which used to print rows raw
      { verbose: true },
    );
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("reasoning");
    expect(text).not.toContain("52;c");
    expect(text).not.toContain("\x07");
  });

  it("strips terminal control sequences from committed thinking rows (verbose)", () => {
    const lines = transcriptToLines(
      [item({ kind: "thinking_text", text: `thought ${OSC52}`, seconds: 3 })],
      "",
      "",
      { verbose: true },
    );
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("thought");
    expect(text).not.toContain("52;c");
    expect(text).not.toContain("\x07");
  });

  it("strips terminal control sequences from tool head, detail and error rows", () => {
    const lines = transcriptToLines(
      [
        item({
          kind: "tool",
          detail: `read ${OSC52}`,
          result: {
            toolName: `weird${OSC52}`,
            formatted: "",
            error: `boom ${OSC52}`,
          },
        }),
      ],
      "",
    );
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("boom");
    expect(text).not.toContain("52;c");
    expect(text).not.toContain("\x07");
  });
});

describe("renderNumberedDiffLine", () => {
  it("strips terminal control sequences from the sign and the line text", () => {
    // d.sign is typed as "-"/"+" but comes from replayed transcript JSON.
    const out = renderNumberedDiffLine(
      { sign: `+${OSC52}` as unknown as "+", text: `const a = 1;${PRIVATE_CSI}`, line: 7 },
      "ts",
    );
    expect(out).toContain("const");
    expect(out).not.toContain("52;c");
    expect(out).not.toContain("[?25l");
  });
});
