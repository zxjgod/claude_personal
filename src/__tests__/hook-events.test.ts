// ============================================================
// Tests: hook lifecycle events (`--include-hook-events`) and
//        prompt suggestions (`--prompt-suggestions`)
// ------------------------------------------------------------
// The stream-json consumer contract is the reason these two flags
// exist, so the tests assert on the EXACT frame sequence and field
// names rather than merely "something was emitted".
// ============================================================

import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../cli-args.js";
import { runHeadless } from "../headless.js";
import {
  clearHookLifecycleSink,
  type HookLifecycleEvent,
  hookLifecycleMessage,
  hookLifecycleName,
  hookLifecycleSinkActive,
  setHookLifecycleSink,
} from "../hook-events.js";
import { HookRegistry } from "../hooks.js";
import { registerHooksFromConfig } from "../hooks-config.js";
import { cleanSuggestion, generatePromptSuggestion } from "../prompt-suggestions.js";
import type { Message, ModelCaller } from "../types.js";

const node = JSON.stringify(process.execPath);

// Hook commands run with their cwd set to the workspace root. A throwaway
// directory is deliberately NOT used: on Windows a killed hook process keeps
// its cwd locked, so temp-dir cleanup raises EPERM and fails every later test.
const workspace = process.cwd();

afterEach(() => {
  clearHookLifecycleSink();
  process.exitCode = 0;
});

/** Collect lifecycle events the way the CLI does, minus the stdout writing. */
function collect(): { events: HookLifecycleEvent[]; frames: () => Record<string, unknown>[] } {
  const events: HookLifecycleEvent[] = [];
  setHookLifecycleSink((event) => events.push(event), { includeAll: true });
  return { events, frames: () => events.map((e) => hookLifecycleMessage(e, "s1")) };
}

/** A one-line PreToolUse command hook. */
function preToolHook(command: string, timeout?: number): HookRegistry {
  const registry = new HookRegistry();
  registerHooksFromConfig(
    registry,
    {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command, ...(timeout && { timeout }) }] },
      ],
    },
    { sessionId: "s1", workspaceRoot: workspace },
  );
  return registry;
}

// ============================================================
// Gate rules
// ============================================================

