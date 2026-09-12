// ============================================================
// Tool-level e2e for the native Windows sandbox path (win32 only)
// ============================================================
// sandbox-policy.test.ts covers the runner (runWindowsSandbox) directly;
// these cover the TOOL exit layer — the mapping from runner result to
// ToolResult in bash.ts / powershell.ts. Two regressions lived exactly here
// and were invisible to both policy unit tests and runner e2e:
//   1. a timeout arrives as code:null and was misreported as "sandbox could
//      not be started; command refused" (and the partial output dropped);
//   2. the PowerShell tool wrapped the command with JSON.stringify — `\"` is
//      the MSVCRT argv idiom, NOT a cmd.exe quote escape, so any command
//      containing double quotes died with ParserError before PowerShell ever
//      parsed it. Fixed by staging to a temp .ps1 (BOM'd) and using -File.
// Both only reproduce on the full spawn path on win32, hence it.runIf.
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BashTool } from "../tools/core/bash.js";
import { PowerShellTool } from "../tools/core/powershell.js";
import type { ToolContext } from "../types.js";

const tmpDirs: string[] = [];

/** A workspace whose .claude/sandbox.json forces the native runner. */
function nativeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sbx-tools-"));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "sandbox.json"),
    JSON.stringify({ enabled: true, native: true, network: "allow" }),
  );
  return root;
}

function ctx(root: string, abortSignal?: AbortSignal): ToolContext {
  return {
    workspaceRoot: root,
    // Unique per workspace: the session-cwd map is module-global.
    sessionId: `sandbox-tools-e2e-${root}`,
    permissionMode: "default",
    abortSignal,
  };
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const win32 = it.runIf(process.platform === "win32");

describe("native sandbox tool exit layer (win32 e2e)", () => {
  win32(
    "Bash reports a timeout AS a timeout, keeping partial output",
    async () => {
      const root = nativeWorkspace();
      const res = await BashTool.call(
        {
          command: "echo before-hang & ping -n 30 127.0.0.1 >nul",
          description: "timeout e2e",
          timeout: 4000,
        },
        ctx(root),
      );
      expect(res.error).toContain("timed out");
      expect(res.error).not.toContain("could not be started");
      expect(res.content).toContain("before-hang");
      expect(res.metadata?.timedOut).toBe(true);
    },
    90_000,
  );

  win32(
    "Bash aborts a sandboxed command via abortSignal",
    async () => {
      const root = nativeWorkspace();
      const ac = new AbortController();
      // Fire after the powershell host has spun up (Add-Type takes ~1-2s), so
      // this exercises a kill of a RUNNING sandboxed command, not a pre-abort.
      const timer = setTimeout(() => ac.abort(), 2500);
      const res = await BashTool.call(
        { command: "ping -n 30 127.0.0.1 >nul", description: "abort e2e", timeout: 60_000 },
        ctx(root, ac.signal),
      );
      clearTimeout(timer);
      expect(res.content).toBe("Command aborted.");
      expect(res.metadata?.aborted).toBe(true);
    },
    90_000,
  );

  win32(
    "PowerShell runs commands with double quotes and CJK (temp .ps1 path)",
    async () => {
      const root = nativeWorkspace();
      const res = await PowerShellTool.call(
        // Quotes: the JSON.stringify regression died here (ParserError).
        // CJK: verifies the .ps1 is written WITH a BOM — PowerShell 5.1
        // reads a BOM-less file as ANSI (cp936 here) and mangles the literal.
        { command: 'Write-Output "quoted ok 中文"', description: "ps quoting e2e" },
        ctx(root),
      );
      expect(res.error).toBeUndefined();
      expect(res.content).toContain("quoted ok 中文");
      expect(res.metadata?.exitCode).toBe(0);
    },
    90_000,
  );

  win32(
    "PowerShell reports a timeout AS a timeout",
    async () => {
      const root = nativeWorkspace();
      const res = await PowerShellTool.call(
        { command: "Start-Sleep -Seconds 30", description: "ps timeout e2e", timeout: 4000 },
        ctx(root),
      );
      expect(res.error).toContain("timed out");
      expect(res.error).not.toContain("could not be started");
      expect(res.metadata?.timedOut).toBe(true);
    },
    90_000,
  );
});
