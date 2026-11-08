import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { expect, it } from "vitest";

// Real-CLI round-trip: the fixture provider makes the model call the Write
// tool, default permission mode parks the call, and the test approves it over
// the stream-json control protocol — the exact path the TS/Python SDKs drive.
it("approves a real Write tool call through the can_use_tool control protocol", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-control-e2e-"));
  const target = path.join(root, "out.txt");
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    response.setHeader("Content-Type", "text/event-stream");
    const hasToolResult = payload.messages.some(
      (message: { role: string }) => message.role === "tool",
    );
    if (!hasToolResult) {
      response.end(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name: "write", arguments: JSON.stringify({ file_path: target, content: "approved" }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    response.end(
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve("src/cli.ts"),
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
    ],
    {
      // Stay in the repo so `--import tsx` resolves; the workspace comes from
      // WORKSPACE_ROOT (same pattern as cli-headless-e2e).
      env: {
        ...process.env,
        WORKSPACE_ROOT: root,
        LLM_API_KEY: "fixture-unused",
        LLM_PROVIDER: "custom",
        LLM_MODEL: "fixture",
        LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        CCR_USER_CONFIG_DIR: path.join(root, "user"),
        CCR_CONFIG_TRUST_STORE: path.join(root, "fixture-trust.json"),
      },
      windowsHide: true,
      stdio: "pipe",
    },
  );
  const frames: Array<Record<string, any>> = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let approved = false;
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  try {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stdin.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: "write the file" } })}\n`,
    );
    for await (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      frames.push(frame);
      if (frame.type === "control_request" && frame.request?.subtype === "can_use_tool") {
        expect(frame.request.tool_name).toBe("write");
        // The ask fires after schema normalization (file_path → filePath).
        expect(frame.request.input.filePath).toBe(target);
        approved = true;
        child.stdin.write(
          `${JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: frame.request_id,
              response: { behavior: "allow" },
            },
          })}\n`,
        );
      }
      if (frame.type === "result") {
        child.stdin.end();
        break;
      }
    }
    lines.close();
    expect(await exited, stderr.slice(-2000)).toBe(0);
    expect(approved).toBe(true);
    const result = frames.find((frame) => frame.type === "result");
    expect(result?.is_error).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("approved");
  } finally {
    child.kill();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90000);
