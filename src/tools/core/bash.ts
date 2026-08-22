// ============================================================
// Bash Tool
// ============================================================

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import chalk from "chalk";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { InputValidator } from "../../utils/input-validator.js";
import { createJob, settleJob } from "../job-store.js";
import { buildTool } from "../registry.js";
import { getCwd, rememberCd } from "../session-cwd.js";
import { bashCommandIsReadOnly } from "../utils/command.js";

const BashSchema = z.strictObject({
  command: z.string().describe("The CLI command to execute"),
  description: z.string().describe("What this command does (shown to user)"),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in ms (default: 120000; background default: 2 hours)"),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run in the background and return a job id immediately (collect with job_output, stop with job_kill).",
    ),
});
type BashInput = z.infer<typeof BashSchema>;

/** 10MB cap on accumulated output — overflow kills the process tree. */
const MAX_OUTPUT = 10 * 1024 * 1024;
const DEFAULT_BACKGROUND_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BACKGROUND_TTL_MS = 24 * 60 * 60 * 1000;

export const BashTool: Tool = buildTool({
  name: "bash",
  description: "Execute a shell command",
  promptDescription:
    "Execute a shell command. Commands must be non-interactive (no stdin prompts). " +
    "Use for: running build/test commands, git operations, package managers (npm, pip), " +
    "and CLI tasks without a dedicated tool. " +
    "Parameters: command (required, the CLI command to execute), " +
    "description (required, what this command does for the user), " +
    "timeout (optional, max execution time in milliseconds, default 120000), " +
    "run_in_background (optional, run detached and return a job id — read with " +
    "job_output, stop with job_kill). " +
    "The working directory persists across calls within a session (use `cd <dir>`). " +
    "Very large output is saved to a file and you receive a preview plus the path.",
  schema: BashSchema,
  searchHint: "shell command execute run script build test git npm background job",
  // Data-driven (M29): a read-only command (`cat`, `ls`, `git status`…) is
  // auto-approved and safe to parallelize; anything else routes through
  // approval and runs serially. Concurrency-safety mirrors read-only because a
  // command with no side effects can't race another.
  isReadOnly: (input) => bashCommandIsReadOnly(input?.command),
  isConcurrencySafe: (input) => bashCommandIsReadOnly(input?.command),

  async call(input, context): Promise<ToolResult> {
    // P1: Validate command input
    const commandValidation = InputValidator.validateCommand(input.command);
    if (!commandValidation.valid) {
      return { content: "", error: commandValidation.error };
    }

    // A non-positive timeout (0 / negative) would disable the timer entirely and
    // let a silent never-exiting command hang the loop forever. Clamp it so "no
    // timeout" can never mean "infinite hang".
    const timeout = input.timeout && input.timeout > 0 ? input.timeout : 120_000;

    // M39: seed the spawn cwd from the remembered session cwd, falling back to
    // the workspace root on the first call.
    const cwd = getCwd(context.sessionId) ?? context.workspaceRoot;

    if (input.run_in_background) {
      return runInBackground(input, context, cwd);
    }

    const abortSignal = context.abortSignal;

    // IMPORTANT: We deliberately do NOT use `exec`/`execAsync` here.
    //
    // On Windows, `exec(cmd, { shell: 'cmd.exe' })` spawns cmd.exe as the
    // direct child, and the real command runs as a *grandchild* of cmd.exe.
    // When `exec`'s `timeout` (or AbortSignal) fires, Node only kills the
    // direct child (cmd.exe). The grandchild becomes an orphan that keeps
    // holding the stdout/stderr pipe write-ends. Because the pipe never
    // closes, the `execAsync` promise never settles — the agent loop hangs
    // forever (UI spinner never stops), and Ctrl+C is ineffective.
    //
    // Fix: spawn the shell ourselves and, on timeout/abort, kill the ENTIRE
    // process tree with `taskkill /T /F` (Windows) or a process-group signal
    // (Unix). This guarantees the pipe closes and the promise always settles.

    const { child, killTree } = spawnShell(input.command, cwd);

    let stdout = "";
    let stderr = "";
    let truncated = false;
    // Decode incrementally so a multibyte UTF-8 character split across two
    // `data` chunks is reassembled instead of emitting a U+FFFD replacement.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let outputBytes = 0;
    const appendOutput = (chunk: string, target: "stdout" | "stderr") => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
      if (outputBytes > MAX_OUTPUT) {
        truncated = true;
        killTree();
      }
    };
    child.stdout?.on("data", (d: Buffer) => {
      appendOutput(stdoutDecoder.write(d), "stdout");
    });
    child.stderr?.on("data", (d: Buffer) => {
      appendOutput(stderrDecoder.write(d), "stderr");
    });

    let timedOut = false;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree();
          }, timeout)
        : null;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      killTree();
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        aborted = true;
        killTree();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let spawnError = "";
    const exitCode: number | null = await new Promise<number | null>((resolve) => {
      child.on("error", (err) => {
        spawnError = err.message;
        resolve(-1);
      });
      // 'close' fires after stdio streams are closed (process tree killed),
      // which is what we need so the captured stdout/stderr are complete.
      child.on("close", (code) => resolve(code));
    });
    // Flush an incomplete final UTF-8 sequence rather than silently dropping it.
    appendOutput(stdoutDecoder.end(), "stdout");
    appendOutput(stderrDecoder.end(), "stderr");

    if (timer) clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);

    // Aborted (Ctrl+C) takes precedence over timeout.
    if (aborted) {
      return {
        content: "Command aborted.",
        metadata: { exitCode: -1, aborted: true },
      };
    }

    let output = "";
    if (stdout) output += stdout;
    if (stderr) output += (output ? "\n" : "") + stderr;

    // M30: no longer hard-slice at 30k here. Oversized output spills to disk at
    // the agent-loop boundary (the model gets a preview + path; the UI keeps the
    // full text). `outTruncated` now reflects only the 10MB in-memory guard
    // above, which is genuine data loss the formatter should flag.
    const outTruncated = truncated;

    // timedOut is set by our killTree timer. We cannot rely on exitCode === null
    // here: on Windows `taskkill /T /F` makes the shell exit with code 1 (a real
    // number), so the kill is indistinguishable from a genuine non-zero exit by
    // code alone. The explicit flag is the only reliable signal that WE killed it
    // for running too long.
    if (timedOut) {
      const timeoutSecs = Math.round(timeout / 1000);
      return {
        content: output || `Command timed out after ${timeoutSecs}s`,
        truncated: outTruncated,
        error:
          `Command timed out (${timeoutSecs}s)\n` +
          chalk.gray(`   Hint: if this is expected, increase the timeout parameter`) +
          (output ? `\n${chalk.gray("   Output so far:")}\n${output.slice(0, 500)}` : ""),
        metadata: { exitCode: -1, timedOut: true },
      };
    }

    // Non-zero exit code indicates command failure
    if (exitCode !== null && exitCode !== 0) {
      const truncatedNote = outTruncated
        ? `\n${chalk.yellow("   ⚠️ output truncated (over 10MB limit)")}`
        : "";
      // `spawnError` is set when the child never spawned (ENOENT etc.) — surface
      // the real reason rather than a bare "exit code: -1".
      const spawnNote = spawnError ? `\n${chalk.gray("   Spawn failed:")} ${spawnError}` : "";
      return {
        content: output || spawnError || "(no output)",
        truncated: outTruncated,
        error:
          `Command failed (exit code: ${exitCode})${truncatedNote}${spawnNote}\n` +
          chalk.gray("   Hint: check the command syntax and arguments"),
        metadata: { exitCode },
      };
    }

    // M39: a successful `cd <dir>` sticks for the next bash call.
    if (exitCode === 0) {
      rememberCd(context.sessionId, cwd, input.command);
    }

    return {
      content: output || "(no output)",
      truncated: outTruncated,
      metadata: { exitCode },
    };
  },
});

