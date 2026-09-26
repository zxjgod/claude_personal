import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPermission } from "../permissions.js";
import { checkReadBeforeEdit, markRead } from "../read-tracker.js";
import { SpeculationCache } from "../speculation.js";
import { executeSingleTool, promoteSpeculativeRead } from "../tool-executor.js";
import { BashTool } from "../tools/core/bash.js";
import { EditTool } from "../tools/core/edit.js";
import { GrepTool } from "../tools/core/grep.js";
import { PowerShellTool } from "../tools/core/powershell.js";
import { ReadTool } from "../tools/core/read.js";
import { WriteTool } from "../tools/core/write.js";
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

// ============================================================
// Tool-level boundary check vs --add-dir (review follow-up):
// checkDangerousPattern's outside-workspace flag feeds edit/write's
// HARD-deny checkPermissions, so it must honor allowedDirectories
// or explicitly granted directories become uneditable without prompt.
// ============================================================

describe("tool-level boundary vs --add-dir (review follow-up)", () => {
  it("edit's hard-deny honors context.allowedDirectories", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-added-"));
    try {
      const target = path.join(outside, "x.ts");
      const input = { filePath: target, oldString: "a", newString: "b" };
      // Without the grant: hard-denied at the tool level (no prompt).
      const denied = await EditTool.checkPermissions!(input, ctx);
      expect(denied).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("outside workspace"),
      });
      // With --add-dir wiring the directory into allowedDirectories: allowed
      // (the user explicitly granted it; resolveInWorkspace agrees).
      const allowed = await EditTool.checkPermissions!(input, {
        ...ctx,
        allowedDirectories: [outside],
      });
      expect(allowed.allowed).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Speculative prefetch guards (Top10 #6), end-to-end through
// the real executeSingleTool × SpeculationCache × ReadTool chain
// ============================================================

describe("speculative prefetch guards (Top10 #6)", () => {
  function execCtx(sessionId: string): ToolContext {
    return { ...ctx, permissionMode: "bypassPermissions", sessionId };
  }

  it("cache-hit consumption promotes the read into the read-before-edit tracker", async () => {
    const file = path.join(fixture, "promote.txt");
    fs.writeFileSync(file, "original content\n");
    const ectx = execCtx("promo-hit");
    const cache = new SpeculationCache(true);
    cache.prefetch([{ toolName: "read", input: { filePath: file } }], [ReadTool], ectx);

    const res = await executeSingleTool(
      {
        id: "c1",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ filePath: file }) },
      },
      [ReadTool],
      ectx,
      async () => true,
      undefined,
      cache,
    );
    expect(res.isError).toBe(false);
    expect(res.formatted).toContain("original content");
    expect(cache.hits).toBe(1);
    // The model has now genuinely seen this file (served from cache): the
    // read-before-edit gate must open for exactly the prefetched version.
    const { mtimeMs } = fs.statSync(file);
    expect(checkReadBeforeEdit("promo-hit", file, mtimeMs).ok).toBe(true);
  });

  it("an unconsumed prefetch leaves the read-before-edit gate CLOSED", async () => {
    const file = path.join(fixture, "silent.txt");
    fs.writeFileSync(file, "content\n");
    const ectx = execCtx("promo-silent");
    const cache = new SpeculationCache(true);
    cache.prefetch([{ toolName: "read", input: { filePath: file } }], [ReadTool], ectx);
    await new Promise((r) => setTimeout(r, 150)); // let the background read finish
    const { mtimeMs } = fs.statSync(file);
    // The speculative read ran, but the model never saw it → no Edit rights.
    expect(checkReadBeforeEdit("promo-silent", file, mtimeMs).ok).toBe(false);
  });

  it("deferSpecPromotion holds promotion back until the collector commits it (review M4)", async () => {
    // The streaming early-start path passes deferSpecPromotion: an early-started
    // result can still be DISCARDED by a mid-stream error retry, so executing
    // it must not open the gate — runOne promotes when it collects the result
    // into the committed batch.
    const file = path.join(fixture, "deferred.txt");
    fs.writeFileSync(file, "content\n");
    const ectx = execCtx("promo-defer");
    const cache = new SpeculationCache(true);
    cache.prefetch([{ toolName: "read", input: { filePath: file } }], [ReadTool], ectx);

    const res = await executeSingleTool(
      {
        id: "c1",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ filePath: file }) },
      },
      [ReadTool],
      ectx,
      async () => true,
      undefined,
      cache,
      undefined,
      undefined,
      { deferSpecPromotion: true },
    );
    expect(res.isError).toBe(false);
    expect(cache.hits).toBe(1);
    const { mtimeMs } = fs.statSync(file);
    // Executed via cache hit, but NOT promoted — a discarded attempt leaves no trace.
    expect(checkReadBeforeEdit("promo-defer", file, mtimeMs).ok).toBe(false);
    // The collector (runOne at STEP 5) promotes once the result is committed.
    promoteSpeculativeRead(res, "promo-defer");
    expect(checkReadBeforeEdit("promo-defer", file, mtimeMs).ok).toBe(true);
  });

  it("a completing write invalidates the cached read for that path", async () => {
    const file = path.join(fixture, "mutate.txt");
    fs.writeFileSync(file, "v1\n");
    const ectx = execCtx("promo-write");
    // WriteTool enforces read-before-edit for existing files → mark it first.
    markRead("promo-write", file, fs.statSync(file).mtimeMs);
    const cache = new SpeculationCache(true);
    cache.prefetch([{ toolName: "read", input: { filePath: file } }], [ReadTool], ectx);

    const res = await executeSingleTool(
      {
        id: "w1",
        type: "function",
        function: { name: "write", arguments: JSON.stringify({ filePath: file, content: "v2\n" }) },
      },
      [WriteTool],
      ectx,
      async () => true,
      undefined,
      cache,
    );
    expect(res.isError).toBe(false);
    // The prefetched (now stale, pre-write) read must NOT be served.
    // (The write's own execution already counted one take-miss for "write".)
    const missesBefore = cache.misses;
    expect(await cache.take("read", { filePath: file })).toBeNull();
    expect(cache.misses).toBe(missesBefore + 1);
    expect(cache.hits).toBe(0);
  });

  it("a mutating tool without path info clears the whole cache (bash)", async () => {
    const file = path.join(fixture, "any.txt");
    fs.writeFileSync(file, "v1\n");
    const ectx = execCtx("promo-bash");
    const cache = new SpeculationCache(true);
    cache.prefetch([{ toolName: "read", input: { filePath: file } }], [ReadTool], ectx);

    const res = await executeSingleTool(
      {
        id: "b1",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({
            command: "echo mutated > any.txt",
            description: "mutate via shell",
          }),
        },
      },
      [BashTool],
      ectx,
      async () => true,
      undefined,
      cache,
    );
    expect(res.isError).toBe(false);
    // bash can mutate anything → conservative full clear.
    expect(await cache.take("read", { filePath: file })).toBeNull();
  });
});
