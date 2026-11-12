import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveSessionRuntime } from "../session-runtime.js";
import { BashTool } from "../tools/core/bash.js";
import { PowerShellTool } from "../tools/core/powershell.js";
import { JobKillTool, JobOutputTool } from "../tools/extended/jobs.js";
import {
  clearJobs,
  createJob,
  getJob,
  type Job,
  killRunningJobs,
  settleJob,
} from "../tools/job-store.js";
import { drainNotifications, resetNotifications } from "../tools/notifications.js";
import type { ToolContext } from "../types.js";

let root: string;
let context: ToolContext;
const roles = ["parent", "child", "grandchild"];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function quote(value: string) {
  return process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}
function pids() {
  return roles.flatMap((role) => {
    const file = path.join(root, `${role}.pid`);
    return fs.existsSync(file) ? [Number(fs.readFileSync(file, "utf8"))] : [];
  });
}
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
async function waitFor(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("process fixture did not reach its expected state");
    await delay(20);
  }
}
async function startTree(timeout = 30000): Promise<Job> {
  const command = [
    process.execPath,
    path.resolve("src/__tests__/fixtures/job-tree.mjs"),
    root,
    "parent",
  ]
    .map(quote)
    .join(" ");
  const result = await BashTool.call(
    { command, description: "owned test process tree", run_in_background: true, timeout },
    context,
  );
  if (result.error || typeof result.metadata?.jobId !== "string")
    throw new Error(result.error || "missing background handle");
  const job = getJob(context.sessionId, result.metadata.jobId);
  if (!job) throw new Error("missing registered job");
  await waitFor(
    () =>
      pids().length === 3 && roles.every((role) => fs.existsSync(path.join(root, `${role}.beat`))),
  );
  return job;
}
async function assertTreeStopped() {
  expect(pids()).toHaveLength(3);
  const sizes = roles.map((role) => fs.statSync(path.join(root, `${role}.beat`)).size);
  // Linux can close all inherited pipes before the last signalled process
  // disappears from /proc. Bound that observation lag, while still rejecting
  // any work performed after the job reported settlement.
  await expect.poll(() => pids().filter(alive), { timeout: 1000 }).toEqual([]);
  await delay(160);
  expect(roles.map((role) => fs.statSync(path.join(root, `${role}.beat`)).size)).toEqual(sizes);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-job-tree-"));
  context = {
    workspaceRoot: root,
    sessionId: `job-tree-${path.basename(root)}`,
    permissionMode: "bypassPermissions",
  };
  vi.stubEnv("CCR_USER_CONFIG_DIR", path.join(root, "user"));
});
afterEach(async () => {
  // Failing regressions can intentionally observe a premature settled status.
  // Clean only the fixture PIDs, then wait for real exit before deleting files.
  for (const pid of pids()) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
      throw new Error("invalid owned fixture PID");
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  await killRunningJobs(context.sessionId, "test cleanup");
  await waitFor(() => pids().every((pid) => !alive(pid)));
  await delay(100); // Let the owning cmd shell/pipe close after fallback PID cleanup.
  clearJobs(context.sessionId);
  resetNotifications(context.sessionId);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("default job_kill reports killed only after all three process roles stop", async () => {
  const job = await startTree();
  const result = await JobKillTool.call({ job_id: job.id }, context);
  expect(result.error).toBeUndefined();
  await assertTreeStopped();
  expect(job.status).toBe("killed");
  expect(job.killReason).toBeTruthy();
  const notes = drainNotifications(context.sessionId);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("<status>killed</status>");
  saveSessionRuntime(root, context.sessionId);
  const restored = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("src/__tests__/fixtures/runtime-process.ts"),
        "restore",
        root,
        context.sessionId,
      ],
      {
        windowsHide: true,
        timeout: 15000,
        encoding: "utf8",
        env: { ...process.env, CCR_USER_CONFIG_DIR: path.join(root, "user") },
      },
    ),
  );
  expect(restored.jobs).toMatchObject([{ status: "killed", hasKill: false }]);
  expect(restored.jobs[0].stderr).toContain("grandchild:diagnostic");
  expect(restored.jobs[0].stderr).not.toContain("interrupted");
  await assertTreeStopped();
});

it("explicit cancellation preserves the reason and diagnostic output", async () => {
  const job = await startTree();
  await JobKillTool.call({ job_id: job.id, reason: "stop this build" }, context);
  await assertTreeStopped();
  const output = await JobOutputTool.call({ job_id: job.id }, context);
  expect(output.content).toContain("stop this build");
  expect(output.content).toContain("grandchild:diagnostic");
  expect(job.status).toBe("killed");
});

it("TTL settlement waits for real tree termination", async () => {
  const job = await startTree(8000);
  await job.settled;
  await assertTreeStopped();
  expect(job.status).toBe("killed");
  expect(job.killReason).toContain("timed out");
}, 20000);

it("session cleanup waits for tree termination before publishing a terminal notification", async () => {
  const job = await startTree();
  await killRunningJobs(context.sessionId, "session exited");
  await assertTreeStopped();
  expect(job.status).toBe("killed");
  expect(drainNotifications(context.sessionId)).toHaveLength(1);
});

it("background work survives an ordinary turn abort and remains explicitly killable", async () => {
  const controller = new AbortController();
  context.abortSignal = controller.signal;
  const job = await startTree();
  controller.abort();
  await delay(100);
  expect(pids().every(alive)).toBe(true);
  expect(job.status).toBe("running");
  await JobKillTool.call({ job_id: job.id, reason: "finished observing" }, context);
  await assertTreeStopped();
});

