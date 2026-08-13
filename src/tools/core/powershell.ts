// ============================================================
// PowerShell Tool — Windows shell (mirrors Bash for cmd.exe)
// ============================================================
// Same contract as Bash but spawns powershell.exe -NoProfile -NonInteractive.
// Windows users get a first-class PowerShell tool; the read-only/danger
// detection lives in utils/command.ts and permissions.ts respectively.

import { spawn } from "node:child_process";
import chalk from "chalk";
import { z } from "zod";
import { checkDangerousPattern } from "../../permissions.js";
import type { Tool, ToolResult } from "../../types.js";
import { InputValidator } from "../../utils/input-validator.js";
import { buildTool } from "../registry.js";
import { powershellCommandIsReadOnly } from "../utils/command.js";

const PowerShellSchema = z.strictObject({
  command: z.string().describe("The PowerShell command to execute"),
  description: z.string().describe("What this command does (shown to user)"),
  timeout: z.number().optional().describe("Timeout in ms (default: 120000)"),
});
type PowerShellInput = z.infer<typeof PowerShellSchema>;

const shellFor = (): string =>
  process.platform === "win32" ? "powershell.exe" : process.env.PWSH || "pwsh";
const shellArgs = (command: string): string[] => [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  command,
];

export const PowerShellTool: Tool = buildTool({
  name: "powershell",
  description: "Execute a PowerShell command",
  promptDescription:
    "Execute a PowerShell command (non-interactive). Use for Windows-specific tasks " +
    "(registry, services, PowerShell cmdlets) that the Bash tool can't express. " +
    "Parameters: command (required), description (required, what it does), " +
    "timeout (optional, ms, default 120000).",
  schema: PowerShellSchema,
  searchHint: "powershell shell execute command script windows cmdlet",
  // Data-driven (M29): read-only PowerShell (Get-*/Test-*) is auto-approved and
  // safe to parallelize; anything else routes through approval and runs serially.
  isReadOnly: (input) => powershellCommandIsReadOnly(input?.command),
  isConcurrencySafe: (input) => powershellCommandIsReadOnly(input?.command),

  async call(input, context): Promise<ToolResult> {
    const commandValidation = InputValidator.validateCommand(input.command);
    if (!commandValidation.valid) {
      return { content: "", error: commandValidation.error };
    }

    // A non-positive timeout would disable the timer and let a hung command
    // block the loop forever — clamp so "no timeout" never means "infinite".
    const timeout = input.timeout && input.timeout > 0 ? input.timeout : 120_000;
    const abortSignal = context.abortSignal;

    // Same process-tree-kill strategy as Bash (see bash.ts): spawn the shell
    // ourselves and, on timeout/abort/overflow, kill the WHOLE tree so a
    // grandchild can't hold the pipe open and deadlock the loop on Windows.
    const child = spawn(shellFor(), shellArgs(input.command), {
      cwd: context.workspaceRoot,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).unref();
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // Process may already be gone.
      }
    };

    let stdout = "";
    let stderr = "";
    let overflowed = false;
    const MAX_OUTPUT = 10 * 1024 * 1024;
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT) {
        overflowed = true;
        killTree();
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT) {
        overflowed = true;
        killTree();
      }
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

    const exitCode: number | null = await new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(-1));
      child.on("close", (code) => resolve(code));
    });

    if (timer) clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);

    if (aborted) {
      return { content: "Command aborted.", metadata: { exitCode: -1, aborted: true } };
    }

    const output = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");

    if (timedOut) {
      const secs = Math.round(timeout / 1000);
      return {
        content: output || `Command timed out after ${secs}s`,
        truncated: overflowed,
        error:
          `Command timed out (${secs}s)\n` +
          chalk.gray(`   Hint: if this is expected, increase the timeout parameter`),
        metadata: { exitCode: -1, timedOut: true },
      };
    }

    if (exitCode !== null && exitCode !== 0) {
      return {
        content: output || "(no output)",
        truncated: overflowed,
        error:
          `Command failed (exit code: ${exitCode})\n` +
          chalk.gray("   Hint: check the command syntax and arguments"),
        metadata: { exitCode },
      };
    }

    return {
      content: output || "(no output)",
      truncated: overflowed,
      metadata: { exitCode },
    };
  },

  async checkPermissions(input, context) {
    const danger = checkDangerousPattern("powershell", input, context.workspaceRoot);
    if (danger.dangerous) {
      return { allowed: false, reason: danger.reason! };
    }
    return { allowed: true };
  },
});
