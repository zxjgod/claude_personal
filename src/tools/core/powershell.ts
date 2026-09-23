// ============================================================
// PowerShell Tool — Windows shell (mirrors Bash for cmd.exe)
// ============================================================
// Same contract as Bash but spawns powershell.exe -NoProfile -NonInteractive.
// Windows users get a first-class PowerShell tool; the read-only/danger
// detection lives in utils/command.ts and permissions.ts respectively.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import chalk from "chalk";
import { z } from "zod";
import { runWindowsSandbox } from "../../native-sandbox.js";
import {
  loadSandboxPolicy,
  nativeSandboxSupported,
  requiresNativeSandbox,
  sandboxViolation,
} from "../../sandbox-policy.js";
import type { Tool, ToolResult } from "../../types.js";
import { invalidateToolWritableScopes } from "../../utils/fs-cache.js";
import { InputValidator } from "../../utils/input-validator.js";
import { buildTool } from "../registry.js";
import { getCwd, rememberCd } from "../session-cwd.js";
import { powershellCommandIsReadOnly } from "../utils/command.js";

const PowerShellSchema = z.strictObject({
  command: z.string().describe("The PowerShell command to execute"),
  description: z.string().describe("What this command does (shown to user)"),
  timeout: z.number().optional().describe("Timeout in ms (default: 120000)"),
});

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

    // M39 parity with Bash: seed the spawn cwd from the remembered session cwd.
    const cwd = getCwd(context.sessionId) ?? context.workspaceRoot;
    const policy = loadSandboxPolicy(context.workspaceRoot);
    const violation = sandboxViolation(policy, input.command, cwd);
    if (violation) return { content: "", error: violation };
    if (requiresNativeSandbox(policy)) {
      if (!nativeSandboxSupported())
        return {
          content: "",
          error: "Native sandbox is unavailable on this platform; command refused.",
        };
      // The command would otherwise pass through THREE parsers (cmd's `( )`
      // group → powershell's argv → the script itself) that do not agree on
      // quote escaping: JSON.stringify's `\"` is the MSVCRT argv idiom, but
      // cmd treats the backslash as literal and the quote as a quote-state
      // TOGGLE — `Write-Host "a & b"` broke the group and leaked `&` as a
      // command separator (ParserError: string missing its terminator).
      // Staging the script to a temp .ps1 removes the escaping problem: the
      // only token any parser sees is one quoted file path.
      const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-psx-"));
      const scriptFile = path.join(scriptDir, "command.ps1");
      try {
        // BOM: Windows PowerShell 5.1 reads a .ps1 WITHOUT a BOM as ANSI
        // (GBK on a cp936 machine), mangling non-ASCII string literals in the
        // command. The OutputEncoding prefix mirrors the non-native path.
        fs.writeFileSync(
          scriptFile,
          // BOM via char code — keeps this source free of escape-sequence
          // fragility across the TS template / editor / formatter layers.
          `${String.fromCharCode(0xfeff)}[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${input.command}`,
          "utf8",
        );
        const result = await runWindowsSandbox({
          // -File, not -Command: no argv re-parsing of the payload. Bypass is
          // required because -File (unlike -Command) honors the execution
          // policy, and Restricted is the client default.
          command: `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}"`,
          cwd,
          timeoutMs: timeout,
          signal: abortSignal,
        });
        // Abort wins over every other branch (see bash.ts, same reasoning).
        if (abortSignal?.aborted)
          return { content: "Command aborted.", metadata: { exitCode: -1, aborted: true } };
        // A timeout arrives with code null — exclude it from the refusal check
        // so the partial output and the honest timeout error survive.
        if (!result.timedOut && (result.code === null || result.code < 0))
          return {
            content: "",
            // Forward the runner's own diagnostics (see bash.ts, same wiring).
            error: `Native Windows sandbox could not be started; command refused.${result.stderr ? `\n${result.stderr}` : ""}`,
          };
        // M39 parity with the non-native path: a successful `cd <dir>` sticks.
        if (!result.timedOut && result.code === 0)
          rememberCd(context.sessionId, cwd, input.command);
        // M3: a shell command may touch the fs — drop cached listings.
        invalidateToolWritableScopes(context);
        return {
          content: [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)",
          truncated: result.truncated,
          error: result.timedOut
            ? `Command timed out (${Math.round(timeout / 1000)}s)`
            : result.code !== 0
              ? `Command failed (exit code: ${result.code})`
              : undefined,
          metadata: result.timedOut ? { exitCode: -1, timedOut: true } : { exitCode: result.code },
        };
      } finally {
        fs.rmSync(scriptDir, { recursive: true, force: true });
      }
    }

    // Force UTF-8 output. powershell.exe on a Chinese/Japanese/Korean Windows
    // writes pipes in the console codepage (GBK/cp936 etc.), which utf8
    // decoding renders as mojibake; pwsh already defaults to UTF-8 and accepts
    // this harmlessly. NOTE: the prefix is added ONLY to the spawned payload —
    // read-only classification and validation above saw the original command.
    const psCommand = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${input.command}`;

    // Same process-tree-kill strategy as Bash (see bash.ts): spawn the shell
    // ourselves and, on timeout/abort/overflow, kill the WHOLE tree so a
    // grandchild can't hold the pipe open and deadlock the loop on Windows.
    const child = spawn(shellFor(), shellArgs(psCommand), {
      cwd,
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
    // Decode incrementally so a multibyte character split across two `data`
    // chunks is reassembled instead of emitting U+FFFD (mirrors bash.ts).
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (d: Buffer) => {
      stdout += stdoutDecoder.write(d);
      if (stdout.length > MAX_OUTPUT) {
        overflowed = true;
        killTree();
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += stderrDecoder.write(d);
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

    let spawnError = "";
    const exitCode: number | null = await new Promise<number | null>((resolve) => {
      child.on("error", (err) => {
        // Surface the real reason (ENOENT etc.) instead of a bare "-1".
        spawnError = err.message;
        resolve(-1);
      });
      child.on("close", (code) => resolve(code));
    });

    if (timer) clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);

    // M3: a shell command may touch the fs — drop cached listings. Placed
    // BEFORE the abort/timeout/error returns so a killed command that already
    // wrote files still invalidates (parity with the native path and bash).
    invalidateToolWritableScopes(context);

    if (aborted) {
      return { content: "Command aborted.", metadata: { exitCode: -1, aborted: true } };
    }

    // M39: a bare successful `cd <dir>` sticks for the next call (Bash parity).
    if (exitCode === 0) rememberCd(context.sessionId, cwd, input.command);

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
      // `spawnError` is set when the child never spawned (ENOENT etc.) —
      // surface the real reason rather than a bare "exit code: -1".
      const spawnNote = spawnError ? `\n${chalk.gray("   Spawn failed:")} ${spawnError}` : "";
      return {
        content: output || spawnError || "(no output)",
        truncated: overflowed,
        error:
          `Command failed (exit code: ${exitCode})${spawnNote}\n` +
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
});
