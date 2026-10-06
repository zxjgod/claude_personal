import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearCheckpointMemoryForTests,
  beginUserTurn,
  bindCheckpointSession,
  listTurns,
  previewRestore,
  shadowBeforeWrite,
  turnOfMessage,
} from "../checkpoint.js";
import { createResumeSession } from "../cli-session.js";
import { PersistenceManager } from "../persistence.js";
import { applyRewindChoice, rewindEntries } from "../tui/rewind-flow.js";
import { TuiStore } from "../tui/store.js";
import type { Message, ModelCaller, ModelConfig } from "../types.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-rewind-flow-"));
});
afterEach(() => {
  __clearCheckpointMemoryForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const modelConfig: ModelConfig = { provider: "openai", model: "test", apiKey: "test" };
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

function fixture() {
  const session = { id: "original-session" };
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "original");
  bindCheckpointSession(session.id, root);
  const first = user("first prompt");
  beginUserTurn(session.id, first);
  shadowBeforeWrite(session.id, file);
  fs.writeFileSync(file, "first edit");
  const second = user("second prompt");
  beginUserTurn(session.id, second);
  shadowBeforeWrite(session.id, file);
  fs.writeFileSync(file, "second edit");
  const messages: Message[] = [
    first,
    { role: "assistant", content: "first reply" },
    second,
    { role: "assistant", content: "second reply" },
  ];
  const persistence = new PersistenceManager(root);
  const resumeSession = createResumeSession({ persistence, session, messages });
  const callModel: ModelCaller = vi.fn(async function* () {
    yield { type: "text_delta" as const, delta: "selected range summary" };
  });
  const store = new TuiStore("test");
  const deps = {
    messages,
    sessionId: session.id,
    context: {
      messages,
      sessionId: session.id,
      workspaceRoot: root,
      persistence,
      resumeSession,
      callModel,
      modelConfig,
    },
    callModel,
    modelConfig,
  };
  return { store, deps, session, file, persistence, first, second };
}

describe("rewind operations", () => {
  it("can restore before the first prompt into an empty new session", async () => {
    const { store, deps, session, persistence } = fixture();
    await applyRewindChoice(store, deps, { turnIndex: 1, action: "conversation" });
    expect(deps.messages).toEqual([]);
    expect(session.id).not.toBe(deps.sessionId);
    expect((await persistence.load(deps.sessionId))?.messages).toHaveLength(4);
    expect(store.getSnapshot().draft.text).toBe("first prompt");
  });

  it("counts changes to the same file in later turns and preserves chronological order", () => {
    const { deps, file } = fixture();
    const entries = rewindEntries(deps.messages, deps.sessionId);
    expect(entries.map((entry) => entry.label)).toEqual(["first prompt", "second prompt"]);
    expect(entries.every((entry) => entry.filesChanged === 1 && entry.canRestoreCode)).toBe(true);
    fs.writeFileSync(file, "first edit");
    expect(previewRestore(deps.sessionId, 2).files).toEqual([]);
  });

  it("forks conversation, keeps files, restores the prompt draft, and preserves the original session", async () => {
    const { store, deps, session, file, persistence } = fixture();
    await applyRewindChoice(store, deps, { turnIndex: 2, action: "conversation" });
    expect(session.id).not.toBe(deps.sessionId);
    expect(deps.messages).toHaveLength(2);
    expect((await persistence.load(deps.sessionId))?.messages).toHaveLength(4);
    expect((await persistence.load(session.id))?.messages).toHaveLength(2);
    expect(fs.readFileSync(file, "utf-8")).toBe("second edit");
    expect(store.getSnapshot().draft.text).toBe("second prompt");
    expect(turnOfMessage(deps.messages[0]!, session.id)).toBe(1);
    __clearCheckpointMemoryForTests();
    bindCheckpointSession(session.id, root);
    bindCheckpointSession(deps.sessionId, root);
    expect(previewRestore(session.id, 1).files).toEqual([file]);
    expect(listTurns(deps.sessionId)).toHaveLength(2);
  });

  it("forks code and conversation without pruning the original session checkpoints", async () => {
    const { store, deps, session, file, persistence } = fixture();
    await applyRewindChoice(store, deps, { turnIndex: 2, action: "both" });
    expect(fs.readFileSync(file, "utf-8")).toBe("first edit");
    expect(deps.messages).toHaveLength(2);
    expect(session.id).not.toBe(deps.sessionId);
    expect(listTurns(deps.sessionId)).toHaveLength(2);
    expect(listTurns(session.id)).toHaveLength(1);
    expect((await persistence.load(deps.sessionId))?.messages).toHaveLength(4);
  });

  it("restores only code without replacing conversation or session", async () => {
    const { store, deps, session, file } = fixture();
    await applyRewindChoice(store, deps, { turnIndex: 2, action: "code" });
    expect(session.id).toBe(deps.sessionId);
    expect(deps.messages).toHaveLength(4);
    expect(fs.readFileSync(file, "utf-8")).toBe("first edit");
  });

  it.each([
    "summarize",
    "summarize_up_to",
  ] as const)("summarizes the correct range for %s and keeps the opposite range", async (action) => {
    const { store, deps, session, file, first, second } = fixture();
    await applyRewindChoice(store, deps, { turnIndex: 2, action, context: "focus on paths" });
    const sent = vi.mocked(deps.callModel).mock.calls[0]?.[0] ?? [];
    expect(sent).toHaveLength(3);
    expect(sent[0]).toBe(action === "summarize" ? second : first);
    expect(JSON.stringify(sent.at(-1))).toContain("focus on paths");
    expect(deps.messages).toHaveLength(3);
    expect(deps.messages[action === "summarize" ? 2 : 0]).toMatchObject({
      role: "system",
      content: "[Conversation summary]\nselected range summary",
    });
    expect(session.id).toBe(deps.sessionId);
    expect(fs.readFileSync(file, "utf-8")).toBe("second edit");
    expect(store.getSnapshot().draft.text).toBe(action === "summarize" ? "second prompt" : "");
  });

  it("keeps all history when summarizing before the first message", async () => {
    const { store, deps } = fixture();
    const original = [...deps.messages];
    await expect(
      applyRewindChoice(store, deps, { turnIndex: 1, action: "summarize_up_to" }),
    ).rejects.toThrow("no messages");
    expect(deps.messages).toEqual(original);
    expect(deps.callModel).not.toHaveBeenCalled();
  });

  it("keeps history and files when the summary stream fails", async () => {
    const { store, deps, file } = fixture();
    deps.callModel = async function* () {
      yield { type: "text_delta", delta: "partial" };
      yield { type: "error", error: new Error("provider failed") };
    };
    await expect(
      applyRewindChoice(store, deps, { turnIndex: 2, action: "summarize" }),
    ).rejects.toThrow("provider failed");
    expect(deps.messages).toHaveLength(4);
    expect(fs.readFileSync(file, "utf-8")).toBe("second edit");
    expect(store.getSnapshot().transcript).toEqual([]);
  });

  it("keeps the overlay until the operation and its restored draft are ready", async () => {
    const store = new TuiStore("test");
    let finish = () => {};
    const processing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = store.askRewind([], async () => {
      await processing;
      store.setDraft({ text: "restored prompt", cursor: 15 });
    });
    const overlay = store.getSnapshot().overlay;
    if (overlay?.kind !== "rewind") throw new Error("missing rewind overlay");
    overlay.resolve({ turnIndex: 1, action: "conversation" });
    expect(store.getSnapshot().overlay).toMatchObject({
      kind: "rewind",
      processing: "conversation",
    });
    finish();
    await pending;
    expect(store.getSnapshot().overlay).toBeNull();
    expect(store.getSnapshot().draft.text).toBe("restored prompt");
  });
});
