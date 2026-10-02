import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finishIsolatedWorktree, removeIsolatedWorktree } from "../worktrees.js";

const fixture = vi.hoisted(() => ({ root: "", tree: "" }));
vi.mock("node:child_process", async (original) => {
  const module = await original<typeof import("node:child_process")>();
  const execute = vi.fn();
  Object.defineProperty(execute, promisify.custom, {
    value: async (_command: string, args: string[]) => {
      if (args.includes("--porcelain") && args.includes("list"))
        return {
          stdout: `worktree ${fixture.root}\0HEAD base\0branch refs/heads/main\0\0worktree ${fixture.tree}\0HEAD base\0branch refs/heads/codex/fixture\0\0`,
        };
      if (args[0] === "rev-parse") return { stdout: "base" };
      if (args[0] === "status") return { stdout: "" };
      if (args[0] === "rev-list") return { stdout: "0" };
      if (args[0] === "worktree" && args[1] === "remove") {
        fs.rmSync(fixture.tree, { recursive: true });
        return { stdout: "" };
      }
      if (args[0] === "branch") throw new Error("fixture branch cleanup failure");
      throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
    },
  });
  return { ...module, execFile: execute };
});
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-wt-partial-"));
  fixture.tree = path.join(fixture.root, "tree");
  fs.mkdirSync(fixture.tree);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});
const entry = () => ({
  path: fixture.tree,
  repository: fixture.root,
  branch: "codex/fixture",
  baseCommit: "base",
});
it("reports a retained branch after successful worktree removal", async () => {
  expect(await removeIsolatedWorktree(entry())).toContain("branch codex/fixture was retained");
  expect(fs.existsSync(fixture.tree)).toBe(false);
});
it("never reports a nonexistent worktree as retained when only branch cleanup failed", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await finishIsolatedWorktree(entry())).toBe(true);
  expect(fs.existsSync(fixture.tree)).toBe(false);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("was retained"));
});
