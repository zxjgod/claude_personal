import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsCommand } from "../commands/sessions.js";
import type { CommandContext } from "../commands/types.js";
import type { SessionMeta } from "../persistence.js";

const otherSession: SessionMeta = {
  sessionId: "other-session-123456",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  messageCount: 2,
  completed: false,
  taskState: "paused",
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeContext(options: { current?: boolean; interactive?: boolean; answer?: boolean }) {
  const deleteSession = vi.fn(async () => {});
  const askConfirmation = vi.fn(async (_question: string) => options.answer ?? true);
  const session = options.current
    ? { ...otherSession, sessionId: "current-session-123456" }
    : otherSession;
  const ctx = {
    workspaceRoot: "/unused",
    sessionId: "current-session-123456",
    messages: [],
    modelConfig: { provider: "openai", model: "test" },
    persistence: {
      listSessions: async () => [session],
      deleteSession,
    },
    ...(options.interactive ? { input: { askConfirmation } } : {}),
  } as unknown as CommandContext;
  return { ctx, deleteSession, askConfirmation, session };
}

function consoleOutput(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => call.join(" "))
    .join("\n");
}

describe("/sessions delete confirmation", () => {
  it("asks before deleting a non-current session and deletes after acceptance", async () => {
    const { ctx, deleteSession, askConfirmation, session } = makeContext({ interactive: true });
    await sessionsCommand.run("delete other", ctx);
    expect(askConfirmation).toHaveBeenCalledOnce();
    expect(askConfirmation.mock.calls[0]?.[0]).toContain(session.sessionId.slice(0, 8));
    expect(deleteSession).toHaveBeenCalledWith(session.sessionId);
  });

  it("does not delete when interactive confirmation is cancelled", async () => {
    const { ctx, deleteSession } = makeContext({ interactive: true, answer: false });
    await sessionsCommand.run("delete other", ctx);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(consoleOutput()).toContain("cancelled");
  });

  it("requires force when no interactive confirmation is available", async () => {
    const { ctx, deleteSession } = makeContext({});
    await sessionsCommand.run("delete other", ctx);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(consoleOutput()).toContain("--force");
  });

  it.each([
    "delete other --force",
    "delete --force other",
  ])("allows a non-interactive explicit force deletion: %s", async (args) => {
    const { ctx, deleteSession, session } = makeContext({});
    await sessionsCommand.run(args, ctx);
    expect(deleteSession).toHaveBeenCalledWith(session.sessionId);
  });

  it("still requires force for the current session without prompting", async () => {
    const { ctx, deleteSession, askConfirmation } = makeContext({
      current: true,
      interactive: true,
    });
    await sessionsCommand.run("delete current", ctx);
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(consoleOutput()).toContain("current session");
  });
});
