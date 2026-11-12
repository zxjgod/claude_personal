import { execFile, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { query } from "../sdk.js";

const execute = promisify(execFile);
const python = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;
const roles = ["parent", "child", "grandchild"];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quote = (value: string) =>
  process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux" && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")))
      return false;
    return true;
  } catch {
    return false;
  }
}

for (const [surface, background] of [
  ["TS return", false],
  ["TS return", true],
  ["TS abort", false],
  ["TS abort", true],
  ["TS paused abort", false],
  ["TS paused abort", true],
  ["TS input failure", false],
  ["TS input failure", true],
  ["TS resume after stop", true],
  ["Python disconnect", false],
  ["Python disconnect", true],
  ["Python cancelled", false],
  ["Python cancelled", true],
] as const)
  it.skipIf(surface.startsWith("Python") && !hasPython)(
    `${surface} stops the real CLI and its process tree (background=${background})`,
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sdk-tree-"));
      const command = [
        process.execPath,
        path.resolve("src/__tests__/fixtures/job-tree.mjs"),
        root,
        "parent",
      ]
        .map(quote)
        .join(" ");
      const cli = path.join(root, "entry.mjs");
      fs.writeFileSync(
        cli,
        `import fs from 'node:fs';fs.writeFileSync('cli.pid',String(process.pid));
${
  surface === "TS resume after stop"
    ? `
// Simulate a host without cooperative shutdown, forcing the native tree fallback.
const {PassThrough}=await import('node:stream');
const readline=await import('node:readline');
const raw=process.stdin, filtered=new PassThrough();
Object.defineProperty(process,'stdin',{value:filtered});
void(async()=>{for await(const line of readline.createInterface({input:raw})) {
  if(JSON.parse(line).request?.subtype!=='shutdown') filtered.write(line+'\\n');
}filtered.end();})();`
    : ""
}
await import(${JSON.stringify(pathToFileURL(path.resolve("src/cli.ts")).href)});`,
      );
      const pids = () =>
        ["cli", ...roles].flatMap((role) => {
          const file = path.join(root, `${role}.pid`);
          return fs.existsSync(file) ? [Number(fs.readFileSync(file, "utf8"))] : [];
        });
      let requests = 0;
      let pendingStarted!: () => void;
      const pending = new Promise<void>((resolve) => {
        pendingStarted = resolve;
      });
      const server = http.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        requests++;
        const payload = JSON.parse(body);
        // Keep the next provider request parked: the SDK is closing unfinished
        // work, so EOF must never drain additional queued user turns.
        const restoring = payload.messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === "user" && JSON.stringify(message.content).includes("RESTORED_JOB"),
        );
        const cancelling = payload.messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === "user" && JSON.stringify(message.content).includes("CANCEL_PENDING"),
        );
        if (cancelling && !restoring) {
          pendingStarted();
          return;
        }
        const restoredResult = payload.messages.find(
          (message: { tool_call_id?: string }) => message.tool_call_id === "restore-job",
        );
        const hasResult = payload.messages.some(
          (message: { role: string }) => message.role === "tool",
        );
        if (hasResult && surface !== "TS resume after stop") return;
        // Require observable diagnostics before the first saved result. A forced
        // stop preserves the last snapshot, not output produced after that save.
        const captured = payload.messages.some(
          (message: { tool_call_id?: string; content: unknown }) =>
            message.tool_call_id?.startsWith("snapshot-check-") &&
            JSON.stringify(message.content).includes("grandchild:diagnostic"),
        );
        if (hasResult && !restoring) {
          const readyBy = Date.now() + 5000;
          while (
            !roles.every((role) => fs.existsSync(path.join(root, `${role}.beat`))) &&
            Date.now() < readyBy
          )
            await delay(20);
        }
        const complete = restoring ? !!restoredResult : captured;
        const delta = complete
          ? { content: restoring ? JSON.stringify(restoredResult.content) : "background saved" }
          : restoring || hasResult
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: restoring ? "restore-job" : `snapshot-check-${requests}`,
                    type: "function",
                    function: {
                      name: "job_output",
                      arguments: JSON.stringify({ job_id: "job-1" }),
                    },
                  },
                ],
              }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: "start",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command,
                        description: "owned SDK process tree",
                        run_in_background: background,
                      }),
                    },
                  },
                ],
              };
        response.setHeader("Content-Type", "text/event-stream");
        response.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: complete ? "stop" : "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const env = {
        NODE_OPTIONS: `--import=${pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href}`,
        WORKSPACE_ROOT: root,
        CCR_USER_CONFIG_DIR: path.join(root, "user"),
        CCR_CONFIG_TRUST_STORE: path.join(root, "trust.json"),
        CCR_AUTO_MEMORY_EXTRACT: "0",
        LLM_API_KEY: "fixture-unused",
        LLM_PROVIDER: "custom",
        LLM_MODEL: "fixture",
        LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        PERMISSION_MODE: "bypassPermissions",
      };
      let stream: ReturnType<typeof query> | undefined;
      let reading: Promise<void> | undefined;
      let failure: unknown;
      let savedSession: string | undefined;
      const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const unrelatedClosed = new Promise<void>((resolve) =>
        unrelated.once("close", () => resolve()),
      );
      try {
        if (surface.startsWith("Python")) {
          const script = `import asyncio,os
from pathlib import Path
from ccr_sdk import CCRClient
async def main():
    client=CCRClient(cli=os.environ['CLI_PATH'],cwd=os.environ['WORKSPACE_ROOT'])
    try:
        async with client:
            await client.query('launch')
            for _ in range(500):
                if all(Path(r+'.beat').exists() for r in ('parent','child','grandchild')): break
                await asyncio.sleep(.02)
            else: raise RuntimeError('process tree did not start')
            if os.environ['CANCEL_CLIENT']=='1':
                asyncio.current_task().cancel()
                await asyncio.sleep(0)
            else: await client.disconnect()
    except asyncio.CancelledError:
        if os.environ['CANCEL_CLIENT']!='1': raise
asyncio.run(asyncio.wait_for(main(),20))
`;
          await execute(python, ["-c", script], {
            cwd: root,
            windowsHide: true,
            timeout: 25000,
            env: {
              ...process.env,
              ...env,
              PYTHONPATH: path.resolve("python"),
              CLI_PATH: cli,
              CANCEL_CLIENT: surface === "Python cancelled" ? "1" : "0",
            },
          });
        } else {
          const abort = new AbortController();
          let failInput!: () => void;
          const released = new Promise<void>((resolve) => {
            failInput = resolve;
          });
          const producerFailure = new Error("owned input producer failed");
          async function* prompts() {
            yield "launch";
            await released;
            throw producerFailure;
          }
          async function* resumablePrompts() {
            yield "launch";
            await released;
            yield "CANCEL_PENDING";
          }
          stream = query({
            prompt:
              surface === "TS input failure"
                ? prompts()
                : surface === "TS resume after stop"
                  ? resumablePrompts()
                  : "launch",
            options: { cwd: root, cliModule: cli, env, signal: abort.signal },
          });
          const consume = async () => {
            try {
              for await (const message of stream ?? []) {
                if (message.type === "result" && surface === "TS resume after stop") {
                  savedSession = String(message.session_id);
                  failInput();
                }
              }
            } catch (error) {
              failure = error;
            }
          };
          if (surface === "TS paused abort") await stream.next();
          else reading = consume();
          const deadline = Date.now() + 10000;
          while (!roles.every((role) => fs.existsSync(path.join(root, `${role}.beat`)))) {
            if (Date.now() > deadline) throw new Error(`tree did not start: ${String(failure)}`);
            await delay(20);
          }
          if (surface === "TS resume after stop") await pending;
          if (surface.includes("abort")) abort.abort();
          else if (surface === "TS input failure") failInput();
          else await stream.return(undefined);
          if (surface === "TS paused abort") {
            const closedBy = Date.now() + 8000;
            while (pids().some(alive) && Date.now() < closedBy) await delay(20);
            expect(
              pids().filter(alive),
              "abort must clean up without advancing the consumer",
            ).toEqual([]);
            reading = consume();
          }
          await reading;
          if (surface.includes("abort")) expect(failure).toMatchObject({ name: "AbortError" });
          else if (surface === "TS input failure") expect(failure).toBe(producerFailure);
          else expect(failure).toBeUndefined();
        }
        expect(requests).toBeGreaterThan(0);
        expect(pids()).toHaveLength(4);
        expect(pids().filter(alive), "SDK returned while owned processes are alive").toEqual([]);
        expect(unrelated.pid && alive(unrelated.pid), "unrelated host process was stopped").toBe(
          true,
        );
        const beats = roles.map((role) => fs.readFileSync(path.join(root, `${role}.beat`), "utf8"));
        await delay(150);
        expect(
          roles.map((role) => fs.readFileSync(path.join(root, `${role}.beat`), "utf8")),
        ).toEqual(beats);
        if (surface === "TS resume after stop") {
          expect(savedSession).toBeTruthy();
          const saved = JSON.parse(
            fs.readFileSync(
              path.join(root, ".claude", "session-runtime", `${savedSession}.json`),
              "utf8",
            ),
          );
          expect(saved.backgroundJobs[0].status).toBe("running");
          const restored = [];
          for await (const message of query({
            prompt: "RESTORED_JOB",
            options: { cwd: root, cliModule: cli, env, resume: savedSession },
          }))
            restored.push(message);
          const result = restored.find((message) => message.type === "result");
          expect(result?.is_error).toBe(false);
          expect(result?.session_id).toBe(savedSession);
          expect(result?.result).toContain("interrupted and was not restarted");
          expect(result?.result).toContain("grandchild:diagnostic");
          expect(result?.result).toContain("status: error");
          expect(result?.result).not.toContain("Unknown job");
          expect(
            roles.map((role) => fs.readFileSync(path.join(root, `${role}.beat`), "utf8")),
          ).toEqual(beats);
        }
      } finally {
        await stream?.return(undefined);
        await reading;
        unrelated.kill("SIGKILL");
        await unrelatedClosed;
        // Only fixture-owned PIDs are eligible for fallback cleanup after a red test.
        for (const pid of pids())
          if (pid > 0 && pid !== process.pid && alive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await delay(150);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
    35000,
  );
