// ============================================================
// Tests: /copy — last-reply extraction and clipboard reporting
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyCommand, lastAssistantText } from "../commands/copy.js";
import type { CommandContext } from "../commands/types.js";
import type { Message } from "../types.js";

const ctx = (messages: Message[]): CommandContext =>
  ({
    messages,
    modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "k" },
    workspaceRoot: "/tmp/ws",
    sessionId: "sess1234",
  }) as unknown as CommandContext;

const assistant = (content: string | null): Message => ({ role: "assistant", content });
const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

describe("lastAssistantText", () => {
  it("returns the most recent assistant prose", () => {
    expect(
      lastAssistantText([user("hi"), assistant("first"), user("again"), assistant("last")]),
    ).toBe("last");
  });

  it("skips a trailing tool-call-only turn and walks back to real prose", () => {
    // An assistant turn that only emitted tool_calls carries content === null —
    // there is nothing to copy from it, so the previous reply wins.
    const messages: Message[] = [
      assistant("the real answer"),
      { role: "assistant", content: null, tool_calls: [] },
    ];
    expect(lastAssistantText(messages)).toBe("the real answer");
  });

  it("ignores whitespace-only content", () => {
    expect(lastAssistantText([assistant("answer"), assistant("   \n  ")])).toBe("answer");
  });

  it("returns null when the session has no assistant reply", () => {
    expect(lastAssistantText([])).toBeNull();
    expect(lastAssistantText([user("hello")])).toBeNull();
  });
});

describe("copyCommand", () => {
  let logged: string[];
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports when there is nothing to copy", async () => {
    await copyCommand.run("", ctx([user("hello")]));
    expect(logged.join("\n")).toContain("Nothing to copy");
  });

  it("never throws when the clipboard tool is unavailable", async () => {
    // The suite runs without a usable clipboard tool under most CI containers;
    // either branch is acceptable, but the command must resolve cleanly.
    await expect(copyCommand.run("", ctx([assistant("copy me")]))).resolves.toEqual({
      handled: true,
    });
  });
});
