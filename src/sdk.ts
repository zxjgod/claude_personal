import { spawn } from "node:child_process";
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
  const argv = [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];
  if (!options.cliExecutable)
    argv.unshift(options.cliModule ?? fileURLToPath(new URL("./cli.js", import.meta.url)));
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
  try {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines)
      if (line.trim()) {
        const message = JSON.parse(line) as SDKMessage;
        if (message.type === "result") resultSeen = true;
        yield message;
      }
    const code = await finished;
    await feeder;
    if (code && !resultSeen) throw new Error(`CLI exited ${code}: ${stderr}`);
  } finally {
    child.kill();
  }
}
