import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { PersistenceManager } from "../persistence.js";

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

it.each([
  "headless",
  "repl",
  "headless-agent",
  "repl-resume",
])("normal %s CLI exit stops owned jobs and persists final background state", async (surface) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-job-cli-exit-"));
  const headless = surface.startsWith("headless");
  const delegated = surface === "headless-agent";
  if (surface === "repl-resume")
    await new PersistenceManager(root).save(
      "resume-target",
      [{ role: "user", content: [{ type: "text", text: "saved target" }] }],
      { taskState: "paused" },
    );
  const pids = () =>
    roles.flatMap((role) => {
      const file = path.join(root, `${role}.pid`);
      return fs.existsSync(file) ? [Number(fs.readFileSync(file, "utf8"))] : [];
    });
  const command = [
    process.execPath,
    path.resolve("src/__tests__/fixtures/job-tree.mjs"),
    root,
    "parent",
  ]
    .map(quote)
    .join(" ");
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const hasResult = payload.messages.some((message: { role: string }) => message.role === "tool");
    const worker = payload.messages.some(
      (message: { role: string; content: unknown }) =>
        message.role === "user" && JSON.stringify(message.content).includes("WORKER_BACKGROUND"),
    );
    if (hasResult) {
      const deadline = Date.now() + 5000;
      while (pids().length !== 3 && Date.now() < deadline) await delay(20);
    }
    const delta = hasResult
      ? { content: "background ready" }
      : {
          tool_calls: [
            {
              index: 0,
              id: "start-build",
              type: "function",
              function: {
                name: delegated && !worker ? "Agent" : "bash",
                arguments: JSON.stringify(
                  delegated && !worker
                    ? { prompt: "WORKER_BACKGROUND", subagent_type: "general" }
                    : {
                        command,
                        description: "owned background build",
                        run_in_background: true,
                      },
                ),
              },
            },
          ],
        };
    response.setHeader("Content-Type", "text/event-stream");
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: hasResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const argv = [
    path.resolve("src/cli.ts"),
    ...(headless ? ["-p", "launch background", "--output-format", "stream-json"] : ["--no-tui"]),
  ];
  const child = spawn(process.execPath, argv, {
    windowsHide: true,
    stdio: "pipe",
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href}`,
      WORKSPACE_ROOT: root,
      CCR_USER_CONFIG_DIR: path.join(root, "user"),
      CCR_CONFIG_TRUST_STORE: path.join(root, "trust.json"),
      LLM_API_KEY: "fixture-unused",
      LLM_PROVIDER: "custom",
      LLM_MODEL: "fixture",
      LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      PERMISSION_MODE: "bypassPermissions",
      CCR_AUTO_MEMORY_EXTRACT: "0",
    },
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  let stdout = "";
  let ended = false;
  const lines = readline.createInterface({ input: child.stdout });
  const read = (async () => {
    for await (const line of lines) {
      stdout += `${line}\n`;
      if (headless && line.startsWith("{")) {
        const message = JSON.parse(line);
        if (message.type === "result") {
          ended = true;
          child.stdin.end();
        }
      } else if (!headless && line.includes("background ready") && !ended) {
        ended = true;
        child.stdin.end(surface === "repl-resume" ? "/resume resume-target\nexit\n" : "exit\n");
      }
    }
  })();
  if (headless) child.stdin.end();
  else child.stdin.write("launch background\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      closed.then((code) => ({ code })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 12000);
      }),
    ]);
    expect(outcome, `CLI did not close: ${stderr.slice(-800)} ${stdout.slice(-400)}`).toBeDefined();
    expect(outcome?.code).toBe(0);
    await read;
    expect(ended).toBe(true);
    if (surface === "repl-resume") expect(stdout).toContain("Resumed session resume-t");
    expect(pids()).toHaveLength(3);
    expect(pids().filter(alive)).toEqual([]);
    const runtime = path.join(root, ".claude", "session-runtime");
    const files = fs.readdirSync(runtime).filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(surface === "repl-resume" ? 2 : 1);
    const ownerFile = files.find((file) => file !== "resume-target.json");
    if (!ownerFile) throw new Error("missing owner runtime snapshot");
    const saved = JSON.parse(fs.readFileSync(path.join(runtime, ownerFile), "utf8"));
    expect(saved.backgroundJobs).toMatchObject([
      { status: "killed", killReason: "session exited" },
    ]);
  } finally {
    clearTimeout(timer);
    for (const pid of pids())
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    child.kill("SIGKILL");
    await closed;
    lines.close();
    await read;
    await delay(150);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 30000);