// ============================================================
// Shared spawn helpers
// ============================================================

/** The shell the command runs through (cmd.exe on Windows, bash elsewhere). */
function shellName(): string {
  return process.env.ComSpec || (process.platform === "win32" ? "cmd.exe" : "/bin/bash");
}

/**
 * Spawn the command in its own shell and return the child plus a killTree that
 * terminates the WHOLE process tree. This is the shared core of the foreground
 * and background paths — the tree kill is what prevents the Windows
 * orphan-deadlock described in `call` above.
 */
function spawnShell(command: string, cwd: string): { child: ChildProcess; killTree: () => void } {
  const child = spawn(command, [], {
    cwd,
    shell: shellName(),
    windowsHide: true,
    // On Unix, give the child its own process group so we can signal the
    // whole tree via process.kill(-pid). On Windows we use taskkill /T.
    detached: process.platform !== "win32",
  });

  const killTree = () => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === "win32") {
        // /T = kill tree, /F = force
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).unref();
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      // Process may already be gone — ignore.
    }
  };

  return { child, killTree };
}

/**
 * Background path (M38): spawn detached, register a session job, and return the
 * job id immediately. Output accumulates on the job; the job settles when the
 * process tree exits or is killed via job_kill.
 *
 * Background jobs deliberately IGNORE `context.abortSignal`. A background job
 * exists to outlive the current turn (the model starts it, keeps working, then
 * polls with job_output), so Ctrl+C / turn-abort must NOT tear it down — the
 * whole point is that it survives the request that spawned it. The only way to
 * stop one is an explicit job_kill. This mirrors task/sub-agent semantics.
 */
