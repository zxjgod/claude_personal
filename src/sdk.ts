import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
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
}
export interface SDKMessage {
  type: string;
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  [field: string]: unknown;
}
/** Programmatic local CLI interface. API keys and provider endpoints are supplied via env. */
export async function* query(input: {
  prompt: string | AsyncIterable<string>;
  options?: QueryOptions;
}): AsyncGenerator<SDKMessage> {
  const options = input.options ?? {};
  // The default CLI entry sits next to THIS module — which only exists after a
  // build (dist/sdk.js ↔ dist/cli.js). From source (src/sdk.ts) there is no
  // cli.js, and without an early error the failure surfaces later as a
  // downstream "CLI exited 1: Cannot find module …" from a doomed child.
  const defaultModule = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (!options.cliExecutable && !options.cliModule && !fs.existsSync(defaultModule)) {
    throw new Error(
      `SDK query() found no CLI entry at ${defaultModule}. ` +
        "Build the project first, or pass options.cliModule / options.cliExecutable.",
    );
  }
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
  const child = spawn(options.cliExecutable ?? process.execPath, argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, ...(options.model ? { LLM_MODEL: options.model } : {}) },
    windowsHide: true,
    stdio: "pipe",
    signal: options.signal,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  child.stdin.on("error", () => {});
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  void finished.catch(() => {});
  const feeder = (async () => {
    try {
      const prompts = typeof input.prompt === "string" ? [input.prompt] : input.prompt;
      for await (const prompt of prompts) {
        if (options.signal?.aborted) break;
        const writable = child.stdin.write(
          `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`,
        );
        if (!writable)
          await new Promise<void>((resolve) => {
            child.stdin.once("drain", resolve);
            child.stdin.once("close", resolve);
          });
      }
    } finally {
      child.stdin.end();
    }
  })();
  void feeder.catch(() => child.kill());
  let resultSeen = false;
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
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
        yield {
          type: "system",
          subtype: "non_json_stdout",
          is_error: true,
          message: line.slice(0, 2000),
        };
        continue;
      }
      if (message.type === "result") resultSeen = true;
      yield message;
    }
    const code = await finished;
    await feeder;
    // Review fix ("异常终止被当作正常结束"): signal kills surface as
    // code === null and were silently treated as success; and once ANY result
    // frame had been seen, later non-zero exits were ignored too. Both paths
    // now report: no result yet → throw; result seen but the CLI still died
    // non-zero (or was signalled, unless WE aborted it) → emit an error frame
    // so consumers can distinguish complete from truncated runs.
    const abortedByUs = code === null && options.signal?.aborted === true;
    if (code !== 0 && !abortedByUs) {
      if (!resultSeen) throw new Error(`CLI exited ${code ?? "on a signal"}: ${stderr}`);
      yield {
        type: "system",
        subtype: "abnormal_exit",
        is_error: true,
        message: `CLI exited ${code ?? "on a signal"} after the result frame: ${stderr.slice(-500)}`,
      };
    }
  } finally {
    // Release the stdout pipe even when the consumer abandons the generator
    // early (otherwise the readline handle and the child both stay alive).
    lines.close();
    child.kill();
  }
}
