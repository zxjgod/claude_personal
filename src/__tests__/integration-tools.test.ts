// ============================================================
// Integration tests: breadth tools end-to-end (M21.1)
// ============================================================
// The unit suite (tools-m9.test.ts) checks each tool in isolation. This suite
// drives MULTI-STEP, real-resource flows the way the agent loop would:
//   - Worktree: enter → mutate → commit inside the worktree → exit keep/remove,
//     proving real git isolation (the main tree never sees the worktree's
//     commits) and that the per-session stack pops in LIFO order.
//   - Skill: register a catalog, resolve + expand prompts with args, and verify
//     the unknown-skill path lists the live catalog.
//   - Cron/Sleep: register several jobs, list/get/remove them, and confirm
//     Sleep enqueues a one-shot job the scheduler can later fire.
//
// Every git-dependent test no-ops when git is unavailable (CI images all have
// it, but local Windows boxes may not), mirroring tools-m9.test.ts.
// ============================================================

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSkills, registerSkill, resetSkills } from "../skills.js";
import {
  EnterWorktreeTool,
  ExitWorktreeTool,
  getScheduledJob,
  listScheduledJobs,
  removeScheduledJob,
  resetScheduledJobs,
  resetWorktrees,
  ScheduleCronTool,
  SkillTool,
  SleepTool,
} from "../tools/m8/m9.js";
import type { ToolContext } from "../types.js";

const SESSION = "sess-int-m21";

let repo: string;
let hasGit = true;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: overrides.workspaceRoot ?? repo,
    sessionId: overrides.sessionId ?? SESSION,
    permissionMode: "default",
    ...overrides,
  };
}

/** Absolute path of a worktree created under the repo's .claude/worktrees/. */
function wtPath(branch: string): string {
  return path.join(repo, ".claude", "worktrees", branch);
}

beforeEach(() => {
  resetWorktrees(SESSION);
  resetScheduledJobs();
  resetSkills();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-int-tools-"));
  try {
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.io"], repo);
    git(["config", "user.name", "Tester"], repo);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", "."], repo);
    git(["commit", "-m", "init"], repo);
  } catch {
    hasGit = false;
  }
});

