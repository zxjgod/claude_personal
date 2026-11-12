import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import Ajv from "ajv";
import { agentLoop } from "./agent-loop.js";
import { beginUserTurn } from "./checkpoint.js";
import type { parseCliArgs } from "./cli-args.js";
import { sessionGoal } from "./goal-runtime.js";
import { HeadlessControlChannel } from "./headless-control.js";
import {
  clearHookLifecycleSink,
  hookLifecycleMessage,
  hookLifecycleSinkActive,
  setHookLifecycleSink,
} from "./hook-events.js";
import { configBudget, withModelBudget } from "./model-budget.js";
import { type ModelPricing, modelPricing } from "./model-metadata.js";
import { checkPermission } from "./permissions.js";
import { generatePromptSuggestion } from "./prompt-suggestions.js";
import type {
  AskUserFn,
  HookRunner,
  Message,
  ModelCaller,
  ModelConfig,
  Tool,
  ToolContext,
} from "./types.js";

/**
 * Route hook lifecycle events into the stream-json output.
 *
 * Exported because the CLI has to install the sink EARLIER than this function
 * runs: `SessionStart` fires before the print path is entered, and official
 * reports SessionStart lifecycle events unconditionally — installing only here
 * would silently drop the one event consumers are guaranteed to see.
 */
export function installHookEventStream(
  write: (line: string) => void,
  sessionId: string,
  includeAll: boolean,
): void {
  setHookLifecycleSink(
    (event) => write(`${JSON.stringify(hookLifecycleMessage(event, sessionId))}\n`),
    { includeAll },
  );
}

export async function* headlessInputs(
  args: ReturnType<typeof parseCliArgs>,
  input: NodeJS.ReadableStream,
): AsyncGenerator<string> {
  if (args.inputFormat === "stream-json" && (input as { isTTY?: boolean }).isTTY)
    throw new Error(
      "stream-json input requires a pipe or file; interactive terminal input is unsupported",
    );
  if (args.inputFormat === "stream-json") {
    if (args.prompt) yield args.prompt;
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const value = JSON.parse(line) as {
          type?: string;
          prompt?: unknown;
          content?: unknown;
          message?: { role?: string; content?: unknown };
        };
        if (value.type && value.type !== "user")
          throw new Error(`Unsupported input message: ${value.type}`);
        const content = value.message?.content ?? value.prompt ?? value.content;
        if (typeof content === "string") yield content;
        else if (Array.isArray(content))
          yield content
            .filter((block) => block?.type === "text")
            .map((block) => block.text)
            .join("\n");
        else throw new Error("Expected a user message with text content");
      }
    } finally {
      lines.close();
    }
    return;
  }
  // Text mode. A piped stdin is READ EVEN WHEN -p GAVE A PROMPT (review fix
  // "带 prompt 时静默丢弃 text stdin"): the documented pattern
  // `git diff | ccr -p "总结这次改动"` expects the pipe to be the OBJECT and
  // the flag to be the INSTRUCTION — the old code shipped only the flag and
  // the model answered about a diff it never saw. Both land in ONE user
  // message; an interactive TTY is never read here. With a prompt present the
  // stdin read waits only briefly for the FIRST chunk: many parents spawn us
  // with a stdin pipe they never write to and never close, and blocking for
  // that EOF would hang the run. 2s (not shorter — self-review fix: a cold
  // `git diff` on a large repo can legitimately take >300ms to emit its first
  // byte, and the timeout ABANDONS the pipe, degrading to a prompt-only run).
  const stdinText = await readTextStdin(input, args.prompt ? 2000 : undefined);
  if (args.prompt && stdinText) {
    yield `${args.prompt}\n\n${stdinText}`;
    return;
  }
  if (args.prompt) {
    yield args.prompt;
    return;
  }
  if (stdinText) yield stdinText;
}

/** Drain a NON-TTY stdin fully (bounded), trimmed; empty when TTY/blank.
 *  `firstChunkTimeoutMs` gives up (returning "") when no data arrives in
 *  time — used when a -p prompt already exists and stdin may be an idle,
 *  never-closed pipe. */
