// ============================================================
// Tests: /resume history replay (Message[] → transcript)
// ============================================================

import { describe, expect, it } from "vitest";
import { firstUserPreview, messagesToTranscript } from "../tui/history-replay.js";
import { visualWidth } from "../tui/terminal-width.js";
import type { Message } from "../types.js";

const sample: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello world" }] },
  {
    role: "assistant",
    content: "let me look",
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ filePath: "a.ts" }) },
      },
    ],
  },
  { role: "tool", tool_call_id: "c1", name: "read", content: "file contents here" },
  { role: "assistant", content: "all done" },
  { role: "system", content: "compaction summary (should be skipped)" },
];

describe("messagesToTranscript", () => {
  it("replays user, assistant text, and paired tool calls; skips system", () => {
    const items = messagesToTranscript(sample);
    expect(items).toEqual([
      { kind: "user", text: "hello world" },
      { kind: "assistant", text: "let me look" },
      {
        kind: "tool",
        name: "read",
        detail: "a.ts",
        result: {
          toolName: "read",
          formatted: "file contents here",
          result: { content: "file contents here" },
        },
      },
      { kind: "assistant", text: "all done" },
    ]);
  });

  it("does not emit an assistant item when content is empty but tool_calls exist", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "grep", arguments: "{}" } }],
      },
    ];
    const items = messagesToTranscript(msgs);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", name: "grep" });
  });

  it("marks a tool_call with no recorded result", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c9", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
    ];
    const [item] = messagesToTranscript(msgs);
    expect(item).toMatchObject({ kind: "tool", name: "bash" });
    expect((item as any).result.formatted).toContain("no result");
  });

  it("flattens image content blocks in user messages", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "see this " },
          { type: "image", source: { type: "url", media_type: "image/png", url: "x" } },
        ],
      },
    ];
    expect(messagesToTranscript(msgs)).toEqual([{ kind: "user", text: "see this [image]" }]);
  });
});

describe("firstUserPreview", () => {
  it("returns the first user message text", () => {
    expect(firstUserPreview(sample)).toBe("hello world");
  });

  it("truncates long previews", () => {
    const long = "x".repeat(200);
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: long }] }];
    const preview = firstUserPreview(msgs, 20);
    expect(preview.length).toBe(20);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("truncates CJK previews by VISUAL columns, not code units", () => {
    // 40 Han chars occupy 80 columns — a `.length` cut let all 40 through,
    // overflowing the picker row.
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "汉".repeat(40) }] }];
    const preview = firstUserPreview(msgs, 72);
    expect(visualWidth(preview)).toBeLessThanOrEqual(72);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair when truncating", () => {
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "😀".repeat(40) }] }];
    const preview = firstUserPreview(msgs, 25);
    expect(preview).not.toContain("\uFFFD");
    // Every remaining char is a whole emoji (or the ellipsis at the end).
    const chars = [...preview.slice(0, -1)];
    expect(chars.every((ch) => ch === "😀")).toBe(true);
  });

  it("returns empty string when there is no user text", () => {
    const msgs: Message[] = [{ role: "assistant", content: "hi" }];
    expect(firstUserPreview(msgs)).toBe("");
  });
});
