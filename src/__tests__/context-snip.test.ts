// ============================================================
// Tests: context snip — importance-aware compression (12.1)
// ============================================================

import { describe, expect, it } from "vitest";
import { SNIP_MARKER, snipContext } from "../context/context-snip.js";
import type { Message } from "../types.js";

function toolMsg(content: string, name = "grep"): Message {
  return { role: "tool", tool_call_id: "t", name, content };
}
function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("snipContext", () => {
  it("trims a large old tool result to head + tail with a marker", () => {
    const big = "X".repeat(5000);
    const messages: Message[] = [
      toolMsg(big),
      ...Array.from({ length: 12 }, (_, i) => userMsg(`turn ${i}`)),
    ];
    const r = snipContext(messages);
    expect(r.snippedCount).toBe(1);
    expect(r.charsSaved).toBeGreaterThan(3000);
    const snipped = r.messages[0];
    expect(snipped.role).toBe("tool");
    expect((snipped as any).content).toContain(SNIP_MARKER);
    expect((snipped as any).content.length).toBeLessThan(big.length);
  });

  it("never touches the most recent messages", () => {
    const big = "Y".repeat(5000);
    // Big tool result is within keepRecent (last 10) → protected.
    const messages: Message[] = [userMsg("old"), toolMsg(big)];
    const r = snipContext(messages, { keepRecent: 10 });
    expect(r.snippedCount).toBe(0);
    expect((r.messages[1] as any).content).toBe(big);
  });

  it("leaves small tool results alone", () => {
    const small = "Z".repeat(100);
    const messages: Message[] = [toolMsg(small), ...Array.from({ length: 12 }, () => userMsg("x"))];
    const r = snipContext(messages, { minSnipChars: 2000 });
    expect(r.snippedCount).toBe(0);
  });

  it("never snips non-tool messages", () => {
    const big = "A".repeat(5000);
    const messages: Message[] = [userMsg(big), ...Array.from({ length: 12 }, () => userMsg("x"))];
    const r = snipContext(messages);
    expect(r.snippedCount).toBe(0);
  });

  it("is idempotent — a second pass snips nothing new", () => {
    const big = "B".repeat(5000);
    const messages: Message[] = [toolMsg(big), ...Array.from({ length: 12 }, () => userMsg("x"))];
    const once = snipContext(messages);
    const twice = snipContext(once.messages);
    expect(once.snippedCount).toBe(1);
    expect(twice.snippedCount).toBe(0);
  });

  it("does not mutate the input array or messages", () => {
    const big = "C".repeat(5000);
    const original = toolMsg(big);
    const messages: Message[] = [original, ...Array.from({ length: 12 }, () => userMsg("x"))];
    snipContext(messages);
    expect((original as any).content).toBe(big);
  });
});