async function readTextStdin(
  input: NodeJS.ReadableStream,
  firstChunkTimeoutMs?: number,
): Promise<string> {
  if ((input as { isTTY?: boolean }).isTTY) return "";
  // Chunks are Buffers (stdin has no encoding set): `+= chunk` would decode
  // each chunk independently and corrupt multi-byte characters split across
  // a ~64KB pipe boundary. A StringDecoder carries partial sequences across
  // chunk edges. Bounded so a runaway producer can't exhaust memory.
  const MAX_STDIN_CHARS = 8 * 1024 * 1024;
  const decoder = new StringDecoder("utf8");
  let text = "";
  const iterator = input[Symbol.asyncIterator]();
  try {
    let awaitingFirst = firstChunkTimeoutMs !== undefined;
    while (true) {
      let next: IteratorResult<unknown>;
      if (awaitingFirst) {
        awaitingFirst = false;
        let timedOut = false;
        const timeout = new Promise<IteratorResult<unknown>>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve({ done: true, value: undefined });
          }, firstChunkTimeoutMs),
        );
        next = await Promise.race([iterator.next(), timeout]);
        if (timedOut) {
          // Idle pipe: DESTROY it. A pending async-iterator read keeps the
          // stdin handle referenced, which kept the process alive after the
          // result frame instead of exiting (observed with parents that pipe
          // stdin but never write or close it).
          try {
            (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
          } catch {
            /* stream already gone */
          }
          return "";
        }
        if (next.done && text === "") return ""; // closed empty pipe
      } else {
        next = await iterator.next();
      }
      if (next.done) break;
      text += decoder.write(next.value as Buffer);
      if (text.length > MAX_STDIN_CHARS)
        throw new Error(`stdin prompt exceeds ${MAX_STDIN_CHARS} characters`);
    }
  } finally {
    // Release the iterator WITHOUT awaiting it: on the idle-pipe timeout the
    // pending next() only settles once the stream is destroyed, and awaiting
    // return() here re-blocked the exact hang this timeout exists to break.
    try {
      const released = iterator.return?.() as Promise<unknown> | undefined;
      if (released && typeof released.then === "function") released.catch(() => {});
    } catch {
      /* stream already gone */
    }
    text += decoder.end();
  }
  return text.trim();
}
/**
 * Continuous stream-json input pump. Unlike a plain generator pulled by the
 * turn loop, the reader runs independently: control frames (interrupt,
 * set_model, permission responses) are handled WHILE a turn is executing,
 * and user messages queue for sequential turns. EOF closes the queue and
 * fails closed every parked permission ask.
 */