it("a different session cannot stop this session's process tree", async () => {
  const job = await startTree();
  const result = await JobKillTool.call(
    { job_id: job.id },
    { ...context, sessionId: "other-session" },
  );
  expect(result.error).toContain("Unknown job");
  expect(pids().every(alive)).toBe(true);
  await JobKillTool.call({ job_id: job.id, reason: "owner cleanup" }, context);
});

it("a failed background command exposes its exit code and error status", async () => {
  const file = path.join(root, "failure.mjs");
  fs.writeFileSync(file, "console.error('build failed');process.exit(7)");
  const result = await BashTool.call(
    {
      command: `${quote(process.execPath)} ${quote(file)}`,
      description: "failed build",
      run_in_background: true,
    },
    context,
  );
  const job = getJob(context.sessionId, String(result.metadata?.jobId));
  if (!job) throw new Error("missing job");
  await job.settled;
  const output = await JobOutputTool.call({ job_id: job.id }, context);
  expect(job.status).toBe("error");
  expect(job.exitCode).toBe(7);
  expect(output.content).toContain("exit code: 7");
  expect(output.content).toContain("build failed");
  expect(drainNotifications(context.sessionId)[0]).toContain("<status>error</status>");
});

it("flushes final decoder bytes before settling and notifying", async () => {
  const file = path.join(root, "decoder.mjs");
  fs.writeFileSync(
    file,
    "process.stdout.write(Buffer.from([0xe4,0xb8]));process.stderr.write(Buffer.from([0xe4,0xb8]));",
  );
  const result = await BashTool.call(
    {
      command: `${quote(process.execPath)} ${quote(file)}`,
      description: "decoder tail",
      run_in_background: true,
    },
    context,
  );
  const job = getJob(context.sessionId, String(result.metadata?.jobId));
  if (!job) throw new Error("missing job");
  await job.settled;
  expect(job.stdout).toBe("\ufffd");
  expect(job.stderr).toBe("\ufffd");
  expect(drainNotifications(context.sessionId)[0]).toContain("\ufffd");
});

it.each([
  false,
  true,
])("an already-aborted request does not launch a command, background=%s", async (background) => {
  const marker = path.join(root, "must-not-exist");
  const file = path.join(root, "side-effect.mjs");
  fs.writeFileSync(
    file,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'unexpected');`,
  );
  const controller = new AbortController();
  controller.abort();
  const result = await BashTool.call(
    {
      command: `${quote(process.execPath)} ${quote(file)}`,
      description: "cancelled before start",
      run_in_background: background,
    },
    { ...context, abortSignal: controller.signal },
  );
  expect(result.metadata?.aborted).toBe(true);
  expect(result.metadata?.jobId).toBeUndefined();
  expect(fs.existsSync(marker)).toBe(false);
});

it("cancelling a job_output wait returns promptly without killing background work", async () => {
  const job = await startTree();
  const controller = new AbortController();
  const read = JobOutputTool.call(
    { job_id: job.id, wait: true, timeout_ms: 60000 },
    { ...context, abortSignal: controller.signal },
  );
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1500);
      }),
    ]);
    expect(result?.metadata?.aborted).toBe(true);
    expect(job.status).toBe("running");
    expect(pids().every(alive)).toBe(true);
  } finally {
    clearTimeout(timer);
    await JobKillTool.call({ job_id: job.id, reason: "owner cleanup" }, context);
    await read;
  }
});

it("an already-aborted PowerShell request also refuses execution before spawn", async () => {
  const marker = path.join(root, "powershell-must-not-exist");
  const controller = new AbortController();
  controller.abort();
  const result = await PowerShellTool.call(
    {
      command: `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value unexpected`,
      description: "cancelled PowerShell",
    },
    { ...context, abortSignal: controller.signal },
  );
  expect(result.metadata?.aborted).toBe(true);
  expect(fs.existsSync(marker)).toBe(false);
});

it("cleanup reports a job that did not stop instead of inventing a terminal status", async () => {
  const job = createJob(context.sessionId, { kind: "agent", command: "uncooperative fixture" });
  job.kill = () => {};
  try {
    expect(await killRunningJobs(context.sessionId, "session exited", 30)).toEqual([job.id]);
    expect(job.status).toBe("running");
    expect(drainNotifications(context.sessionId)).toEqual([]);
  } finally {
    settleJob(job, "error", null);
  }
});

it("the combined stdout/stderr limit stops and marks an overflowing command", async () => {
  const file = path.join(root, "overflow.mjs");
  fs.writeFileSync(
    file,
    "process.stdout.write(Buffer.alloc(6*1024*1024,'a'));process.stderr.write(Buffer.alloc(6*1024*1024,'b'));setInterval(()=>{},1000);",
  );
  const result = await BashTool.call(
    {
      command: `${quote(process.execPath)} ${quote(file)}`,
      description: "output limit",
      run_in_background: true,
    },
    context,
  );
  const job = getJob(context.sessionId, String(result.metadata?.jobId));
  if (!job) throw new Error("missing job");
  await waitFor(() => job.status !== "running");
  expect(job.status).toBe("killed");
  expect(job.truncated).toBe(true);
  expect(job.killReason).toContain("10MB");
  expect(Buffer.byteLength(job.stdout + job.stderr, "utf8")).toBeLessThan(11 * 1024 * 1024);
});
