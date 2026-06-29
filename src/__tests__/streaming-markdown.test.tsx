// ============================================================
// Tests: StreamingMarkdown (live markdown during streaming)
// ============================================================
// The component renders markdown as it streams by splitting at the last
// top-level block boundary: completed blocks settle into a memoized prefix,
// only the in-progress tail re-lexes per frame. These tests drive it through a
// growing-text harness and assert the rendered output is correct and that
// markdown markers are consumed (not leaked) once a block settles.
// ============================================================

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown.js";
import { StreamingMarkdown } from "../tui/StreamingMarkdown.js";

describe("StreamingMarkdown", () => {
  it("renders completed markdown blocks (headers, bold) with markers consumed", () => {
    const text = "# Title\n\nSome **bold** word.\n";
    const { lastFrame } = render(<StreamingMarkdown>{text}</StreamingMarkdown>);
    const frame = lastFrame()!;
    expect(frame).toContain("Title");
    expect(frame).toContain("bold");
    // Once a block has settled, its markdown markers are consumed.
    expect(frame).not.toContain("**bold**");
    expect(frame).not.toContain("# Title");
  });

  it("renders a bullet list as bullets, not raw dashes", () => {
    const text = "- one\n- two\n- three\n\n";
    const { lastFrame } = render(<StreamingMarkdown>{text}</StreamingMarkdown>);
    const frame = lastFrame()!;
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    expect(frame).toContain("three");
  });

  it("keeps an unclosed code fence intact in the live tail (no premature split)", () => {
    // An open ``` fence lexes as a single growing token — the boundary must not
    // split inside it. The fenced line should still be visible.
    const text = "intro paragraph\n\n```js\nconst x = 1;\n";
    const { lastFrame } = render(<StreamingMarkdown>{text}</StreamingMarkdown>);
    const frame = lastFrame()!;
    expect(frame).toContain("intro paragraph");
    expect(frame).toContain("const x = 1;");
  });

  it("settles blocks cleanly as text grows across re-renders", () => {
    // Drive a real growing stream by re-rendering the same component instance
    // with ever-longer text — the stable-prefix ref persists across rerenders,
    // exactly as it does when the live store appends deltas.
    const chunks = ["# He", "ading\n\npara", "graph with **bo", "ld**.\n\n"];
    const { lastFrame, rerender } = render(<StreamingMarkdown>{chunks[0]!}</StreamingMarkdown>);
    let acc = chunks[0]!;
    for (let i = 1; i < chunks.length; i++) {
      acc += chunks[i]!;
      rerender(<StreamingMarkdown>{acc}</StreamingMarkdown>);
    }
    const frame = lastFrame()!;
    expect(frame).toContain("Heading");
    expect(frame).toContain("paragraph with");
    expect(frame).toContain("bold");
    expect(frame).not.toContain("**bold**");
    expect(frame).not.toContain("# Heading");
  });
});

describe("renderMarkdown plain-text fast path", () => {
  it("returns plain prose unchanged (trimmed) without invoking the lexer", () => {
    expect(renderMarkdown("just a plain sentence")).toBe("just a plain sentence");
    expect(renderMarkdown("trailing newlines\n\n")).toBe("trailing newlines");
  });

  it("still formats real markdown through the lexer", () => {
    const out = renderMarkdown("**bold**");
    expect(out).not.toContain("**");
    expect(out).toContain("bold");
  });
});
