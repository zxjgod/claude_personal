import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReplDeps, runRepl } from "../cli-repl.js";
import { registerCustomCommand, resetCustomCommands } from "../commands.js";
import { HookRegistry } from "../hooks.js";
import { PersistenceManager } from "../persistence.js";
import { Telemetry } from "../telemetry.js";
import { SessionStats } from "../tui/session-stats.js";
import { SessionTranscript } from "../tui/session-transcript.js";
import type { Message, ModelCaller } from "../types.js";

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ccr-line-repl-"));
});

afterEach(() => {
  resetCustomCommands();
  vi.restoreAllMocks();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function messageText(message: Message | undefined): string {
  if (!message?.content) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

describe("line REPL command lifecycle", () => {
  it("cancels local commands, preserves generated-prompt boundaries, and reads live token settings", async () => {
    writeFileSync(join(workspaceRoot, ".env"), "SECRET=do-not-attach");
    const inputs: Array<string | null> = ["/wait", "/prompt-file", null];
    const messages: Message[] = [];
    const modelConfig: ReplDeps["modelConfig"] = {
      provider: "openai",
      model: "test-model",
      apiKey: "test",
      maxTokens: 64,
    };
    let showTokens = false;
    let localAborted = false;
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => (commandStarted = resolve));
    let finishCommand!: () => void;
    registerCustomCommand({
      name: "wait",
      description: "Wait",
      run: async (_args, ctx) => {
        commandStarted();
        await new Promise<void>((resolve) => {
          finishCommand = resolve;
          if (ctx.abortSignal?.aborted) {
            localAborted = true;
            resolve();
          } else {
            ctx.abortSignal?.addEventListener(
              "abort",
              () => {
                localAborted = true;
                resolve();
              },
              { once: true },
            );
          }
        });
        return undefined;
      },
    });
    registerCustomCommand({
      name: "prompt-file",
      description: "Prompt",
      run: () => {
        // Change the setting after the REPL has started; the response footer
        // must read the live holder rather than its startup snapshot.
        showTokens = true;
        return { prompt: "@.env" };
      },
    });
    const seen: string[] = [];
    const callModel: ModelCaller = async function* (modelMessages) {
      seen.push(messageText(modelMessages.at(-1)));
      yield {
        type: "done",
        usage: { input_tokens: 7, output_tokens: 3 },
        finish_reason: "stop",
      };
    };
    const persistence = new PersistenceManager(workspaceRoot);
    const stats = new SessionStats();
    const session = { id: "line-repl" };
    const deps: ReplDeps = {
      messages,
      tools: [],
      callModel,
      modelConfig,
      buildTurnSystemPrompt: () => "Test system",
      getWorkspaceRoot: () => workspaceRoot,
      permissionModeState: { get: () => "default", set: () => {} },
      permissionClassifier: undefined,
      prefetch: async () => null,
      summarizeToolBatch: undefined,
      fastModelFactory: () => null,
      hooks: new HookRegistry(),
      mcpManager: { disconnectAll: async () => {} } as unknown as ReplDeps["mcpManager"],
      state: {
        persistence,
        transcript: SessionTranscript.forWorkspace(workspaceRoot),
        stats,
        telemetry: new Telemetry({ enabled: false, filePath: join(workspaceRoot, "telemetry") }),
        session,
        recordTranscript: () => {},
      },
      askUser: async () => false,
      askUserQuestion: async () => null,
      readInput: async () => (inputs.length > 0 ? inputs.shift()! : null),
      closeInput: () => {},
      injectInput: () => {},
      getPendingPromptCount: () => 0,
      makeCommandContext: () => ({
        messages,
        modelConfig,
        callModel,
        workspaceRoot,
        sessionId: session.id,
        persistence,
        stats,
        ui: { showTokens, verbose: false },
      }),
      isInteractive: false,
      quiet: true,
      getShowTokens: () => showTokens,
    };
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(((
      _chunk: unknown,
      encodingOrCallback?: unknown,
      callback?: unknown,
    ) => {
      const done =
        typeof encodingOrCallback === "function"
          ? encodingOrCallback
          : typeof callback === "function"
            ? callback
            : undefined;
      (done as (() => void) | undefined)?.();
      return true;
    }) as typeof process.stdout.write);

    const baseline = process.listeners("SIGINT");
    const repl = runRepl(deps);
    // runRepl installs its idle handler before the first await. Anything added
    // after the local command starts is that command's own cancellation hook.
    const idleListeners = process.listeners("SIGINT");
    try {
      await started;
      const turnListeners = process.listeners("SIGINT").filter((fn) => !idleListeners.includes(fn));
      expect(turnListeners).toHaveLength(1);
      turnListeners[0]!("SIGINT");
      await repl;

      expect(localAborted).toBe(true);
      expect(seen).toEqual(["@.env"]);
      expect(seen[0]).not.toContain("do-not-attach");
      expect(stats.apiCalls).toBe(1);
      expect(logs.mock.calls.flat().join(" ")).toContain("[tokens: 7 in / 3 out]");
      expect(process.listeners("SIGINT").filter((fn) => !idleListeners.includes(fn))).toEqual([]);
    } finally {
      finishCommand?.();
      await repl;
      for (const listener of process.listeners("SIGINT")) {
        if (!baseline.includes(listener)) process.removeListener("SIGINT", listener);
      }
    }
  });
});
