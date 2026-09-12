import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runWindowsSandbox } from "../native-sandbox.js";
import { loadSandboxPolicy, requiresNativeSandbox, sandboxViolation } from "../sandbox-policy.js";

describe("sandbox policy", () => {
  it("loads workspace policy and detects violations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sandbox-"));
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", "sandbox.json"),
      JSON.stringify({ enabled: true, native: true, network: "deny", deniedCommands: ["format"] }),
    );
    const policy = loadSandboxPolicy(root);
    expect(requiresNativeSandbox(policy)).toBe(true);
    expect(sandboxViolation(policy, "curl example.com", root)).toContain("network");
    expect(sandboxViolation(policy, "format disk", root)).toContain("command");
  });

  it("defaults unspecified network policy to deny", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sandbox-default-"));
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "sandbox.json"), JSON.stringify({ enabled: true }));
    expect(sandboxViolation(loadSandboxPolicy(root), "curl example.com", root)).toContain(
      "network",
    );
  });

  it("fails closed on unsupported platforms", async () => {
    if (process.platform === "win32") return;
    const result = await runWindowsSandbox({
      command: "echo ok",
      cwd: process.cwd(),
      timeoutMs: 1000,
    });
    expect(result.code).toBeNull();
    expect(result.stderr).toContain("unsupported");
  });
});
