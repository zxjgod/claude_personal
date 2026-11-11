import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import { basename, dirname, resolve } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { PermissionMode } from "./types.js";

export interface CanUseToolContext {
  signal: AbortSignal;
  suggestions: unknown[];
}
export type CanUseToolResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string; interrupt?: boolean };
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  context: CanUseToolContext,
) => Promise<CanUseToolResult>;

export interface QueryOptions {
  cliExecutable?: string;
  cliModule?: string;
  cwd?: string;
  env?: Record<string, string>;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  jsonSchema?: Record<string, unknown>;
  resume?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  signal?: AbortSignal;
  /** Permission callback; enables the CLI's stdio control protocol. */
  canUseTool?: CanUseTool;
}
export interface SDKMessage {
  type: string;
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  [field: string]: unknown;
}
/** Query generator with mid-turn control methods (official SDK shape). */
export interface Query extends AsyncGenerator<SDKMessage> {
  /** Abort the current turn; the CLI still emits its result frame. */
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
}

const CONTROL_TIMEOUT_MS = 60_000;

/** Programmatic local CLI interface. API keys and provider endpoints are supplied via env. */
export function query(input: {
  prompt: string | AsyncIterable<string>;
  options?: QueryOptions;
}): Query {
  const options = input.options ?? {};
  // Shared code moves into dist/chunks during the split build; the CLI stays
  // at dist/cli.js. A per-file build still uses the adjacent entry. From source
  // there is no src/cli.js, so preserve the early, descriptive error below.
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const defaultModule = resolve(
    moduleDirectory,
    basename(moduleDirectory) === "chunks" ? "../cli.js" : "cli.js",
  );
  if (!options.cliExecutable && !options.cliModule && !fs.existsSync(defaultModule)) {
    throw new Error(
      `SDK query() found no CLI entry at ${defaultModule}. ` +
        "Build the project first, or pass options.cliModule / options.cliExecutable.",
    );
  }
  // Spawn stays lazy (first iteration) so an unconsumed query leaks nothing;
  // control methods report a clear error when used before iteration starts.
  let child: ChildProcessWithoutNullStreams | undefined;
  let inputExhausted = false;
  let promptsSent = 0;
  let resultsSeen = 0;
  let controlSeq = 0;
  const pendingControl = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const activePermissionCallbacks = new Set<AbortController>();
  const abortPermissionCallbacks = (reason: string) => {
    for (const controller of activePermissionCallbacks) controller.abort(reason);
    activePermissionCallbacks.clear();
  };
  const writeLine = (value: unknown) => {
    if (!child || child.stdin.destroyed || child.stdin.writableEnded)
      throw new Error("CLI stdin is not writable (query not started or already finished)");
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const writeControl = (request: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const requestId = `sdk-${++controlSeq}-${Date.now().toString(36)}`;
      const timer = setTimeout(() => {
        pendingControl.delete(requestId);
        reject(new Error(`Control request ${String(request.subtype)} timed out`));
      }, CONTROL_TIMEOUT_MS);
      pendingControl.set(requestId, { resolve, reject, timer });
      try {
        writeLine({ type: "control_request", request_id: requestId, request });
      } catch (error) {
        clearTimeout(timer);
        pendingControl.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  const rejectAllPending = (reason: string) => {
    for (const pending of pendingControl.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    pendingControl.clear();
  };
  // Stdin must outlive the prompts: control methods (interrupt) and permission
  // responses write mid-turn. The CLI guarantees one result frame per turn, so
  // close stdin only after the input side is exhausted AND every sent prompt
  // has produced its result frame.
  const maybeEndInput = () => {
    if (inputExhausted && resultsSeen >= promptsSent && child && !child.stdin.writableEnded)
      child.stdin.end();
  };

  const generator = (async function* (): AsyncGenerator<SDKMessage> {
    const argv = [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ];
    if (!options.cliExecutable) argv.unshift(options.cliModule ?? defaultModule);
    for (const [flag, value] of [
      ["--max-turns", options.maxTurns],
      ["--max-budget-usd", options.maxBudgetUsd],
      ["--resume", options.resume],
    ] as const)
      if (value !== undefined) argv.push(flag, String(value));
    if (options.jsonSchema) argv.push("--json-schema", JSON.stringify(options.jsonSchema));
    if (options.model) argv.push("--model", options.model);
    if (options.allowedTools?.length) argv.push("--allowedTools", options.allowedTools.join(","));
    if (options.disallowedTools?.length)
      argv.push("--disallowedTools", options.disallowedTools.join(","));
    if (options.canUseTool) argv.push("--permission-prompt-tool", "stdio");
    const proc = spawn(options.cliExecutable ?? process.execPath, argv, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        ...(options.model ? { LLM_MODEL: options.model } : {}),
      },
      windowsHide: true,
      stdio: "pipe",
      signal: options.signal,
    });
    child = proc;
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    proc.stdin.on("error", () => {});
    const finished = new Promise<number | null>((resolve, reject) => {
      proc.once("close", resolve);
      proc.once("error", reject);
    });
    void finished.catch(() => {});
    const feeder = (async () => {
      try {
        const prompts = typeof input.prompt === "string" ? [input.prompt] : input.prompt;
        for await (const prompt of prompts) {
          if (options.signal?.aborted) break;
          promptsSent++;
          const writable = proc.stdin.write(
            `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`,
          );
          if (!writable)
            await new Promise<void>((resolve) => {
              proc.stdin.once("drain", resolve);
              proc.stdin.once("close", resolve);
            });
        }
      } finally {
        inputExhausted = true;
        maybeEndInput();
      }
    })();
    void feeder.catch(() => proc.kill());
    const answerControl = (requestId: string, response: Record<string, unknown>) => {
      try {
        writeLine({ type: "control_response", response: { request_id: requestId, ...response } });
      } catch {
        // stdin already closed — the CLI fails parked asks closed on EOF.
      }
    };
    let resultSeen = false;
    const lines = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    // The reader runs independently of the consumer: control responses and
    // permission callbacks are serviced even while the consumer is blocked
    // (e.g. awaiting interrupt() inside the message loop). Conversation
    // messages queue for the yield loop below.
    const queue: SDKMessage[] = [];
    let readerDone = false;
    let readerError: unknown;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const push = (message: SDKMessage) => {
      queue.push(message);
      notify();
    };
    const reader = (async () => {
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          let message: SDKMessage;
          try {
            message = JSON.parse(line) as SDKMessage;
          } catch {
            // A stray non-JSON line on stdout (a hook/tool printing directly, a
            // banner, a partial line after a kill) used to throw out of the
            // generator: the caller lost every already-yielded message AND got an
            // opaque SyntaxError instead of the CLI's own result frame. Report it
            // as a protocol message and keep reading.
            push({
              type: "system",
              subtype: "non_json_stdout",
              is_error: true,
              message: line.slice(0, 2000),
            });
            continue;
          }
          // Control protocol frames are SDK plumbing, not conversation messages.
          if (message.type === "control_request") {
            const requestId = message.request_id as string;
            const request = message.request as
              | {
                  subtype?: string;
                  tool_name?: string;
                  input?: Record<string, unknown>;
                  permission_suggestions?: unknown[];
                }
              | undefined;
            if (request?.subtype === "can_use_tool" && options.canUseTool) {
              const canUseTool = options.canUseTool;
              const callbackController = new AbortController();
              activePermissionCallbacks.add(callbackController);
              const callbackSignal = options.signal
                ? AbortSignal.any([options.signal, callbackController.signal])
                : callbackController.signal;
              // Do not await: a slow callback must not block reading (an
              // interrupt can arrive while an approval is pending).
              void (async () => {
                try {
                  const decision = await canUseTool(request.tool_name ?? "", request.input ?? {}, {
                    signal: callbackSignal,
                    suggestions: request.permission_suggestions ?? [],
                  });
                  answerControl(requestId, { subtype: "success", response: decision });
                } catch (error) {
                  answerControl(requestId, {
                    subtype: "error",
                    error: error instanceof Error ? error.message : String(error),
                  });
                } finally {
                  activePermissionCallbacks.delete(callbackController);
                }
              })();
            } else {
              answerControl(requestId, {
                subtype: "error",
                error: `Unsupported control request: ${request?.subtype ?? "(missing)"}`,
              });
            }
            continue;
          }
          if (message.type === "control_response") {
            const response = message.response as
              | {
                  subtype?: string;
                  request_id?: string;
                  response?: Record<string, unknown>;
                  error?: string;
                }
              | undefined;
            const pending = response?.request_id
              ? pendingControl.get(response.request_id)
              : undefined;
            if (pending && response?.request_id) {
              pendingControl.delete(response.request_id);
              clearTimeout(pending.timer);
              if (response.subtype === "error")
                pending.reject(new Error(response.error ?? "control request failed"));
              else pending.resolve(response.response ?? {});
            }
            continue;
          }
          if (message.type === "result") {
            resultSeen = true;
            resultsSeen++;
            maybeEndInput();
          }
          push(message);
        }
        const code = await finished;
        await feeder;
        rejectAllPending("CLI exited before the control response arrived");
        // Review fix ("异常终止被当作正常结束"): signal kills surface as
        // code === null and were silently treated as success; and once ANY result
        // frame had been seen, later non-zero exits were ignored too. Both paths
        // now report: no result yet → throw; result seen but the CLI still died
        // non-zero (or was signalled, unless WE aborted it) → emit an error frame
        // so consumers can distinguish complete from truncated runs.
        const abortedByUs = code === null && options.signal?.aborted === true;
        if (code !== 0 && !abortedByUs) {
          if (!resultSeen) throw new Error(`CLI exited ${code ?? "on a signal"}: ${stderr}`);
          push({
            type: "system",
            subtype: "abnormal_exit",
            is_error: true,
            message: `CLI exited ${code ?? "on a signal"} after the result frame: ${stderr.slice(-500)}`,
          });
        }
      } catch (error) {
        readerError = error;
      } finally {
        readerDone = true;
        notify();
      }
    })();
    // The reader never rejects: failures surface through the yield loop below.
    void reader;
    try {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (readerError) throw readerError;
        if (readerDone) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      // Release the stdout pipe even when the consumer abandons the generator
      // early (otherwise the readline handle and the child both stay alive).
      abortPermissionCallbacks("query closed");
      rejectAllPending("query closed before the control response arrived");
      lines.close();
      proc.kill();
    }
  })();

  const requireStarted = () => {
    if (!child) throw new Error("query control methods require the generator to be iterating");
  };
  return Object.assign(generator, {
    interrupt: async () => {
      requireStarted();
      abortPermissionCallbacks("interrupted via SDK");
      await writeControl({ subtype: "interrupt" });
    },
    setPermissionMode: async (mode: PermissionMode) => {
      requireStarted();
      await writeControl({ subtype: "set_permission_mode", mode });
    },
    setModel: async (model: string) => {
      requireStarted();
      await writeControl({ subtype: "set_model", model });
    },
  });
}
