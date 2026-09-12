import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPersistentAlwaysAllow,
  permissionRuleMatches,
  savePersistentAlwaysAllow,
} from "../permission-policy.js";

describe("permission policy", () => {
  const old = process.env.CCR_PERMISSION_STORE;
  afterEach(() => {
    if (old === undefined) delete process.env.CCR_PERMISSION_STORE;
    else process.env.CCR_PERMISSION_STORE = old;
  });

  it("matches tool and command rules", () => {
    expect(permissionRuleMatches("Bash(git *)", "Bash", { command: "git status" })).toBe(true);
    expect(permissionRuleMatches("Read", "Read", { filePath: "x.ts" })).toBe(true);
    expect(permissionRuleMatches("Bash(git *)", "Bash", { command: "rm -rf x" })).toBe(false);
  });

  it("persists always-allow values", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccr-perm-")), "permissions.json");
    process.env.CCR_PERMISSION_STORE = file;
    savePersistentAlwaysAllow(new Set(["bash::git status"]));
    expect(loadPersistentAlwaysAllow()).toEqual(new Set(["bash::git status"]));
  });
});
