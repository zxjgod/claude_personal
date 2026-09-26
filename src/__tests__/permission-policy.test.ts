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

  it("matches official-style capitalized rules against lowercase tool names (既有 A)", () => {
    // Registry tool names are lowercase; official rules are capitalized. The
    // old strict === made every official-style project rule a silent no-op —
    // with the A3 trust gate shipping, that meant trusted allow-rules (and
    // worse, deny rules) doing nothing.
    expect(permissionRuleMatches("Bash(rm *)", "bash", { command: "rm -rf x" })).toBe(true);
    expect(permissionRuleMatches("Edit", "edit", { filePath: "a.ts" })).toBe(true);
    expect(permissionRuleMatches("bash(git *)", "Bash", { command: "git status" })).toBe(true);
    expect(permissionRuleMatches("Bash(git *)", "bash", { command: "rm x" })).toBe(false);
    expect(permissionRuleMatches("*", "anything", {})).toBe(true);
  });

  it("supports the official colon-prefix form at a word boundary (既有 A)", () => {
    expect(permissionRuleMatches("Bash(npm run:*)", "bash", { command: "npm run build" })).toBe(
      true,
    );
    expect(permissionRuleMatches("Bash(npm run:*)", "bash", { command: "npm run" })).toBe(true);
    // A command merely sharing the string prefix is NOT covered.
    expect(permissionRuleMatches("Bash(npm run:*)", "bash", { command: "npm runx" })).toBe(false);
    expect(permissionRuleMatches("Bash(git:*)", "bash", { command: "git status" })).toBe(true);
    expect(permissionRuleMatches("Bash(git:*)", "bash", { command: "github-cli x" })).toBe(false);
  });

  it("persists always-allow values", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccr-perm-")), "permissions.json");
    process.env.CCR_PERMISSION_STORE = file;
    savePersistentAlwaysAllow(new Set(["bash::git status"]));
    expect(loadPersistentAlwaysAllow()).toEqual(new Set(["bash::git status"]));
  });
});
