import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { query, type SDKMessage } from "../sdk.js";

it("continues after interruption and resumes the same session in a new SDK-owned CLI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sdk-continuity-"));
  const original = path.join(root, "unapproved.txt");
  const approved = path.join(root, "approved.txt");
  let queuedStarted!: () => void;
  const queuedPending = new Promise<void>((resolve) => {
    queuedStarted = resolve;
  });
  let releaseQueued!: () => void;
  const queuedRelease = new Promise<void>((resolve) => {
    releaseQueued = resolve;
  });
  let timeoutStarted!: () => void;
  const timeoutRequest = new Promise<void>((resolve) => {
    timeoutStarted = resolve;
  });
  const requests: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> =
    [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    let lastUser = payload.messages.length - 1;
    while (lastUser >= 0 && payload.messages[lastUser].role !== "user") lastUser--;
    const user = JSON.stringify(payload.messages[lastUser].content);
    const resumed = user.includes("RESUMED_CHECK");
    if (user.includes("TIMEOUT_CHECK")) {
      timeoutStarted();
      return;
    }
    if (user.includes("CLOSE_SECOND")) {
      queuedStarted();
      await queuedRelease;
    }
    const hasResult = payload.messages
      .slice(lastUser + 1)
      .some((message: { role: string }) => message.role === "tool");
    const complete = hasResult || user.includes("CLOSE_FIRST");
    const delta = !complete
      ? {
          tool_calls: [
            {
              index: 0,
              id: `tool-${requests.length}`,
              type: "function",
              function: {
                name: resumed ? "read" : "write",
                arguments: JSON.stringify(
                  resumed
                    ? { file_path: approved }
                    : { file_path: original, content: "unapproved" },
                ),
              },
            },
          ],
        }
      : { content: resumed ? "restored file verified" : "approved write complete" };
    response.setHeader("Content-Type", "text/event-stream");
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: !complete ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const options = {
    cwd: root,
    cliModule: path.resolve("src/cli.ts"),
    signal: AbortSignal.timeout(45000),
    env: {
      NODE_OPTIONS: `--import=${pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href}`,
      WORKSPACE_ROOT: root,
      LLM_API_KEY: "fixture-unused",
      LLM_PROVIDER: "custom",
      LLM_MODEL: "fixture-initial",
      LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      CCR_USER_CONFIG_DIR: path.join(root, "user"),
      CCR_CONFIG_TRUST_STORE: path.join(root, "trust.json"),
      PERMISSION_MODE: "default",
    },
  };
  let releaseSecond!: () => void;
  const secondReady = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let approvalStarted!: () => void;
  const pendingApproval = new Promise<void>((resolve) => {
    approvalStarted = resolve;
  });
  let producerClosed = false;
  let firstCancelled = false;
  async function* prompts() {
    try {
      yield "INTERRUPT_WRITE";
      await secondReady;
      yield "WRITE_NEXT";
    } finally {
      producerClosed = true;
    }
  }
  let callbacks = 0;
  const stream = query({
    prompt: prompts(),
    options: {
      ...options,
      canUseTool: async (_name, _input, context) => {
        if (++callbacks === 1) {
          approvalStarted();
          return new Promise((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                firstCancelled = true;
                resolve({ behavior: "deny" });
              },
              { once: true },
            );
          });
        }
        return {
          behavior: "allow",
          updatedInput: { file_path: approved, content: "approved by TypeScript" },
        };
      },
    },
  });
  // Control must progress independently of both message consumption and input.
  const interrupt = pendingApproval.then(() => stream.interrupt());
  void interrupt.catch(() => {});
  try {
    const results: SDKMessage[] = [];
    for await (const message of stream) {
      if (message.type !== "result") continue;
      results.push(message);
      if (results.length === 1) {
        expect(message.is_error).toBe(true);
        expect(firstCancelled).toBe(true);
        await interrupt;
        await stream.setModel("fixture-next");
        await stream.setPermissionMode("default");
        releaseSecond();
      }
    }
    expect(results).toHaveLength(2);
    expect(results[1].is_error).toBe(false);
    expect(results[1].session_id).toBe(results[0].session_id);
    expect(producerClosed).toBe(true);
    expect(callbacks).toBe(2);
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(approved, "utf8")).toBe("approved by TypeScript");
    const restored: SDKMessage[] = [];
    for await (const message of query({
      prompt: "RESUMED_CHECK",
      options: { ...options, resume: results[1].session_id },
    }))
      restored.push(message);
    const result = restored.find((message) => message.type === "result");
    expect(result?.is_error).toBe(false);
    expect(result?.session_id).toBe(results[0].session_id);
    const ids = [...results, result].map((frame) => frame?.input_id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(result?.result).toBe("restored file verified");
    expect(requests.some((request) => request.model === "fixture-next")).toBe(true);
    const history = JSON.stringify(requests.at(-1)?.messages);
    expect(history).toContain("WRITE_NEXT");
    expect(history).toContain("approved write complete");
    expect(history).toContain("approved by TypeScript");
    const readResult = requests.at(-1)?.messages.at(-1);
    expect(readResult?.role).toBe("tool");
    expect(JSON.stringify(readResult?.content)).toContain("approved by TypeScript");

    // Both prompts are already submitted. The queued model response would
    // write original with bypass permissions if close merely drained EOF.
    async function* queuedPrompts() {
      yield "CLOSE_FIRST";
      yield "CLOSE_SECOND";
    }
    const queued = query({
      prompt: queuedPrompts(),
      options: {
        ...options,
        env: { ...options.env, PERMISSION_MODE: "bypassPermissions" },
      },
    });
    try {
      for await (const message of queued) {
        if (message.type !== "result") continue;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("queued turn did not start")), 10000);
          void queuedPending.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        releaseQueued();
        break; // SDK return must stop the pending turn, not drain it via EOF.
      }
      expect(fs.existsSync(original)).toBe(false);
    } finally {
      releaseQueued();
      await queued.return(undefined);
    }

    const deadline = new AbortController();
    let timedOutAtProvider = false;
    void timeoutRequest.then(() => {
      timedOutAtProvider = true;
      const timer = AbortSignal.timeout(25);
      timer.addEventListener("abort", () => deadline.abort(timer.reason), { once: true });
    });
    const timedResults: SDKMessage[] = [];
    await expect(async () => {
      for await (const message of query({
        prompt: "TIMEOUT_CHECK",
        options: {
          ...options,
          resume: results[1].session_id,
          signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(12000)]),
        },
      })) {
        if (message.type === "result") timedResults.push(message);
      }
    }).rejects.toMatchObject({ name: "AbortError", cause: { name: "TimeoutError" } });
    expect(timedOutAtProvider).toBe(true);
    expect(
      timedResults.every(
        (frame) => frame.is_error && frame.input_id && !ids.includes(frame.input_id),
      ),
    ).toBe(true);

    const retried: SDKMessage[] = [];
    for await (const message of query({
      prompt: "RESUMED_CHECK after timeout",
      options: { ...options, resume: results[1].session_id },
    })) {
      if (message.type === "result") retried.push(message);
    }
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      is_error: false,
      session_id: results[1].session_id,
      input_id: expect.any(String),
    });
    expect(ids).not.toContain(retried[0].input_id);
    expect(timedResults.map((frame) => frame.input_id)).not.toContain(retried[0].input_id);
  } finally {
    releaseQueued();
    releaseSecond();
    await stream.return(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
