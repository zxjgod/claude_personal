import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const python = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;

// The Python SDK has no vitest-native harness; run its self-contained unittest
// modules (Node fixture CLI, no provider needed) and skip where Python is absent.
it.skipIf(!hasPython)(
  "python SDK passes its protocol unittest suite",
  async () => {
    const { stderr } = await execute(
      python,
      ["-m", "unittest", "discover", "-s", "python", "-p", "test_ccr*.py"],
      {
        timeout: 60000,
        windowsHide: true,
      },
    );
    expect(stderr).toMatch(/Ran 22 tests/);
    expect(stderr).toContain("OK");
  },
  60000,
);

it.skipIf(!hasPython)(
  "Python persistent client interrupts, rewrites a later Write, and resumes the real CLI session",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-python-client-"));
    const original = path.join(root, "unapproved.txt");
    const approved = path.join(root, "approved.txt");
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
      const hasResult = payload.messages
        .slice(lastUser + 1)
        .some((message: { role: string }) => message.role === "tool");
      const writing = !user.includes("RESUMED_CHECK") && !hasResult;
      const delta = writing
        ? {
            tool_calls: [
              {
                index: 0,
                id: `write-${requests.length}`,
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ file_path: original, content: "unapproved" }),
                },
              },
            ],
          }
        : {
            content: user.includes("RESUMED_CHECK")
              ? "continuity confirmed"
              : "approved write complete",
          };
      response.setHeader("Content-Type", "text/event-stream");
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: writing ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const script = `import asyncio,json,os
from ccr_sdk import CCRClient
async def main():
    started,cancelled=asyncio.Event(),asyncio.Event()
    calls=[]
    async def approve(name,payload,context):
        calls.append(name)
        if len(calls)==1:
            started.set()
            try: await asyncio.Event().wait()
            finally: cancelled.set()
        return {"behavior":"allow","updatedInput":{"file_path":os.environ["APPROVED_PATH"],"content":"approved by Python"}}
    async with CCRClient(cli=os.environ["CLI_PATH"],can_use_tool=approve) as client:
        await client.query("INTERRUPT_WRITE")
        await asyncio.wait_for(started.wait(),15)
        await client.interrupt()
        first=[m async for m in client.receive_response()][-1]
        assert first["is_error"],first
        await asyncio.wait_for(cancelled.wait(),2)
        await client.set_model("fixture-next")
        await client.set_permission_mode("default")
        await client.query("WRITE_NEXT")
        second=[m async for m in client.receive_response()][-1]
        assert not second["is_error"],second
        assert first["session_id"]==second["session_id"]
    async with CCRClient(cli=os.environ["CLI_PATH"],resume=second["session_id"]) as resumed:
        await resumed.query("RESUMED_CHECK")
        third=[m async for m in resumed.receive_response()][-1]
        assert not third["is_error"],third
        assert third["session_id"]==second["session_id"]
    print(json.dumps({"callbacks":calls,"resumed":third["result"]}))
asyncio.run(asyncio.wait_for(main(),35))
`;
    try {
      const { stdout } = await execute(python, ["-c", script], {
        cwd: root,
        timeout: 40000,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONPATH: path.resolve("python"),
          CLI_PATH: path.resolve("src/cli.ts"),
          APPROVED_PATH: approved,
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
      });
      expect(JSON.parse(stdout)).toEqual({
        callbacks: ["write", "write"],
        resumed: "continuity confirmed",
      });
      expect(fs.existsSync(original)).toBe(false);
      expect(fs.readFileSync(approved, "utf8")).toBe("approved by Python");
      expect(requests.some((request) => request.model === "fixture-next")).toBe(true);
      const restored = requests.at(-1);
      expect(JSON.stringify(restored?.messages)).toContain("WRITE_NEXT");
      expect(JSON.stringify(restored?.messages)).toContain("approved write complete");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  45000,
);
