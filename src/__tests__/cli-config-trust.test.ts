// ============================================================
// Tests: project allow-rule trust gate (Top10 follow-up A3)
// + hook env sanitization (A4) + audit redaction (A8)
// ============================================================

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redactSecrets } from "../audit-log.js";
import { confirmProjectAllowRules, getPermissionPolicy } from "../cli-config.js";
import { sanitizeChildEnv, strippedSecretNames } from "../utils/env-sanitize.js";

// ============================================================
// A3: project settings permissions.allow trust gate
// ============================================================

let root: string;
let storePath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-allowgate-"));
  storePath = path.join(root, "outside", "trust-store.json");
  vi.stubEnv("CCR_TRUST_STORE_SETTINGS", storePath);
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeSettings(permissions: unknown): void {
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({ permissions }),
    "utf-8",
  );
}

function trustFingerprint(allow: string[]): void {
  const fp = crypto
    .createHash("sha256")
    .update(JSON.stringify([...allow].sort()))
    .digest("hex");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify({ [path.resolve(root, ".claude", "settings.json")]: fp }),
    "utf-8",
  );
}

describe("project allow-rule trust gate (A3)", () => {
  it("strips untrusted project allow rules but keeps deny/ask", () => {
    writeSettings({ allow: ["Bash(npm run:*)"], deny: ["Bash(rm:*)"], ask: ["write"] });
    const policy = getPermissionPolicy(root);
    expect(policy.allow).not.toContain("Bash(npm run:*)");
    expect(policy.deny).toContain("Bash(rm:*)");
    expect(policy.ask).toContain("write");
  });

  it("a cloned allow:['*'] cannot erode prompts while untrusted", () => {
    writeSettings({ allow: ["*"] });
    const policy = getPermissionPolicy(root);
    expect(policy.allow).not.toContain("*");
  });

  it("non-TTY confirmation degrades to warn + stay-untrusted (fail-closed)", async () => {
    writeSettings({ allow: ["Bash(npm run:*)"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await confirmProjectAllowRules(root);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(getPermissionPolicy(root).allow).not.toContain("Bash(npm run:*)");
  });

  it("includes allow rules once the fingerprint is trusted", () => {
    writeSettings({ allow: ["Bash(npm run:*)"] });
    trustFingerprint(["Bash(npm run:*)"]);
    expect(getPermissionPolicy(root).allow).toContain("Bash(npm run:*)");
  });

  it("editing the rules changes the fingerprint → untrusted again", () => {
    writeSettings({ allow: ["Bash(npm run:*)"] });
    trustFingerprint(["Bash(npm run:*)"]);
    // The repo silently adds a wildcard afterwards:
    writeSettings({ allow: ["Bash(npm run:*)", "*"] });
    const policy = getPermissionPolicy(root);
    expect(policy.allow).not.toContain("*");
    expect(policy.allow).not.toContain("Bash(npm run:*)");
  });

  it("projects without allow rules are untouched (no gating noise)", () => {
    writeSettings({ deny: ["Bash(rm:*)"] });
    expect(getPermissionPolicy(root).deny).toContain("Bash(rm:*)");
  });

  it("no HOME at all disables the store — allow stays fail-closed, never lands in the repo (fourth round)", async () => {
    // Same rule as the audit log (A8): the "." fallback would put the trust
    // store INSIDE the (possibly cloned) working tree. Without a usable
    // store path every read/write throws → untrusted → allow rules inert.
    vi.stubEnv("CCR_TRUST_STORE_SETTINGS", "");
    vi.stubEnv("HOME", "");
    vi.stubEnv("USERPROFILE", "");
    writeSettings({ allow: ["Bash(npm run:*)"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await confirmProjectAllowRules(root);
    } finally {
      warn.mockRestore();
    }
    expect(getPermissionPolicy(root).allow).not.toContain("Bash(npm run:*)");
    // And nothing was written into the working tree.
    expect(fs.existsSync(path.join(root, ".claude-code-replica"))).toBe(false);
  });
});

// ============================================================
// A4: hook/child env sanitization
// ============================================================

describe("sanitizeChildEnv (A4)", () => {
  const env = {
    PATH: "/bin",
    HOME: "/h",
    COMSPEC: "cmd.exe",
    CCR_SPECULATION: "1",
    CLAUDE_PROJECT_DIR: "/proj",
    LLM_API_KEY: "sk-secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GITHUB_TOKEN: "ghp_xxxxxxxxxxxxxxxxxxxx",
    MY_SECRET: "s3cr3t",
    DB_PASSWORD: "hunter2",
    AWS_SECRET_ACCESS_KEY: "awskey",
    SOME_CREDENTIAL: "cred",
  };

  it("keeps plumbing variables", () => {
    const out = sanitizeChildEnv(env);
    expect(out.PATH).toBe("/bin");
    expect(out.HOME).toBe("/h");
    expect(out.CCR_SPECULATION).toBe("1");
  });

  it("strips every secret-shaped variable", () => {
    const out = sanitizeChildEnv(env);
    for (const key of [
      "LLM_API_KEY",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "MY_SECRET",
      "DB_PASSWORD",
      "AWS_SECRET_ACCESS_KEY",
      "SOME_CREDENTIAL",
    ]) {
      expect(out[key], key).toBeUndefined();
    }
    expect(strippedSecretNames(env).length).toBe(7);
  });

  it("strips access-key and bare _KEY/_PAT suffix shapes (fourth round)", () => {
    const e: Record<string, string> = {
      AWS_ACCESS_KEY_ID: "AKIA123",
      OPENAI_KEY: "sk-x",
      STRIPE_KEY: "sk_live_x",
      GITHUB_PAT: "ghp_x",
      PRIVATE_KEY: "-----BEGIN",
      // Plain words containing key/pat without the separator-anchored suffix:
      MONKEY: "1",
      KEYMAP: "us",
      PATTERN: "factory",
      HOTKEYS: "f5",
    };
    const out = sanitizeChildEnv(e);
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "OPENAI_KEY",
      "STRIPE_KEY",
      "GITHUB_PAT",
      "PRIVATE_KEY",
    ]) {
      expect(out[key], key).toBeUndefined();
    }
    for (const key of ["MONKEY", "KEYMAP", "PATTERN", "HOTKEYS"]) {
      expect(out[key], key).toBe(e[key]);
    }
  });
});

// ============================================================
// A8: audit-log secret redaction
// ============================================================

describe("redactSecrets (A8)", () => {
  it("scrubs key-shaped secrets from commands", () => {
    expect(redactSecrets("curl -H 'Authorization: Bearer sk-abcdefgh12345678' x")).toContain(
      "Bearer <redacted>",
    );
    expect(redactSecrets("export API_KEY=abc123secret")).toContain("<redacted>");
    expect(redactSecrets("export API_KEY=abc123secret")).not.toContain("abc123secret");
    expect(redactSecrets("gh auth login --with-token <<< ghp_0123456789abcdefghij")).toContain(
      "<redacted-github-token>",
    );
    expect(redactSecrets("aws key AKIA0123456789ABCDEF")).toContain("<redacted-aws-key>");
  });

  it("leaves ordinary commands untouched", () => {
    const cmd = "npm test && git push origin main";
    expect(redactSecrets(cmd)).toBe(cmd);
  });

  it("scrubs Basic auth and curl -u credentials (fourth round)", () => {
    expect(redactSecrets("curl -H 'Authorization: Basic dXNlcjpwYXNz' x")).toContain(
      "Basic <redacted>",
    );
    expect(redactSecrets("curl -H 'Authorization: Basic dXNlcjpwYXNz' x")).not.toContain(
      "dXNlcjpwYXNz",
    );
    const u = redactSecrets("curl -u admin:hunter2 https://x");
    expect(u).toContain("-u <redacted>");
    expect(u).not.toContain("hunter2");
  });
});
