// ============================================================
// Tests: M14 breadth tools (Worktree, Skill, Cron/Sleep, PowerShell)
// ============================================================

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkill, resetSkills } from "../skills.js";
import {
  EnterWorktreeTool,
  ExitWorktreeTool,
  listScheduledJobs,
  resetScheduledJobs,
  resetWorktrees,
  ScheduleCronTool,
  SkillTool,
  SleepTool,
  validateCron,
} from "../tools/m8/m9.js";
import type { ToolContext } from "../types.js";

let repo: string;
let hasGit = true;

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: overrides.workspaceRoot ?? repo,
    sessionId: overrides.sessionId ?? "sess-m14",
    permissionMode: "default",
    ...overrides,
  };
}

beforeEach(() => {
  resetWorktrees("sess-m14");
  resetScheduledJobs();
  resetSkills();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-wt-"));
  try {
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.io"], repo);
    git(["config", "user.name", "Tester"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(["add", "."], repo);
    git(["commit", "-m", "init"], repo);
  } catch {
    hasGit = false;
  }
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- 14.1 Worktree ---------------------------------------------------------

describe("EnterWorktree / ExitWorktree", () => {
  it("creates a worktree on a new branch and reports the path", async () => {
    if (!hasGit) return;
    const r = await EnterWorktreeTool.call({ name: "feat-1", baseRef: "head" }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("feat-1");
    expect(r.content).toContain("Path:");
    expect(fs.existsSync(path.join(repo, ".claude", "worktrees", "feat-1"))).toBe(true);
  });

  it("refuses to exit_worktree with remove when there are uncommitted changes", async () => {
    if (!hasGit) return;
    await EnterWorktreeTool.call({ name: "dirty-1", baseRef: "head" }, ctx());
    const wt = path.join(repo, ".claude", "worktrees", "dirty-1");
    fs.writeFileSync(path.join(wt, "a.txt"), "changed\n");
    const r = await ExitWorktreeTool.call({ action: "remove" }, ctx());
    expect(r.error).toContain("uncommitted changes");
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("removes the worktree when discardChanges=true", async () => {
    if (!hasGit) return;
    await EnterWorktreeTool.call({ name: "rm-1", baseRef: "head" }, ctx());
    const wt = path.join(repo, ".claude", "worktrees", "rm-1");
    fs.writeFileSync(path.join(wt, "a.txt"), "changed\n");
    const r = await ExitWorktreeTool.call({ action: "remove", discardChanges: true }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("deleted");
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("reports no active worktree when the stack is empty", async () => {
    if (!hasGit) return;
    const r = await ExitWorktreeTool.call({ action: "keep" }, ctx());
    expect(r.content).toContain("No active worktree");
  });

  it("errors when not a git repository", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plain2-"));
    try {
      const r = await EnterWorktreeTool.call(
        { name: "x", baseRef: "head" },
        ctx({ workspaceRoot: plain }),
      );
      expect(r.error).toContain("Not a git repository");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

// --- 14.2 Skill ------------------------------------------------------------

describe("SkillTool", () => {
  it("loads a registered skill and includes its instructions", async () => {
    registerSkill({
      name: "test-skill",
      description: "A test skill",
      prompt: "Do the test thing.",
    });
    const r = await SkillTool.call({ skill: "test-skill", args: "foo" }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("test-skill");
    expect(r.content).toContain("Do the test thing.");
    expect(r.content).toContain("Arguments: foo");
  });

  it("lists available skills when the name is unknown", async () => {
    registerSkill({ name: "real-one", description: "real", prompt: "p" });
    const r = await SkillTool.call({ skill: "nope" }, ctx());
    expect(r.error).toContain("Unknown skill");
    expect(r.error).toContain("real-one");
  });

  it("errors when skill is empty", async () => {
    const r = await SkillTool.call({ skill: "" }, ctx());
    expect(r.error).toContain("required");
  });
});

// --- 14.3 Cron / Sleep -----------------------------------------------------

describe("validateCron", () => {
  it("accepts a standard 5-field expression", () => {
    expect(validateCron("*/5 * * * *")).toBeNull();
    expect(validateCron("0 9 * * 1-5")).toBeNull();
    expect(validateCron("30 14 28 2 *")).toBeNull();
  });

  it("rejects wrong field count", () => {
    expect(validateCron("* * *")).not.toBeNull();
    expect(validateCron("* * * * * *")).not.toBeNull();
  });

  it("rejects out-of-range values", () => {
    expect(validateCron("60 * * * *")).not.toBeNull(); // minute > 59
    expect(validateCron("* 24 * * *")).not.toBeNull(); // hour > 23
    expect(validateCron("* * 0 * *")).not.toBeNull(); // dom < 1
  });

  it("rejects malformed steps and ranges", () => {
    expect(validateCron("*/0 * * * *")).not.toBeNull(); // step 0
    expect(validateCron("5-3 * * * *")).not.toBeNull(); // range backwards
  });
});

describe("ScheduleCron", () => {
  it("registers a recurring job for a valid cron", async () => {
    const r = await ScheduleCronTool.call(
      { cron: "*/7 * * * *", prompt: "check the deploy" },
      ctx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("recurring");
    expect(r.content).toContain("*/7 * * * *");
    expect(listScheduledJobs()).toHaveLength(1);
    expect(listScheduledJobs()[0]!.prompt).toBe("check the deploy");
  });

  it("rejects an invalid cron expression", async () => {
    const r = await ScheduleCronTool.call({ cron: "bad", prompt: "x" }, ctx());
    expect(r.error).toBeDefined();
    expect(listScheduledJobs()).toHaveLength(0);
  });

  it("respects durable and recurring flags", async () => {
    const r = await ScheduleCronTool.call(
      { cron: "0 9 * * *", prompt: "x", recurring: false, durable: true },
      ctx(),
    );
    expect(r.content).toContain("one-shot");
    expect(r.content).toContain("durable");
    const job = listScheduledJobs()[0]!;
    expect(job.recurring).toBe(false);
    expect(job.durable).toBe(true);
  });
});

describe("Sleep", () => {
  it("clamps delay to the 60-3600 range", async () => {
    const r = await SleepTool.call({ delaySeconds: 5, reason: "too short" }, ctx());
    expect(r.content).toContain("60s");
  });

  it("enqueues a prompt job when prompt is given", async () => {
    const r = await SleepTool.call({ delaySeconds: 120, reason: "wait", prompt: "resume" }, ctx());
    expect(r.content).toContain("120s");
    expect(r.content).toContain("Job ");
    expect(listScheduledJobs()).toHaveLength(1);
    const job = listScheduledJobs()[0]!;
    expect(job.prompt).toBe("resume");
  });

  it("errors on non-positive delay", async () => {
    const r = await SleepTool.call({ delaySeconds: 0, reason: "x" }, ctx());
    expect(r.error).toContain("positive");
  });
});

// --- 14.4 PowerShell -------------------------------------------------------
// PowerShellTool now lives in src/tools/core/powershell.ts (read-only detection
// + danger patterns + process-tree-kill); its read-only heuristic is covered in
// tools.test.ts. The execution path itself is exercised only on Windows.
