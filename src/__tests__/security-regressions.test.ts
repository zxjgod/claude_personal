import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPermission } from "../permissions.js";
import { executeSingleTool } from "../tool-executor.js";
import { BashTool } from "../tools/core/bash.js";
import { GrepTool } from "../tools/core/grep.js";
import { PowerShellTool } from "../tools/core/powershell.js";
import { ReadTool } from "../tools/core/read.js";
import type { ToolContext } from "../types.js";
import { createSubAgentApprover } from "../utils/subagent-security.js";

vi.mock("../audit-log.js", () => ({
  logBashOperation: vi.fn(async () => {}),
  logFileOperation: vi.fn(async () => {}),
  logToolExecution: vi.fn(async () => {}),
}));

let fixture: string;
let ctx: ToolContext;
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-security-"));
  ctx = { workspaceRoot: fixture, sessionId: "security-regression", permissionMode: "plan" };
});
afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

describe("command permission boundaries", () => {
  it.each([
    "Write-Output (Set-Content -LiteralPath marker.txt -Value changed)",
    "Get-Content .env",
    "Get-Content -LiteralPath:.env",
    "Get-Content '.en'v",
    "Get-Content env:API_KEY",
    "Write-Output $env:API_KEY",
    "Get-ArbitraryModuleCommand",
    "Write-OutputEvil x",
    "Get-Content .e*",
    "Get-Content ([IO.File]::ReadAllText('secret'))",
  ])("blocks PowerShell in plan mode: %s", async (command) => {
    const call = vi.fn(async () => ({ content: "must not execute" }));
    const ask = vi.fn(async () => false);
    const result = await executeSingleTool(
      {
        id: "test",
        type: "function",
        function: {
          name: "powershell",
          arguments: JSON.stringify({ command, description: "test" }),
        },
      },
      [{ ...PowerShellTool, call }],
      ctx,
      ask,
    );
    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    "sort input.txt -o output.txt",
    "sort input.txt '--output=out.txt'",
    "git diff --output=review.patch",
    "git log --output=review.txt",
    "git reflog expire --expire=now --all",
    "rg --pre=helper.exe probe input.txt",
    "uniq input.txt output.txt",
    "tree -o output.txt",
    "git log $OPTIONS",
    "git log --ou'tput'=output.txt",
    "git --config-env=core.pager=PAYLOAD log",
  ])("requires approval for Bash side effects: %s", async (command) => {
    const input = { command, description: "test" };
    expect(
      await checkPermission(BashTool, input, ctx, { askUser: async () => true }),
    ).toMatchObject({ allowed: false });
    const ask = vi.fn(async () => false);
    expect(
      await checkPermission(
        BashTool,
        input,
        { ...ctx, permissionMode: "default" },
        { askUser: ask },
      ),
    ).toMatchObject({ allowed: false });
    expect(ask).toHaveBeenCalledOnce();
  });

  it("forwards unknown mutating tools and PowerShell to parent approval", async () => {
    const parent = vi.fn(async () => false);
    const approver = createSubAgentApprover(parent);
    for (const tool of [PowerShellTool, { ...PowerShellTool, name: "new-mutating-tool" }]) {
      expect(
        await checkPermission(
          tool,
          { command: "Set-Content marker.txt changed" },
          { ...ctx, permissionMode: "default" },
          { askUser: approver },
        ),
      ).toMatchObject({ allowed: false });
    }
    expect(parent).toHaveBeenCalledTimes(2);
    expect(
      await createSubAgentApprover()(PowerShellTool, { command: "Set-Content marker.txt changed" }),
    ).toBe(false);
  });
});

describe("Grep sensitive path enforcement", () => {
  it("blocks explicit secrets and excludes them from recursive user globs", async () => {
    fs.writeFileSync(path.join(fixture, ".env"), "PROBE=FAKE_SECRET");
    fs.writeFileSync(path.join(fixture, "credentials.json"), "PROBE=FAKE_CREDENTIAL");
    fs.writeFileSync(path.join(fixture, "public.txt"), "PROBE=PUBLIC");
    expect((await ReadTool.call({ filePath: ".env" }, ctx)).error).toContain("blocked");
    for (const target of [".env", "credentials.json"]) {
      expect((await GrepTool.call({ pattern: "PROBE", path: target }, ctx)).error).toContain(
        "blocked",
      );
    }
    const result = await GrepTool.call({ pattern: "PROBE", glob: "**/*" }, ctx);
    expect(result.content).toContain("PUBLIC");
    expect(result.content).not.toContain("FAKE_");
  });
});
