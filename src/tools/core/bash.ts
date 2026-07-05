// ============================================================
// Bash Tool
// ============================================================

import { spawn } from "node:child_process";
import { z } from "zod";
import { checkDangerousPattern } from "../../permissions.js";
import type { Tool, ToolResult } from "../../types.js";
import { InputValidator } from "../../utils/input-validator.js";
import { buildTool } from "../registry.js";
import { bashCommandIsReadOnly } from "../utils/command.js";

const BashSchema = z.strictObject({
  command: z.string().describe("The CLI command to execute"),
  description: z.string().describe("What this command does (shown to user)"),
  timeout: z.number().optional().describe("Timeout in ms (default: 120000)"),
});
type BashInput = z.infer<typeof BashSchema>;

export const BashTool: Tool = buildTool({
  name: "bash",
  description: "Execute a shell command",
  promptDescription:
    "Execute a shell command. Commands must be non-interactive. Very large output is " +
    "saved to a file and you receive a preview plus the path (read it for the full output).",
  schema: BashSchema,
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

    const timeout = input.timeout ?? 120_000;
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

    const child = spawn(input.command, [], {
      cwd: context.workspaceRoot,
      shell: process.env.ComSpec || (process.platform === "win32" ? "cmd.exe" : "/bin/bash"),
      windowsHide: true,
      // On Unix, give the child its own process group so we can signal the
      // whole tree via process.kill(-pid). On Windows we use taskkill /T.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    const MAX_OUTPUT = 10 * 1024 * 1024; // 10MB cap on accumulated output
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT) {
        truncated = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT) {
        truncated = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    });

    // Kill the entire process tree (parent + all descendants). This is the
    // only reliable way on Windows to also terminate grandchild processes
    // that the shell spawned — `child.kill()` would only kill cmd.exe and
    // leave orphans holding the pipes, re-introducing the original deadlock.
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

    const exitCode: number | null = await new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(-1));
      // 'close' fires after stdio streams are closed (process tree killed),
      // which is what we need so the captured stdout/stderr are complete.
      child.on("close", (code) => resolve(code));
    });

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
      return {
        content: output || `Command timed out after ${timeout}ms.`,
        truncated: outTruncated,
        error: `Command timed out after ${timeout}ms`,
        metadata: { exitCode: -1, timedOut: true },
      };
    }

    return {
      content: output || "(no output)",
      truncated: outTruncated,
      metadata: { exitCode },
    };
  },

  async checkPermissions(input, context) {
    const danger = checkDangerousPattern("bash", input, context.workspaceRoot);
    if (danger.dangerous) {
      return { allowed: false, reason: danger.reason! };
    }
    return { allowed: true };
  },
});