function runInBackground(input: BashInput, context: ToolContext, cwd: string): ToolResult {
  const job = createJob(context.sessionId, {
    kind: "bash",
    command: input.command,
    description: input.description,
  });

  const { child, killTree } = spawnShell(input.command, cwd);
  job.kill = killTree;

  // Decode incrementally (same multibyte-safety rationale as the foreground path).
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  child.stdout?.on("data", (d: Buffer) => {
    job.stdout += stdoutDecoder.write(d);
    // Same 10MB guard as the foreground path — kill the tree rather than let
    // a runaway process grow the in-memory buffer without bound. Mark the job
    // truncated so job_output can surface the data loss (the foreground path
    // flags it; the background path must too, since it has no `truncated` field
    // on ToolResult).
    if (job.stdout.length > MAX_OUTPUT) {
      job.truncated = true;
      killTree();
    }
  });
  child.stderr?.on("data", (d: Buffer) => {
    job.stderr += stderrDecoder.write(d);
    if (job.stderr.length > MAX_OUTPUT) {
      job.truncated = true;
      killTree();
    }
  });

  // Background jobs get a bounded default TTL. An explicit timeout is still
  // honored, but values above the cap are clamped to prevent accidental
  // effectively-infinite jobs from leaking process trees.
  const requestedTimeout =
    input.timeout && input.timeout > 0 ? input.timeout : DEFAULT_BACKGROUND_TTL_MS;
  const timeoutMs = Math.min(requestedTimeout, MAX_BACKGROUND_TTL_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      job.killReason = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      killTree();
      settleJob(job, "killed", null);
    }, timeoutMs);
  }
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  child.on("error", (err) => {
    // Spawn failure (e.g. ENOENT — command not found): surface the reason in
    // the job output instead of leaving it empty with a bare exit code.
    clearTimer();
    job.stderr += `spawn failed: ${err.message}\n`;
    settleJob(job, "done", -1);
  });
  child.on("close", (code) => {
    clearTimer();
    settleJob(job, "done", code);
  });

  const preview = input.description || input.command;
  return {
    content:
      `Started background job ${job.id} (${preview.slice(0, 80)}).\n` +
      `Read its output with job_output (job_id: "${job.id}"); stop it with job_kill.`,
    metadata: { jobId: job.id },
  };
}
