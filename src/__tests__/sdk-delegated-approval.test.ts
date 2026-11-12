import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { query } from "../sdk.js";

const require = createRequire(import.meta.url);
it.each([
  false,
  true,
])("executes SDK updatedInput through a real CLI, delegated=%s", async (delegated) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sdk-delegated-"));
  const original = path.join(root, "original.txt");
  const approved = path.join(root, "approved.txt");
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const worker = payload.messages.some(
      (message: any) =>
        message.role === "user" && JSON.stringify(message.content).includes("WORKER_CREATE_FILE"),
    );
    const hasResult = payload.messages.some((message: any) => message.role === "tool");
    let delta: Record<string, unknown>;
    let finish: string;
    if (!hasResult) {
      const agent = delegated && !worker;
      delta = {
        tool_calls: [
          {
            index: 0,
            id: agent ? "delegate" : "write",
            type: "function",
            function: {
              name: agent ? "Agent" : "write",
              arguments: JSON.stringify(
                agent
                  ? { prompt: "WORKER_CREATE_FILE", subagent_type: "general" }
                  : { file_path: original, content: "unapproved" },
              ),
            },
          },
        ],
      };
      finish = "tool_calls";
    } else {
      delta = { content: "finished" };
      finish = "stop";
    }
    response.setHeader("Content-Type", "text/event-stream");
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const callbacks: string[] = [];
    const output = [];
    for await (const message of query({
      prompt: "PARENT_CREATE_FILE",
      options: {
        cwd: root,
        cliModule: path.resolve("src/cli.ts"),
        signal: AbortSignal.timeout(30000),
        env: {
          NODE_OPTIONS: `--import=${pathToFileURL(require.resolve("tsx")).href}`,
          WORKSPACE_ROOT: root,
          LLM_API_KEY: "fixture-unused",
          LLM_PROVIDER: "custom",
          LLM_MODEL: "fixture",
          LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          CCR_USER_CONFIG_DIR: path.join(root, "user"),
          CCR_CONFIG_TRUST_STORE: path.join(root, "trust.json"),
          CLAUDE_CODE_DISABLE_SUBAGENT_OUTPUT_SCAN: "1",
          PERMISSION_MODE: "default",
        },
        canUseTool: async (name) => {
          callbacks.push(name);
          return {
            behavior: "allow",
            updatedInput: { file_path: approved, content: "approved rewrite" },
          };
        },
      },
    }))
      output.push(message);
    expect(callbacks).toEqual(["write"]);
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(approved, "utf8")).toBe("approved rewrite");
    expect(output.some((message) => message.type === "result" && !message.is_error)).toBe(true);
    expect(output.some((message) => message.type.startsWith("control_"))).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 45000);