afterEach(() => {
  resetWorktrees(SESSION);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ============================================================
// Worktree — full real-git lifecycle + isolation
// ============================================================

describe("Worktree lifecycle (real git)", () => {
  it("creates a worktree checked out on its own new branch", async () => {
    if (!hasGit) return;
    const r = await EnterWorktreeTool.call({ name: "feat-a", baseRef: "head" }, ctx());
    expect(r.error).toBeUndefined();
    const dir = wtPath("feat-a");
    expect(fs.existsSync(dir)).toBe(true);
    // The worktree's HEAD is the new branch, not main.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], dir).trim()).toBe("feat-a");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo).trim()).toBe("main");
  });

  it("isolates commits: a commit inside the worktree does not move main", async () => {
    if (!hasGit) return;
    await EnterWorktreeTool.call({ name: "feat-iso", baseRef: "head" }, ctx());
    const dir = wtPath("feat-iso");
    const mainHeadBefore = git(["rev-parse", "main"], repo).trim();

    fs.writeFileSync(path.join(dir, "only-in-worktree.txt"), "wt\n");
    git(["add", "."], dir);
    git(["commit", "-m", "work in worktree"], dir);

    // main is untouched; the branch advanced past it.
    expect(git(["rev-parse", "main"], repo).trim()).toBe(mainHeadBefore);
    expect(git(["rev-parse", "feat-iso"], repo).trim()).not.toBe(mainHeadBefore);
    // The new file exists only in the worktree, never in the main checkout.
    expect(fs.existsSync(path.join(dir, "only-in-worktree.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "only-in-worktree.txt"))).toBe(false);
  });

  it("keeps the worktree + branch on disk when exited with action=keep", async () => {
    if (!hasGit) return;
    await EnterWorktreeTool.call({ name: "feat-keep", baseRef: "head" }, ctx());
    const dir = wtPath("feat-keep");
    const r = await ExitWorktreeTool.call({ action: "keep" }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("Kept on disk");
    expect(fs.existsSync(dir)).toBe(true);
    // Branch still resolvable after keep.
    expect(() => git(["rev-parse", "feat-keep"], repo)).not.toThrow();
  });

  it("removes a clean worktree + its branch when exited with action=remove", async () => {
    if (!hasGit) return;
    await EnterWorktreeTool.call({ name: "feat-rm", baseRef: "head" }, ctx());
    const dir = wtPath("feat-rm");
    // Commit so the worktree is clean (no uncommitted changes to block removal).
    fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
    git(["add", "."], dir);
    git(["commit", "-m", "c"], dir);

    const r = await ExitWorktreeTool.call({ action: "remove", discardChanges: true }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("deleted");
    expect(fs.existsSync(dir)).toBe(false);
    // Branch was force-deleted too.
    expect(() => git(["rev-parse", "--verify", "feat-rm"], repo)).toThrow();
  });

  it("refuses remove with uncommitted changes, then honors discardChanges", async () => {
    if (!hasGit) return;
    await EnterWorktreeTool.call({ name: "feat-dirty", baseRef: "head" }, ctx());
    const dir = wtPath("feat-dirty");
    fs.writeFileSync(path.join(dir, "base.txt"), "modified\n");

    const refused = await ExitWorktreeTool.call({ action: "remove" }, ctx());
    expect(refused.error).toContain("uncommitted changes");
    expect(fs.existsSync(dir)).toBe(true);

    const forced = await ExitWorktreeTool.call({ action: "remove", discardChanges: true }, ctx());
    expect(forced.error).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("stacks nested worktrees and pops them LIFO on exit", async () => {
    if (!hasGit) return;
    await EnterWorktreeTool.call({ name: "layer-1", baseRef: "head" }, ctx());
    await EnterWorktreeTool.call({ name: "layer-2", baseRef: "head" }, ctx());
    expect(fs.existsSync(wtPath("layer-1"))).toBe(true);
    expect(fs.existsSync(wtPath("layer-2"))).toBe(true);

    // First exit pops the top of the stack (layer-2).
    const first = await ExitWorktreeTool.call({ action: "remove", discardChanges: true }, ctx());
    expect(first.content).toContain("layer-2");
    expect(fs.existsSync(wtPath("layer-2"))).toBe(false);
    expect(fs.existsSync(wtPath("layer-1"))).toBe(true);

    // Second exit pops layer-1.
    const second = await ExitWorktreeTool.call({ action: "remove", discardChanges: true }, ctx());
    expect(second.content).toContain("layer-1");
    expect(fs.existsSync(wtPath("layer-1"))).toBe(false);

    // Stack is now empty.
    const empty = await ExitWorktreeTool.call({ action: "keep" }, ctx());
    expect(empty.content).toContain("No active worktree");
  });

  it("fails to create two worktrees with the same branch name", async () => {
    if (!hasGit) return;
    const ok = await EnterWorktreeTool.call({ name: "dup", baseRef: "head" }, ctx());
    expect(ok.error).toBeUndefined();
    const dupe = await EnterWorktreeTool.call({ name: "dup", baseRef: "head" }, ctx());
    expect(dupe.error).toContain("failed");
  });

  it("sanitizes unsafe characters in the branch name", async () => {
    if (!hasGit) return;
    const r = await EnterWorktreeTool.call(
      { name: "weird name/with:chars", baseRef: "head" },
      ctx(),
    );
    expect(r.error).toBeUndefined();
    // All non [A-Za-z0-9._-] become '-'.
    expect(r.content).toContain("weird-name-with-chars");
    expect(fs.existsSync(wtPath("weird-name-with-chars"))).toBe(true);
  });

  it("baseRef=fresh with no origin falls back to HEAD and still creates", async () => {
    if (!hasGit) return;
    const r = await EnterWorktreeTool.call({ name: "fresh-fallback", baseRef: "fresh" }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("(from fresh)");
    expect(fs.existsSync(wtPath("fresh-fallback"))).toBe(true);
  });

  it("isolates worktree stacks across sessions", async () => {
    if (!hasGit) return;
    await EnterWorktreeTool.call({ name: "sess-x-wt", baseRef: "head" }, ctx({ sessionId: "sx" }));
    // A different session has no active worktree of its own.
    const other = await ExitWorktreeTool.call({ action: "keep" }, ctx({ sessionId: "sy" }));
    expect(other.content).toContain("No active worktree");
    // Clean up the sx stack so afterEach's reset of SESSION doesn't leak it.
    await ExitWorktreeTool.call(
      { action: "remove", discardChanges: true },
      ctx({ sessionId: "sx" }),
    );
    resetWorktrees("sx");
    resetWorktrees("sy");
  });

  it("errors clearly when the workspace is not a git repository", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plain-"));
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

// ============================================================
// Skill — register, resolve, expand
// ============================================================

describe("Skill resolution flow", () => {
  it("expands a registered skill's prompt and appends args", async () => {
    registerSkill({ name: "do-thing", description: "does a thing", prompt: "Perform THE thing." });
    const r = await SkillTool.call({ skill: "do-thing", args: "target=foo" }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("do-thing");
    expect(r.content).toContain("Perform THE thing.");
    expect(r.content).toContain("Arguments: target=foo");
  });

  it("omits the Arguments line when no args are given", async () => {
    registerSkill({ name: "no-args", description: "d", prompt: "Body." });
    const r = await SkillTool.call({ skill: "no-args" }, ctx());
    expect(r.content).toContain("Body.");
    expect(r.content).not.toContain("Arguments:");
  });

  it("lists the live catalog when the skill name is unknown", async () => {
    registerSkill({ name: "alpha", description: "first", prompt: "p" });
    registerSkill({ name: "beta", description: "second", prompt: "p" });
    const r = await SkillTool.call({ skill: "ghost" }, ctx());
    expect(r.error).toContain('Unknown skill "ghost"');
    expect(r.error).toContain("alpha");
    expect(r.error).toContain("beta");
    // The catalog the tool lists includes our two registered skills (alongside
    // the re-seeded built-ins that registerSkill restores via ensureSeeded).
    const names = listSkills().map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  it("registering the same name overrides the prior prompt", async () => {
    registerSkill({ name: "ov", description: "v1", prompt: "old" });
    registerSkill({ name: "ov", description: "v2", prompt: "new prompt" });
    const r = await SkillTool.call({ skill: "ov" }, ctx());
    expect(r.content).toContain("new prompt");
    expect(r.content).not.toContain("old");
  });

  it("rejects an empty skill name", async () => {
    const r = await SkillTool.call({ skill: "   " }, ctx());
    expect(r.error).toContain("required");
  });
});

// ============================================================
// Cron / Sleep — registry lifecycle
// ============================================================

describe("Scheduling flow", () => {
  it("registers multiple jobs and exposes them via list/get", async () => {
    await ScheduleCronTool.call({ cron: "*/5 * * * *", prompt: "five" }, ctx());
    await ScheduleCronTool.call({ cron: "0 9 * * 1-5", prompt: "weekday nine" }, ctx());
    const jobs = listScheduledJobs();
    expect(jobs).toHaveLength(2);
    const byId = getScheduledJob(jobs[0]!.id);
    expect(byId).toBeDefined();
    expect(jobs.map((j) => j.prompt).sort()).toEqual(["five", "weekday nine"]);
  });

  it("removes a job by id and reports whether it existed", async () => {
    await ScheduleCronTool.call({ cron: "*/5 * * * *", prompt: "x" }, ctx());
    const id = listScheduledJobs()[0]!.id;
    expect(removeScheduledJob(id)).toBe(true);
    expect(listScheduledJobs()).toHaveLength(0);
    // Removing again is a no-op false.
    expect(removeScheduledJob(id)).toBe(false);
  });

  it("persists recurring + durable flags on the registered job", async () => {
    await ScheduleCronTool.call(
      { cron: "30 14 28 2 *", prompt: "one shot", recurring: false, durable: true },
      ctx(),
    );
    const job = listScheduledJobs()[0]!;
    expect(job.recurring).toBe(false);
    expect(job.durable).toBe(true);
    expect(job.cron).toBe("30 14 28 2 *");
  });

  it("rejects an invalid cron and registers nothing", async () => {
    const r = await ScheduleCronTool.call({ cron: "99 * * * *", prompt: "bad" }, ctx());
    expect(r.error).toBeDefined();
    expect(listScheduledJobs()).toHaveLength(0);
  });

  it("Sleep enqueues a one-shot job the scheduler can fire", async () => {
    const r = await SleepTool.call(
      { delaySeconds: 200, reason: "let CI settle", prompt: "re-check CI" },
      ctx(),
    );
    expect(r.content).toContain("200s");
    const jobs = listScheduledJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.recurring).toBe(false);
    expect(jobs[0]!.cron).toBe("+200");
    expect(jobs[0]!.prompt).toBe("re-check CI");
  });

  it("Sleep without a prompt registers no job and clamps the delay", async () => {
    const r = await SleepTool.call({ delaySeconds: 5, reason: "brief" }, ctx());
    expect(r.content).toContain("60s"); // clamped up to the floor
    expect(listScheduledJobs()).toHaveLength(0);
  });
});

// ============================================================
// Cross-tool: independent registries don't interfere
// ============================================================

describe("Combined tool state", () => {
  it("worktree, skill, and cron state are independent within one session", async () => {
    if (!hasGit) return;
    registerSkill({ name: "combo", description: "d", prompt: "p" });
    await ScheduleCronTool.call({ cron: "*/9 * * * *", prompt: "tick" }, ctx());
    await EnterWorktreeTool.call({ name: "combo-wt", baseRef: "head" }, ctx());

    // Each subsystem reports only its own state.
    expect(listScheduledJobs()).toHaveLength(1);
    expect((await SkillTool.call({ skill: "combo" }, ctx())).error).toBeUndefined();
    expect(fs.existsSync(wtPath("combo-wt"))).toBe(true);

    // Resetting the worktree stack leaves the cron + skill registries intact.
    await ExitWorktreeTool.call({ action: "remove", discardChanges: true }, ctx());
    expect(listScheduledJobs()).toHaveLength(1);
    expect(listSkills().some((s) => s.name === "combo")).toBe(true);
  });
});
