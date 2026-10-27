import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCustomCommand, resetCustomCommands } from "../commands.js";
import { Root, type TuiDeps } from "../tui/run.js";
import { SessionStats } from "../tui/session-stats.js";
import { TuiStore } from "../tui/store.js";
import type { Message, ModelCaller } from "../types.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 35));

async function waitFor(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      check();
      return;
    } catch {
      await flush();
    }
  }
  check();
}

function messageText(message: Message | undefined): string {
  if (!message?.content) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ccr-tui-submit-"));
});

afterEach(() => {
  resetCustomCommands();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function makeDeps(
  callModel: ModelCaller,
  stats = new SessionStats(),
): { deps: TuiDeps; messages: Message[]; stats: SessionStats } {
  const messages: Message[] = [];
  const modelConfig: TuiDeps["modelConfig"] = {
    provider: "openai",
    model: "test-model",
    apiKey: "test",
    maxTokens: 64,
  };
  const scope = { workspaceRoot, sessionId: "tui-submit" };
  const ui = { showTokens: false, verbose: false };
  const deps: TuiDeps = {
    ...scope,
    getWorkspaceRoot: () => workspaceRoot,
    getSessionId: () => scope.sessionId,
    messages,
    modelConfig,
    callModel,
    systemPrompt: "Test system",
    tools: [],
    commands: [
      { name: "clear", description: "Clear" },
      { name: "first", description: "First" },
      { name: "second", description: "Second" },
      { name: "prompt-file", description: "Prompt" },
    ],
    permissionMode: "default",
    onSave: () => {},
    alwaysAllow: new Set(),
    permissionKey: () => "key",
    makeCommandContext: () => ({
      ...scope,
      messages,
      modelConfig,
      callModel,
      stats,
      ui,
    }),
  };
  return { deps, messages, stats };
}

async function submit(view: ReturnType<typeof render>, value: string): Promise<void> {
  view.stdin.write(value);
  await flush();
  view.stdin.write("\r");
  await flush();
}

describe("Root submission ownership", () => {
  it("runs a busy slash locally instead of injecting it into model history", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const callModel: ModelCaller = async function* () {
      calls++;
      await gate;
      yield { type: "text_delta", delta: "answer" };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };
    const { deps, messages } = makeDeps(callModel);
    const store = new TuiStore("openai/test-model");
    const view = render(<Root store={store} deps={deps} />);
    try {
      await submit(view, "hello");
      await waitFor(() => expect(calls).toBe(1));
      await submit(view, "/clear");
      expect(messages.some((message) => messageText(message).includes("/clear"))).toBe(false);
      expect(calls).toBe(1);

      release();
      await waitFor(() => expect(messages).toHaveLength(0));
      expect(calls).toBe(1);
    } finally {
      release();
      view.unmount();
      store.cancelOverlays();
    }
  });

  it("serializes asynchronous local commands and drains deferred slashes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const events: string[] = [];
    registerCustomCommand({
      name: "first",
      description: "First",
      run: async () => {
        events.push("first:start");
        await gate;
        events.push("first:end");
        return undefined;
      },
    });
    registerCustomCommand({
      name: "second",
      description: "Second",
      run: () => {
        events.push("second");
        return undefined;
      },
    });
    const callModel: ModelCaller = async function* () {};
    const { deps } = makeDeps(callModel);
    const store = new TuiStore("openai/test-model");
    const view = render(<Root store={store} deps={deps} />);
    try {
      await submit(view, "/first");
      await waitFor(() => expect(events).toEqual(["first:start"]));
      await submit(view, "/second");
      expect(events).toEqual(["first:start"]);

      release();
      await waitFor(() => expect(events).toEqual(["first:start", "first:end", "second"]));
    } finally {
      release();
      view.unmount();
      store.cancelOverlays();
    }
  });

  it("preserves submission order when a deferred slash is followed by a prompt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const events: string[] = [];
    registerCustomCommand({
      name: "first",
      description: "First",
      run: async () => {
        events.push("first:start");
        await gate;
        events.push("first:end");
        return undefined;
      },
    });
    const callModel: ModelCaller = async function* (messages) {
      events.push(`model:${messageText(messages.at(-1))}`);
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };
    const { deps } = makeDeps(callModel);
    const store = new TuiStore("openai/test-model");
    const view = render(<Root store={store} deps={deps} />);
    try {
      await submit(view, "/first");
      await waitFor(() => expect(events).toEqual(["first:start"]));
      await submit(view, "/clear");
      await submit(view, "after");

      release();
      await waitFor(() => expect(events).toEqual(["first:start", "first:end", "model:after"]));
    } finally {
      release();
      view.unmount();
      store.cancelOverlays();
    }
  });

  it("does not expand file references inside a generated command prompt", async () => {
    writeFileSync(join(workspaceRoot, ".env"), "SECRET=do-not-attach");
    registerCustomCommand({
      name: "prompt-file",
      description: "Prompt",
      run: () => ({ prompt: "@.env" }),
    });
    const seen: string[] = [];
    const callModel: ModelCaller = async function* (messages) {
      seen.push(messageText(messages.at(-1)));
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "stop",
      };
    };
    const { deps, messages } = makeDeps(callModel);
    const store = new TuiStore("openai/test-model");
    const view = render(<Root store={store} deps={deps} />);
    try {
      await submit(view, "/prompt-file");
      await waitFor(() => expect(seen).toEqual(["@.env"]));
      expect(messageText(messages[0])).toBe("@.env");
      expect(messageText(messages[0])).not.toContain("do-not-attach");
    } finally {
      view.unmount();
      store.cancelOverlays();
    }
  });

  it("feeds real TUI usage into command stats and the live token display", async () => {
    const callModel: ModelCaller = async function* () {
      yield {
        type: "done",
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 2,
        },
        finish_reason: "stop",
      };
    };
    const { deps, stats } = makeDeps(callModel);
    deps.makeCommandContext().ui!.showTokens = true;
    const store = new TuiStore("openai/test-model");
    const view = render(<Root store={store} deps={deps} />);
    try {
      await submit(view, "hello");
      await waitFor(() => expect(stats.apiCalls).toBe(1));
      expect(stats.inputTokens).toBe(7);
      expect(stats.outputTokens).toBe(3);
      expect(stats.totalTokens).toBe(10);
      expect(stats.cacheHitRate).toBe(2 / 7);
      await waitFor(() => {
        const text = store
          .getSnapshot()
          .transcript.map((item) => ("text" in item ? item.text : ""))
          .join("\n");
        expect(text).toContain("[tokens: 7 in / 3 out]");
      });
    } finally {
      view.unmount();
      store.cancelOverlays();
    }
  });
});
