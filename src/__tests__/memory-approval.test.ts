// ============================================================
// Tests: MemorySave approval gate toggle (/memory-approval) + settings target
// ============================================================
// The gate DEFAULTS TO OFF (user decision 2026-10-04 — silent writes like the
// pre-T2 behavior; deny rules and plan mode still apply). The persistence
// target follows the install location (settings-target.ts): user level for a
// global install, project level for a local run; managed settings can force ON.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initMemoryApproval,
  isMemoryApprovalRequired,
  persistMemoryApproval,
  setMemoryApproval,
} from "../memory-approval.js";
import { isGlobalInstall, settingsTargetFile } from "../settings-target.js";
import { MemorySaveTool } from "../tools/extended/memory-save.js";
import type { ToolContext } from "../types.js";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: tmp("memgate-ws-"),
    sessionId: "memgate-test",
    permissionMode: "default",
    ...overrides,
  };
}

const input = { content: "a durable lesson worth keeping" };

describe("memory-approval — gate state", () => {
  afterEach(() => setMemoryApproval(false)); // reset to default OFF

  it("off (default): approves without asking; deny rules and plan mode still apply", async () => {
    setMemoryApproval(false);
    const askUser = vi.fn();
    const r = await MemorySaveTool.checkPermissions(input, ctx({ askUser }));
    expect(r.allowed).toBe(true);
    expect(askUser).not.toHaveBeenCalled();

    // plan mode still blocks
    const rp = await MemorySaveTool.checkPermissions(input, ctx({ permissionMode: "plan" }));
    expect(rp.allowed).toBe(false);
  });

  it("call() writes without prompting when the gate is off", async () => {
    setMemoryApproval(false);
    const c = ctx(); // no askUser at all — must not matter
    const r = await MemorySaveTool.call(input, c);
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("Saved to durable memory");
  });

  it("on: approval required (askUser consulted)", async () => {
    setMemoryApproval(true);
    const askUser = vi.fn().mockResolvedValue(true);
    const r = await MemorySaveTool.checkPermissions(input, ctx({ askUser }));
    expect(r.allowed).toBe(true);
    expect(askUser).toHaveBeenCalledOnce();
  });

  it("on: denies when the user declines", async () => {
    setMemoryApproval(true);
    const askUser = vi.fn().mockResolvedValue(false);
    const r = await MemorySaveTool.checkPermissions(input, ctx({ askUser }));
    expect(r.allowed).toBe(false);
  });

  it("on: call() fails closed when there is no approver", async () => {
    setMemoryApproval(true);
    const r = await MemorySaveTool.call(input, ctx());
    expect(r.error).toContain("explicit approval");
  });
});

describe("settings-target — install-location resolution", () => {
  it("package outside the workspace → global install → user-level target", () => {
    const workspace = tmp("st-ws-");
    process.env.CCR_USER_CONFIG_DIR = tmp("st-user-");
    try {
      // Default packageRoot (this repo) is outside the tmp workspace.
      expect(isGlobalInstall(workspace)).toBe(true);
      expect(settingsTargetFile(workspace)).toBe(
        path.join(process.env.CCR_USER_CONFIG_DIR, "settings.json"),
      );
    } finally {
      delete process.env.CCR_USER_CONFIG_DIR;
    }
  });

  it("package inside the workspace → local run → project-level target", () => {
    const workspace = tmp("st-ws-");
    const pkgInside = path.join(workspace, "node_modules", "claude-code-replica");
    expect(isGlobalInstall(workspace, pkgInside)).toBe(false);
    expect(settingsTargetFile(workspace, pkgInside)).toBe(
      path.join(workspace, ".claude", "settings.json"),
    );
  });

  it("package == workspace (npm start from a clone) → local run", () => {
    const workspace = tmp("st-ws-");
    expect(isGlobalInstall(workspace, workspace)).toBe(false);
  });
});

describe("memory-approval — persistence follows the target", () => {
  const savedUserDir = process.env.CCR_USER_CONFIG_DIR;
  const savedManaged = process.env.CCR_MANAGED_SETTINGS;
  let userDir: string;
  let workspace: string;

  beforeEach(() => {
    userDir = tmp("memgate-user-");
    workspace = tmp("memgate-ws-"); // package root outside → global-install branch
    process.env.CCR_USER_CONFIG_DIR = userDir;
    delete process.env.CCR_MANAGED_SETTINGS;
    setMemoryApproval(false);
  });
  afterEach(() => {
    if (savedUserDir === undefined) delete process.env.CCR_USER_CONFIG_DIR;
    else process.env.CCR_USER_CONFIG_DIR = savedUserDir;
    if (savedManaged === undefined) delete process.env.CCR_MANAGED_SETTINGS;
    else process.env.CCR_MANAGED_SETTINGS = savedManaged;
    setMemoryApproval(false);
  });

  it("defaults OFF when the target settings say nothing", () => {
    initMemoryApproval(workspace);
    expect(isMemoryApprovalRequired()).toBe(false);
  });

  it("honors requireApproval:true from the target (user) settings", () => {
    fs.writeFileSync(
      path.join(userDir, "settings.json"),
      JSON.stringify({ memory: { requireApproval: true } }),
      "utf-8",
    );
    initMemoryApproval(workspace);
    expect(isMemoryApprovalRequired()).toBe(true);
  });

  it("managed settings can force the gate ON", () => {
    const managed = path.join(tmp("memgate-managed-"), "managed.json");
    fs.writeFileSync(managed, JSON.stringify({ memory: { requireApproval: true } }), "utf-8");
    process.env.CCR_MANAGED_SETTINGS = managed;
    initMemoryApproval(workspace);
    expect(isMemoryApprovalRequired()).toBe(true);
  });

  it("persist writes the target settings file and preserves other keys", () => {
    fs.writeFileSync(
      path.join(userDir, "settings.json"),
      JSON.stringify({ theme: "dark" }),
      "utf-8",
    );
    persistMemoryApproval(true, workspace);
    expect(isMemoryApprovalRequired()).toBe(true);
    const written = JSON.parse(
      fs.readFileSync(path.join(userDir, "settings.json"), "utf-8"),
    ) as Record<string, any>;
    expect(written.memory.requireApproval).toBe(true);
    expect(written.theme).toBe("dark"); // untouched
  });
});
