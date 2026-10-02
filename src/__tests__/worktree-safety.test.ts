import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { executeSingleTool } from "../tool-executor.js";
import { EnterWorktreeTool, ExitWorktreeTool } from "../tools/breadth/orchestration.js";
import { ReadTool } from "../tools/core/read.js";
import {
  createIsolatedWorktree,
  finishIsolatedWorktree,
  removeIsolatedWorktree,
  resetWorktrees,
  worktreeGit,
} from "../worktrees.js";

let root: string;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-wt-safe-"));
  await worktreeGit(["init"], root);
  await worktreeGit(["config", "user.name", "Fixture"], root);
  await worktreeGit(["config", "user.email", "fixture@example.invalid"], root);
  fs.writeFileSync(path.join(root, "a.txt"), "main");
  await worktreeGit(["add", "a.txt"], root);
  await worktreeGit(["commit", "-m", "base"], root);
});
afterEach(() => {
  resetWorktrees("safe-wt");
  fs.rmSync(root, { recursive: true, force: true });
});
it("keeps edits and independent commits while cleaning truly empty workers", async () => {
  const modified = await createIsolatedWorktree(root, "dirty");
  fs.writeFileSync(path.join(modified.path, "a.txt"), "worker result");
  expect(await finishIsolatedWorktree(modified)).toBe(false);
  expect(fs.readFileSync(path.join(modified.path, "a.txt"), "utf8")).toBe("worker result");
  await worktreeGit(["add", "a.txt"], modified.path);
  await worktreeGit(["commit", "-m", "worker result"], modified.path);
  await expect(removeIsolatedWorktree(modified)).rejects.toThrow("unmerged commits");
  expect(await finishIsolatedWorktree(modified)).toBe(false);
  const empty = await createIsolatedWorktree(root, "empty");
  expect(await finishIsolatedWorktree(empty)).toBe(true);
  expect(fs.existsSync(empty.path)).toBe(false);
});
it("routes file tools into the active tree, supports reopening it, and returns to main", async () => {
  const ctx = { workspaceRoot: root, sessionId: "safe-wt", permissionMode: "default" as const };
  const result = await EnterWorktreeTool.call({ name: "selected", baseRef: "head" }, ctx);
  const directory = result.metadata!.worktreePath!;
  fs.writeFileSync(path.join(directory, "a.txt"), "selected tree");
  const call = {
    id: "fixture",
    type: "function" as const,
    function: { name: "read", arguments: JSON.stringify({ filePath: "a.txt" }) },
  };
  expect((await executeSingleTool(call, [ReadTool], ctx, async () => false)).formatted).toContain(
    "selected tree",
  );
  fs.writeFileSync(path.join(directory, ".env"), "fixture only");
  const secretCall = {
    ...call,
    function: {
      name: "read",
      arguments: JSON.stringify({ filePath: path.join(directory, ".env") }),
    },
  };
  expect((await executeSingleTool(secretCall, [ReadTool], ctx, async () => false)).isError).toBe(
    true,
  );
  await ExitWorktreeTool.call({ action: "keep" }, ctx);
  expect((await executeSingleTool(call, [ReadTool], ctx, async () => false)).formatted).toContain(
    "main",
  );
  expect((await EnterWorktreeTool.call({ path: directory }, ctx)).error).toBeUndefined();
  expect((await ExitWorktreeTool.call({ action: "remove" }, ctx)).error).toContain(
    "uncommitted changes",
  );
});