describe("hook lifecycle gate", () => {
  it("reports SessionStart without the flag and hides PreToolUse until it is given", async () => {
    const registry = new HookRegistry();
    registerHooksFromConfig(
      registry,
      {
        SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: `${node} -e ""` }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${node} -e ""` }] }],
      },
      { sessionId: "s1", workspaceRoot: workspace },
    );
    const seen: string[] = [];
    setHookLifecycleSink((e) => seen.push(e.hookEvent), { includeAll: false });
    await registry.runEvent("SessionStart", { source: "startup" });
    expect(seen).toEqual(["SessionStart", "SessionStart"]);

    seen.length = 0;
    await registry.runPre({ toolName: "bash", input: { command: "ls" } });
    // A PreToolUse hook produced no frames: the flag was not given.
    expect(seen).toEqual([]);

    // …and the same hook now reports when the flag IS given.
    setHookLifecycleSink((e) => seen.push(e.hookEvent), { includeAll: true });
    await registry.runPre({ toolName: "bash", input: { command: "ls" } });
    expect(seen).toEqual(["PreToolUse", "PreToolUse"]);
  });

  it("registers nothing for an event name outside the official phase list", () => {
    const seen: string[] = [];
    setHookLifecycleSink((e) => seen.push(e.hookEvent), { includeAll: true });
    const registry = new HookRegistry();
    registerHooksFromConfig(
      registry,
      {
        CustomEvent: [{ matcher: "*", hooks: [{ type: "command", command: `${node} -e ""` }] }],
      } as never,
      { sessionId: "s1", workspaceRoot: workspace },
    );
    expect(registry.size).toBe(0);
    expect(seen).toEqual([]);
  });

  it("names hooks `${event}:${matcher}` when matched, else the bare event", () => {
    expect(hookLifecycleName("PreToolUse", "Edit|Write")).toBe("PreToolUse:Edit|Write");
    expect(hookLifecycleName("SessionEnd", undefined)).toBe("SessionEnd");
  });
});

// ============================================================
// Message shapes
// ============================================================

describe("hookLifecycleMessage", () => {
  it("matches the official frame shape for started / progress / response", () => {
    const identity = { hookId: "id-1", hookName: "PreToolUse:Bash", hookEvent: "PreToolUse" };
    const started = hookLifecycleMessage({ ...identity, phase: "started" }, "s1");
    expect(started).toMatchObject({
      type: "system",
      subtype: "hook_started",
      session_id: "s1",
      hook_id: "id-1",
      hook_name: "PreToolUse:Bash",
      hook_event: "PreToolUse",
    });
    expect(typeof started.uuid).toBe("string");

    expect(
      hookLifecycleMessage(
        { ...identity, phase: "progress", stdout: "out", stderr: "err", output: "outerr" },
        "s1",
      ),
    ).toMatchObject({ subtype: "hook_progress", stdout: "out", stderr: "err", output: "outerr" });

    expect(
      hookLifecycleMessage(
        {
          ...identity,
          phase: "response",
          outcome: "success",
          output: "",
          stdout: "",
          stderr: "",
          exitCode: 0,
        },
        "s1",
      ),
    ).toMatchObject({
      subtype: "hook_response",
      outcome: "success",
      output: "",
      stdout: "",
      stderr: "",
      exit_code: 0,
    });
  });

  it("omits exit_code when the hook type has none", () => {
    const frame = hookLifecycleMessage(
      {
        hookId: "id-2",
        hookName: "SessionEnd",
        hookEvent: "SessionEnd",
        phase: "response",
        outcome: "error",
        output: "",
        stdout: "",
        stderr: "boom",
      },
      "s1",
    );
    expect(frame).not.toHaveProperty("exit_code");
    expect(frame).toMatchObject({ outcome: "error", stderr: "boom" });
  });
});

// ============================================================
// End-to-end: a real command hook
// ============================================================

describe("hook lifecycle from a command hook", () => {
  it("emits started → response(success) with stdout and exit code", async () => {
    const registry = preToolHook(`${node} -e "process.stdout.write('{\\"ok\\":true}')"`);
    const { events, frames } = collect();
    await registry.runPre({ toolName: "bash", input: { command: "ls" } });
    expect(events.map((e) => e.phase)).toEqual(["started", "response"]);
    const out = frames();
    expect(out[0]).toMatchObject({
      subtype: "hook_started",
      hook_event: "PreToolUse",
      hook_name: "PreToolUse:Bash",
    });
    expect(out[1]).toMatchObject({
      subtype: "hook_response",
      outcome: "success",
      exit_code: 0,
      stdout: '{"ok":true}',
    });
    // One hook invocation → one stable id across both frames.
    expect(out[0]!.hook_id).toBe(out[1]!.hook_id);
  });

  it("classifies a blocking hook as `blocking`", async () => {
    const registry = preToolHook(`${node} -e "process.stderr.write('nope');process.exit(2)"`);
    const { events, frames } = collect();
    const out = await registry.runPre({ toolName: "bash", input: { command: "rm -rf /" } });
    expect(out.block).toBe(true);
    expect(out.reason).toBe("nope");
    expect(events.at(-1)).toMatchObject({ phase: "response", outcome: "blocking" });
    expect(frames().at(-1)).toMatchObject({
      subtype: "hook_response",
      outcome: "blocking",
      exit_code: 2,
    });
  });

  it("classifies a crashing hook as non_blocking_error without changing fail-safe behaviour", async () => {
    const registry = preToolHook(`${node} -e "process.exit(3)"`);
    const { events, frames } = collect();
    const out = await registry.runPre({ toolName: "bash", input: { command: "ls" } });
    // Fail-safe preserved: a broken hook never blocks the user's work …
    expect(out.block).toBeUndefined();
    // … but the stream says the hook misbehaved.
    expect(events.at(-1)).toMatchObject({ phase: "response", outcome: "non_blocking_error" });
    expect(frames().at(-1)).toMatchObject({
      subtype: "hook_response",
      outcome: "non_blocking_error",
      exit_code: 3,
    });
  });

  it("streams hook_progress while a long-running hook produces output", async () => {
    const registry = preToolHook(
      `${node} -e "process.stdout.write('a');setTimeout(()=>{process.stdout.write('b');process.exit(0)},1400)"`,
      30,
    );
    const { events, frames } = collect();
    await registry.runPre({ toolName: "bash", input: { command: "ls" } });
    const progress = frames().filter((f) => f.subtype === "hook_progress");
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress.at(-1)).toMatchObject({ stdout: expect.stringContaining("a") });
    expect(events.at(-1)).toMatchObject({ phase: "response", outcome: "success" });
  }, 30_000);

  it("classifies a timed-out hook as cancelled", async () => {
    const registry = preToolHook(`${node} -e "setTimeout(()=>{},60000)"`, 1);
    const { events } = collect();
    await registry.runPre({ toolName: "bash", input: { command: "ls" } });
    expect(events.at(-1)).toMatchObject({ phase: "response", outcome: "cancelled" });
  }, 30_000);
});

// ============================================================
// --prompt-suggestions
// ============================================================

describe("cleanSuggestion", () => {
  it("strips fences, labels and quotes a chatty model adds", () => {
    expect(cleanSuggestion("```\nrun the tests\n```")).toBe("run the tests");
    expect(cleanSuggestion('"now add a regression test"')).toBe("now add a regression test");
    expect(cleanSuggestion("Next user message: refactor headless.ts")).toBe("refactor headless.ts");
    expect(cleanSuggestion("first line\nsecond line")).toBe("first line");
  });

  it("returns undefined when there is nothing usable", () => {
    expect(cleanSuggestion("   ")).toBeUndefined();
    expect(cleanSuggestion('""')).toBeUndefined();
  });
});

describe("generatePromptSuggestion", () => {
  const config = { provider: "custom" as const, model: "fixture", apiKey: "unused" };

  it("asks the model for one short line and returns it cleaned", async () => {
    let seen: { tools: unknown; system: string; maxTokens: number | undefined } | undefined;
    const callModel: ModelCaller = async function* (messages, tools, systemPrompt, cfg) {
      seen = { tools, system: systemPrompt, maxTokens: cfg.maxTokens };
      expect(messages).toHaveLength(1);
      yield { type: "text_delta", delta: '"now run the typecheck"' };
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "add a flag" }] },
      { role: "assistant", content: "added" },
    ];
    const suggestion = await generatePromptSuggestion({
      callModel,
      config,
      messages,
      finalText: "added",
    });
    expect(suggestion).toBe("now run the typecheck");
    expect(seen?.tools).toEqual([]);
    expect(seen?.maxTokens).toBeLessThan(1_000);
    expect(seen?.system).toContain("predict");
  });

  it("degrades to no suggestion on API failure instead of failing the turn", async () => {
    const callModel: ModelCaller = async function* () {
      yield { type: "error", error: "rate limited" } as never;
    };
    await expect(
      generatePromptSuggestion({
        callModel,
        config,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        finalText: "done",
      }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when there is no conversation to reason about", async () => {
    const callModel: ModelCaller = async function* () {
      yield { type: "text_delta", delta: "anything" };
    };
    await expect(
      generatePromptSuggestion({ callModel, config, messages: [], finalText: "" }),
    ).resolves.toBeUndefined();
  });
});

// ============================================================
// End-to-end through runHeadless
// ============================================================

describe("runHeadless with the two flags", () => {
  const config = { provider: "custom" as const, model: "fixture", apiKey: "unused" };

  function twoPhaseCaller(answer: string, suggestion: string): ModelCaller {
    let call = 0;
    return async function* () {
      call += 1;
      yield { type: "text_delta", delta: call === 1 ? answer : suggestion };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
  }

  async function run(argv: string[], callModel: ModelCaller, sessionId: string): Promise<string[]> {
    const emitted: string[] = [];
    await runHeadless({
      args: parseCliArgs(argv),
      input: Readable.from([]),
      emit: (value) => emitted.push(value),
      messages: [],
      tools: [],
      callModel,
      config,
      context: { workspaceRoot: process.cwd(), sessionId, permissionMode: "plan" },
      save: async () => {},
      systemPrompt: "",
    });
    return emitted;
  }

  it("emits prompt_suggestion AFTER the result frame", async () => {
    const frames = (
      await run(
        ["-p", "hi", "--output-format", "stream-json", "--prompt-suggestions"],
        twoPhaseCaller("all done", "now add tests"),
        "s-suggest",
      )
    ).map((line) => JSON.parse(line));
    const resultAt = frames.findIndex((f) => f.type === "result");
    const suggestionAt = frames.findIndex((f) => f.type === "prompt_suggestion");
    expect(resultAt).toBeGreaterThanOrEqual(0);
    expect(suggestionAt).toBe(resultAt + 1);
    expect(frames[suggestionAt]).toMatchObject({
      type: "prompt_suggestion",
      suggestion: "now add tests",
      session_id: "s-suggest",
    });
  });

  it("does not emit a suggestion without the flag", async () => {
    const emitted = await run(
      ["-p", "hi", "--output-format", "stream-json"],
      twoPhaseCaller("all done", "now add tests"),
      "s-nosuggest",
    );
    expect(emitted.some((line) => line.includes("prompt_suggestion"))).toBe(false);
  });

  it("does not emit a suggestion in text mode (no stream to carry it)", async () => {
    const emitted = await run(
      ["-p", "hi", "--prompt-suggestions"],
      twoPhaseCaller("all done", "now add tests"),
      "s-text",
    );
    expect(emitted.join("")).not.toContain("prompt_suggestion");
  });

  it("emits no suggestion for a failed turn", async () => {
    const emitted = await run(
      ["-p", "hi", "--output-format", "stream-json", "--prompt-suggestions"],
      async function* () {
        yield { type: "error", error: "provider exploded" } as never;
      },
      "s-err",
    );
    expect(emitted.some((line) => line.includes("prompt_suggestion"))).toBe(false);
  });

  it("leaves a caller-installed hook sink in place after the run", async () => {
    const callerSink = vi.fn();
    setHookLifecycleSink(callerSink, { includeAll: true });
    await run(
      ["-p", "hi", "--output-format", "stream-json"],
      twoPhaseCaller("done", "x"),
      "s-keep",
    );
    // The CLI relies on this: it installs the sink before SessionStart runs and
    // expects the SessionEnd hook (after runHeadless returns) to still report.
    expect(hookLifecycleSinkActive()).toBe(true);
    const registry = preToolHook(`${node} -e ""`);
    await registry.runPre({ toolName: "bash", input: { command: "ls" } });
    expect(callerSink).toHaveBeenCalledTimes(2);
  });

  it("installs and releases its own sink for a standalone caller", async () => {
    await run(["-p", "hi", "--output-format", "stream-json"], twoPhaseCaller("done", "x"), "s-own");
    expect(hookLifecycleSinkActive()).toBe(false);
  });
});