async function* streamJsonPrompts(
  args: ReturnType<typeof parseCliArgs>,
  input: NodeJS.ReadableStream,
  control: HeadlessControlChannel,
  shutdownSignal: AbortSignal,
): AsyncGenerator<string> {
  if ((input as { isTTY?: boolean }).isTTY)
    throw new Error(
      "stream-json input requires a pipe or file; interactive terminal input is unsupported",
    );
  const queue: string[] = [];
  if (args.prompt) queue.push(args.prompt);
  let closed = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const onShutdown = () => {
    queue.length = 0;
    closed = true;
    lines.close();
    (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    notify();
  };
  shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  if (shutdownSignal.aborted) onShutdown();
  const reader = (async () => {
    try {
      for await (const line of lines) {
        if (shutdownSignal.aborted) break;
        if (!line.trim()) continue;
        const value = JSON.parse(line) as {
          type?: string;
          request_id?: unknown;
          request?: unknown;
          response?: unknown;
          prompt?: unknown;
          content?: unknown;
          message?: { role?: string; content?: unknown };
        };
        if (value?.type === "control_request") {
          control.handleRequest(value.request_id, value.request);
          continue;
        }
        if (value?.type === "control_response") {
          control.handleResponse(value.response);
          continue;
        }
        if (value?.type && value.type !== "user")
          throw new Error(`Unsupported input message: ${value.type}`);
        const content = value?.message?.content ?? value?.prompt ?? value?.content;
        if (typeof content === "string") queue.push(content);
        else if (Array.isArray(content))
          queue.push(
            content
              .filter((block) => block?.type === "text")
              .map((block) => block.text)
              .join("\n"),
          );
        else throw new Error("Expected a user message with text content");
        notify();
      }
    } catch (error) {
      failure = error;
    } finally {
      closed = true;
      control.denyAllPending("permission prompt input stream closed");
      notify();
    }
  })();
  // The reader never rejects: input failures are stored and rethrown by the
  // consumer below so the outer handler still emits a terminal result frame.
  void reader;
  try {
    while (true) {
      while (queue.length > 0 && !shutdownSignal.aborted) yield queue.shift()!;
      if (failure) throw failure;
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    shutdownSignal.removeEventListener("abort", onShutdown);
    lines.close();
    control.denyAllPending("headless session ended");
  }
}

export async function runHeadless(deps: {
  args: ReturnType<typeof parseCliArgs>;
  input: NodeJS.ReadableStream;
  emit(value: string): void;
  messages: Message[];
  tools: Tool[];
  callModel: ModelCaller;
  config: ModelConfig;
  context: ToolContext;
  hooks?: HookRunner;
  systemPrompt: string;
  save(messages: Message[]): Promise<void>;
}): Promise<void> {
  const { args, context } = deps;
  const streamJson = args.outputFormat === "stream-json";
  const json = (value: unknown) => deps.emit(`${JSON.stringify(value)}\n`);
  const jsonResults: unknown[] = [];
  // Pre-flight failures (bad --max-budget-usd, unknown pricing, a malformed
  // --json-schema) used to be thrown BEFORE the guarded section below, so the
  // process died with a stack trace and stream-json consumers never received a
  // terminal frame. Everything that can reject a CLI flag goes through here.
  const failFast = (message: string): never => {
    process.exitCode = 1;
    const frame = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "",
      errors: [message],
      session_id: context.sessionId,
      uuid: randomUUID(),
    };
    if (args.outputFormat === "text") console.error(`headless: ${message}`);
    else json(frame);
    throw new Error(message);
  };
  let price: ModelPricing | null = null;
  let validator: ReturnType<Ajv.default["compile"]> | undefined;
  try {
    if (
      args.maxBudgetUsd !== undefined &&
      (!Number.isFinite(args.maxBudgetUsd) || args.maxBudgetUsd <= 0)
    )
      throw new Error("--max-budget-usd must be positive");
    if (args.permissionPromptTool !== undefined && args.permissionPromptTool !== "stdio")
      throw new Error(
        '--permission-prompt-tool: only "stdio" is supported; MCP permission tools are not implemented',
      );
    if (
      args.permissionPromptTool === "stdio" &&
      (args.inputFormat !== "stream-json" || args.outputFormat !== "stream-json")
    )
      throw new Error(
        "--permission-prompt-tool stdio requires --input-format stream-json and --output-format stream-json",
      );
    price = modelPricing(deps.config.model);
    if (args.maxBudgetUsd && !price)
      throw new Error(
        "Budget enforcement requires configured model pricing; this model has no known price",
      );
    validator = args.jsonSchema
      ? new Ajv.default({ allErrors: true, strict: false }).compile(JSON.parse(args.jsonSchema))
      : undefined;
  } catch (error) {
    return failFast(error instanceof Error ? error.message : String(error));
  }
  if (args.maxBudgetUsd)
    deps.config.options = {
      ...deps.config.options,
      ccrBudget: { limit: args.maxBudgetUsd, spent: 0, reserved: 0 },
    };
  const spent = () => configBudget(deps.config)?.spent ?? 0;
  let estimatedCost = 0;
  // Standalone callers get their own sink; the CLI has already installed an
  // equivalent one (see installHookEventStream) and must keep it so the
  // SessionEnd hook that runs after this function returns is still reported.
  const ownsHookSink = streamJson && !hookLifecycleSinkActive();
  if (ownsHookSink) installHookEventStream(deps.emit, context.sessionId, args.includeHookEvents);
  if (streamJson)
    json({
      type: "system",
      subtype: "init",
      session_id: context.sessionId,
      cwd: context.workspaceRoot,
      model: deps.config.model,
      tools: deps.tools.map((tool) => tool.name),
      uuid: randomUUID(),
    });
  const budgetCaller = withModelBudget(deps.callModel);
  // Control channel exists for every bidirectional stream-json session (interrupt,
  // set_model, set_permission_mode, initialize). can_use_tool approval frames
  // only flow when the peer opted in via --permission-prompt-tool stdio —
  // without it, asks stay auto-denied exactly as before.
  let turnAbort: AbortController | undefined;
  const shutdown = new AbortController();
  const control =
    args.inputFormat === "stream-json" && streamJson
      ? new HeadlessControlChannel(json, {
          interrupt: () => turnAbort?.abort("interrupted via control request"),
          shutdown: () => {
            turnAbort?.abort("SDK session shutting down");
            shutdown.abort();
          },
          setModel: (model) => {
            // The channel guarantees a non-empty model name (resets and
            // blanks are answered with an error frame before we get here).
            deps.config.model = model;
            // Adopt the new model's pricing even when unknown (null): keeping
            // the previous price would report later turns' cost at stale rates
            // instead of unknown.
            price = modelPricing(model);
          },
          setPermissionMode: (mode) => {
            context.permissionMode = mode;
          },
          currentModel: () => deps.config.model,
        })
      : undefined;
  const askUser: AskUserFn =
    control && args.permissionPromptTool === "stdio"
      ? async (tool, input, riskHint, requestContext) => {
          const decision = await control.requestPermission(tool.name, input, riskHint);
          if (decision.behavior !== "allow") {
            if (decision.interrupt) turnAbort?.abort("permission denied with interrupt");
            return false;
          }
          if (decision.updatedInput) {
            // Tool-specific checks (for example MCP and MemorySave) call
            // context.askUser internally and may pass a display-only copy.
            // A rewrite there cannot safely be applied to the executor input.
            if (requestContext?.source !== "permission") return false;
            const executionContext = requestContext.toolContext ?? context;
            try {
              const validated = (
                tool.validateInput
                  ? tool.validateInput(decision.updatedInput)
                  : decision.updatedInput
              ) as Record<string, unknown>;
              const permissionRecheck = await checkPermission(tool, validated, executionContext, {
                askUser: async () => true,
                classifier: executionContext.permissionClassifier,
              });
              if (!permissionRecheck.allowed) return false;
              // A few tool-level checks contain their own approval prompt.
              // The current can_use_tool response already approved this exact
              // rewritten input, so recheck their policy without opening a
              // second prompt. Preserve any approval state they record.
              const recheckContext: ToolContext = {
                ...executionContext,
                askUser: async () => true,
              };
              const toolRecheck = await tool.checkPermissions(validated, recheckContext);
              if (!toolRecheck.allowed) return false;
              if (recheckContext.approvedUserMemoryWrite !== undefined)
                executionContext.approvedUserMemoryWrite = recheckContext.approvedUserMemoryWrite;
              // checkPermission hands us the executor's input object by
              // reference and the executor runs that same object — rewrite
              // in place so the approved input is what actually executes.
              for (const key of Object.keys(input)) delete input[key];
              Object.assign(input, validated);
            } catch {
              return false;
            }
          }
          return true;
        }
      : async () => false;
  // Review fix ("json 模式多对象"): `--output-format json` used to emit one
  // JSON object PER PROMPT — with both -p and stdin (or any multi-prompt
  // input) stdout held several concatenated objects, which is not a valid
  // JSON document for consumers. json mode is not streaming, so buffer the
  // per-prompt results and flush them as ONE document at the end (a single
  // result stays a bare object; multiple become an array).
  try {
    const prompts = control
      ? streamJsonPrompts(args, deps.input, control, shutdown.signal)
      : headlessInputs(args, deps.input);
    for await (const prompt of prompts) {
      const started = Date.now();
      turnAbort = new AbortController();
      context.abortSignal = turnAbort.signal;
      const message: Message = { role: "user", content: [{ type: "text", text: prompt }] };
      beginUserTurn(context.sessionId, message);
      deps.messages.push(message);
      const inheritedMessages = new Set(deps.messages);
      if (args.outputFormat === "stream-json" && args.replayUserMessages)
        json({
          type: "user",
          message: { role: "user", content: message.content },
          session_id: context.sessionId,
          uuid: randomUUID(),
        });
      let text = "";
      let error: string | undefined;
      // A cancelled turn (control interrupt / abort) is a clean stop, not a
      // process failure: it still reports an is_error result frame, but must
      // not poison process.exitCode — otherwise the SDK sees a non-zero exit
      // after the result frame and emits a spurious abnormal_exit, and the
      // sticky code 1 misreports every later successful turn too.
      let interrupted = false;
      let turns = 0;
      const usage = { input_tokens: 0, output_tokens: 0 };
      const systemPrompt = `${args.systemPrompt ?? deps.systemPrompt}${args.appendSystemPrompt ? `\n\n${args.appendSystemPrompt}` : ""}${args.jsonSchema ? `\n\nReturn the final answer as JSON satisfying this schema: ${args.jsonSchema}` : ""}`;
      try {
        const loop = agentLoop(deps.messages, deps.tools, budgetCaller, deps.config, {
          systemPrompt,
          maxTurns: args.maxTurns,
          abortSignal: turnAbort.signal,
          askUser,
          hooks: deps.hooks,
          toolContext: context,
        });
        while (true) {
          const step = await loop.next();
          if (step.done) {
            turns = step.value.turns;
            interrupted = step.value.reason.startsWith("aborted");
            error =
              step.value.reason === "completed" || step.value.reason === "stop_hook_prevented"
                ? undefined
                : `${step.value.reason}${step.value.error ? `: ${String(step.value.error)}` : ""}`;
            break;
          }
          const event = step.value;
          if (event.type === "text_delta") {
            text += event.delta;
            if (args.outputFormat === "stream-json" && args.includePartialMessages)
              json({
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: event.delta },
                },
                session_id: context.sessionId,
                uuid: randomUUID(),
              });
          }
          if (event.type === "error") error = String(event.error);
          if (event.type === "aborted") error = event.reason;
          if (event.type === "done") {
            turns = event.turns;
            if (event.finishReason !== "end_turn") error = event.message || event.finishReason;
          }
          if (event.type === "usage") {
            if (price)
              estimatedCost +=
                (event.usage.input_tokens * price.input +
                  event.usage.output_tokens * price.output) /
                1e6;
            usage.input_tokens += event.usage.input_tokens;
            usage.output_tokens += event.usage.output_tokens;
          }
          if (args.outputFormat === "stream-json" && event.type === "tool_use")
            json({
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "tool_use", id: event.id, name: event.name, input: event.input }],
              },
              session_id: context.sessionId,
              uuid: randomUUID(),
            });
          if (args.outputFormat === "stream-json" && event.type === "tool_result")
            json({
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: event.id,
                    content: event.result.formatted,
                    is_error: event.result.isError,
                  },
                ],
              },
              session_id: context.sessionId,
              uuid: randomUUID(),
            });
        }
      } catch (failure) {
        error = String(failure);
      }
      const final = deps.messages
        .filter((entry) => !inheritedMessages.has(entry))
        .reverse()
        .find((entry) => entry.role === "assistant" && typeof entry.content === "string");
      if (final?.role === "assistant" && typeof final.content === "string") text = final.content;
      let structured: unknown;
      if (validator && !error) {
        try {
          structured = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
          if (!validator(structured))
            error = `Structured output invalid: ${JSON.stringify(validator.errors)}`;
        } catch (failure) {
          error = `Structured output invalid: ${String(failure)}`;
        }
      }
      // Review fix: a persistence failure must not abort the run BEFORE the
      // result frame — the caller then loses the machine-readable terminal
      // frame entirely (the conversation is still in memory; the next
      // auto-save retries). Warn and continue.
      if (!args.noSessionPersistence) {
        try {
          await deps.save(deps.messages);
        } catch (saveError) {
          console.error(
            `headless: session save failed (continuing; result frame unaffected): ${
              saveError instanceof Error ? saveError.message : String(saveError)
            }`,
          );
        }
      }
      const result = {
        type: "result",
        subtype: error ? "error_during_execution" : "success",
        is_error: !!error,
        result: text,
        ...(error && { errors: [error] }),
        ...(structured !== undefined && !error && { structured_output: structured }),
        session_id: context.sessionId,
        duration_ms: Date.now() - started,
        num_turns: turns,
        usage,
        ...(sessionGoal(context.sessionId) && { goal_state: sessionGoal(context.sessionId) }),
        total_cost_usd: args.maxBudgetUsd ? spent() : price ? estimatedCost : null,
        uuid: randomUUID(),
      };
      if (args.outputFormat === "stream-json")
        json({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text }] },
          session_id: context.sessionId,
          uuid: randomUUID(),
        });
      if (args.outputFormat === "text") deps.emit(`${text}${text ? "\n" : ""}`);
      else if (streamJson) json(result);
      else jsonResults.push(result);
      // Official emits the prediction AFTER the `result` frame, so a consumer
      // reading frames in order still sees the turn complete first.
      if (streamJson && args.promptSuggestions && !error) {
        const suggestion = await generatePromptSuggestion({
          callModel: budgetCaller,
          config: deps.config,
          messages: deps.messages,
          finalText: text,
        });
        if (suggestion)
          json({
            type: "prompt_suggestion",
            suggestion,
            session_id: context.sessionId,
            uuid: randomUUID(),
          });
      }
      if (error && !interrupted) process.exitCode = 1;
    }
  } catch (failure) {
    // Review fix ("畸形行崩溃丢 result 帧"): a malformed stream-json input
    // line (or any other input-side failure) used to propagate out of the
    // for-await and crash the process WITHOUT any terminal result frame —
    // stream-json/json consumers were left waiting forever. Emit an error
    // result frame instead, so the protocol always terminates cleanly.
    const message = failure instanceof Error ? failure.message : String(failure);
    process.exitCode = 1;
    const errorResult = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "",
      errors: [message],
      session_id: context.sessionId,
      uuid: randomUUID(),
    };
    if (streamJson) json(errorResult);
    else if (args.outputFormat === "json") jsonResults.push(errorResult);
    else console.error(`headless: ${message}`);
  } finally {
    // Flush buffered json-mode results as ONE document (see jsonResults).
    if (args.outputFormat === "json" && jsonResults.length > 0) {
      deps.emit(`${JSON.stringify(jsonResults.length === 1 ? jsonResults[0] : jsonResults)}\n`);
    }
    if (ownsHookSink) clearHookLifecycleSink();
  }
}
