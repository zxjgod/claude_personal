import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { Message } from "../types.js";

const execute = promisify(execFile);

it.each([
  "completed",
  "in progress",
  "being saved",
])("recovers a tool batch that was %s when the CLI was killed", async (boundary) => {
  const partialBatch = boundary === "in progress";
  const interruptedSave = boundary === "being saved";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-headless-crash-"));
  const amountPath = path.join(root, "amount.mjs");
  const original = "value => value";
  const draft = "value => Math.round(value * 100)";
  const revised = "value => Math.trunc(value * 100)";
  const userNote = "// User's existing receipt note\n";
  fs.writeFileSync(amountPath, `${userNote}export const cents = ${original};\n`);
  let reachedBatch!: () => void;
  const completedBatch = new Promise<void>((resolve) => {
    reachedBatch = resolve;
  });
  let resumedHistory: Message[] | undefined;
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const messages: Message[] = JSON.parse(raw).messages;
    let userIndex = messages.length - 1;
    while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex--;
    const resuming = JSON.stringify(messages[userIndex]?.content).includes("CHANGE_REQUIREMENT");
    const results = messages.slice(userIndex + 1).filter((message) => message.role === "tool");
    if (!resuming && results.some((message) => message.tool_call_id === "draft-edit")) {
      if (!interruptedSave) reachedBatch();
      return; // Leave the next model turn in flight until the host is killed.
    }
    if (resuming && !resumedHistory) resumedHistory = messages;
    const action =
      results.length === 0
        ? {
            id: resuming ? "resumed-read" : "draft-read",
            name: "read",
            input: { file_path: amountPath },
          }
        : results.length === 1
          ? {
              id: resuming ? "revised-edit" : "draft-edit",
              name: "edit",
              input: {
                file_path: amountPath,
                old_string: resuming ? draft : original,
                new_string: resuming ? revised : draft,
              },
            }
          : undefined;
    const delta = action
      ? {
          tool_calls: [
            {
              index: 0,
              id: action.id,
              type: "function",
              function: { name: action.name, arguments: JSON.stringify(action.input) },
            },
            ...(partialBatch && action.id === "draft-edit"
              ? [
                  {
                    index: 1,
                    id: "pending-command",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: 'node -e "process.exit(0)"',
                        description: "Verify draft",
                      }),
                    },
                  },
                ]
              : []),
          ],
        }
      : { content: "Updated the cents rule" };
    response.setHeader("Content-Type", "text/event-stream");
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: action ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    ...process.env,
    WORKSPACE_ROOT: root,
    CCR_USER_CONFIG_DIR: path.join(root, "user"),
    CCR_CONFIG_TRUST_STORE: path.join(root, "trust.json"),
    CCR_AUTO_MEMORY_EXTRACT: "0",
    LLM_API_KEY: "fixture-unused",
    LLM_PROVIDER: "custom",
    LLM_MODEL: "fixture",
    LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
  };
  const argv = [
    "--import",
    pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
    path.resolve("src/cli.ts"),
    "--output-format",
    "stream-json",
    "--permission-mode",
    "acceptEdits",
  ];
  const crashArgs = [...argv];
  if (interruptedSave) {
    const entry = path.join(root, "pause-before-rename.mjs");
    fs.writeFileSync(
      entry,
      `import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
const rename = fs.rename;
fs.rename = async (source, target) => {
  if (target.endsWith('.json') && /[\\\\/]sessions[\\\\/]/.test(target)) {
    const snapshot = JSON.parse(await fs.readFile(source, 'utf8'));
    if (snapshot.messages?.some(message => message.tool_call_id === 'draft-edit' && message.content.includes('amount.mjs'))) {
      process.stderr.write('SNAPSHOT_READY_TO_RENAME ' + source + '\\n');
      await new Promise(() => {});
    }
  }
  return rename(source, target);
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(path.resolve("src/cli.ts")).href)});
`,
    );
    crashArgs[2] = entry;
  }
  const child = spawn(
    process.execPath,
    [
      ...crashArgs,
      "-p",
      "DRAFT_CRASH: round cents",
      ...(partialBatch
        ? ["--input-format", "stream-json", "--permission-prompt-tool", "stdio"]
        : []),
    ],
    {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (interruptedSave && stderr.includes("SNAPSHOT_READY_TO_RENAME")) reachedBatch();
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    if (partialBatch && frame.type === "control_request" && frame.request?.tool_name === "bash")
      reachedBatch();
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completedBatch,
      closed.then(() => {
        throw new Error(`CLI stopped before the batch: ${stderr}`);
      }),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Batch not reached: ${stderr}`)), 20000);
      }),
    ]);
    expect(fs.readFileSync(amountPath, "utf8")).toBe(`${userNote}export const cents = ${draft};\n`);
    expect(child.kill("SIGKILL")).toBe(true);
    expect((await closed).signal).toBe("SIGKILL");
    const frames = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const sessionId = frames.find(
      (frame) => frame.type === "system" && frame.subtype === "init",
    )?.session_id;
    expect(sessionId).toMatch(/^[\w-]+$/);
    expect(frames.some((frame) => frame.type === "result")).toBe(false);
    const saved = JSON.parse(
      fs.readFileSync(path.join(root, ".claude", "sessions", `${sessionId}.json`), "utf8"),
    );
    expect(saved.taskState, stderr).toBe(
      boundary === "completed" ? "waiting_for_model" : "waiting_for_tool",
    );
    const expectedResults = [
      expect.objectContaining({
        role: "tool",
        tool_call_id: "draft-edit",
        content: expect.stringContaining(interruptedSave ? "outcome is unknown" : "amount.mjs"),
      }),
    ];
    if (partialBatch)
      expectedResults.push(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "pending-command",
          content: expect.stringContaining("outcome is unknown"),
        }),
      );
    expect(saved.messages.slice(-expectedResults.length)).toEqual(expectedResults);
    if (interruptedSave) {
      const pending = stderr.match(/^SNAPSHOT_READY_TO_RENAME (.+)$/m)?.[1];
      if (!pending) throw new Error("Missing temporary snapshot path");
      expect(path.dirname(pending)).toBe(path.join(root, ".claude", "sessions"));
      const pendingSnapshot = JSON.parse(fs.readFileSync(pending, "utf8"));
      expect(pendingSnapshot.messages.at(-1)).toMatchObject({
        tool_call_id: "draft-edit",
        content: expect.stringContaining("amount.mjs"),
      });
    }

    const output = await execute(
      process.execPath,
      [...argv, "-p", "CHANGE_REQUIREMENT: truncate cents now", "--resume", sessionId],
      { cwd: root, env, windowsHide: true, timeout: 20000 },
    );
    const result = output.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((frame) => frame.type === "result");
    expect(result).toMatchObject({ session_id: sessionId, is_error: false });
    expect(resumedHistory).toEqual(expect.arrayContaining(expectedResults));
    expect(fs.readFileSync(amountPath, "utf8")).toBe(
      `${userNote}export const cents = ${revised};\n`,
    );
    await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import assert from 'node:assert/strict'; import { cents } from './amount.mjs'; assert.equal(cents(1.239), 123); assert.equal(cents(-1.239), -123);",
      ],
      { cwd: root, windowsHide: true, timeout: 5000 },
    );
  } finally {
    clearTimeout(timer);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 50000);
