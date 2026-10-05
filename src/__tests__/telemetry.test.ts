// ============================================================
// Tests: local telemetry recorder (11.4)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTelemetryOptions, Telemetry } from "../telemetry.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-tel-"));
  delete process.env.CCR_TELEMETRY;
  delete process.env.LLM_TELEMETRY;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CCR_TELEMETRY;
  delete process.env.LLM_TELEMETRY;
});

describe("resolveTelemetryOptions", () => {
  it("is disabled by default", () => {
    expect(resolveTelemetryOptions(tmp).enabled).toBe(false);
  });

  it("enables via CCR_TELEMETRY=1", () => {
    process.env.CCR_TELEMETRY = "1";
    expect(resolveTelemetryOptions(tmp).enabled).toBe(true);
  });

  it("env=0 overrides settings.json enabled:true", () => {
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude", "settings.json"),
      JSON.stringify({ telemetry: { enabled: true } }),
    );
    process.env.CCR_TELEMETRY = "0";
    expect(resolveTelemetryOptions(tmp).enabled).toBe(false);
  });

  it("enables via settings.json when env unset", () => {
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude", "settings.json"),
      JSON.stringify({ telemetry: { enabled: true } }),
    );
    expect(resolveTelemetryOptions(tmp).enabled).toBe(true);
  });

  it("enables from the USER-level settings file, not just the project one", () => {
    // Regression: resolveTelemetryOptions read <workspace>/.claude/settings.json
    // directly, so for a global install the toggle the user wrote to the user
    // settings file (the install-level write target) was never read back —
    // recording stayed off no matter what the user configured.
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-tel-user-"));
    const previous = process.env.CCR_USER_CONFIG_DIR;
    try {
      process.env.CCR_USER_CONFIG_DIR = userDir;
      fs.writeFileSync(
        path.join(userDir, "settings.json"),
        JSON.stringify({ telemetry: { enabled: true } }),
      );
      expect(resolveTelemetryOptions(tmp).enabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CCR_USER_CONFIG_DIR;
      else process.env.CCR_USER_CONFIG_DIR = previous;
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });

  it("lets managed settings force recording OFF", () => {
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude", "settings.json"),
      JSON.stringify({ telemetry: { enabled: true } }),
    );
    const managed = path.join(tmp, "managed.json");
    fs.writeFileSync(managed, JSON.stringify({ telemetry: { enabled: false } }));
    const previous = process.env.CCR_MANAGED_SETTINGS;
    try {
      process.env.CCR_MANAGED_SETTINGS = managed;
      expect(resolveTelemetryOptions(tmp).enabled).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CCR_MANAGED_SETTINGS;
      else process.env.CCR_MANAGED_SETTINGS = previous;
    }
  });
});

describe("Telemetry recorder", () => {
  it("writes nothing when disabled", () => {
    const t = new Telemetry({ enabled: false, filePath: path.join(tmp, "e.jsonl") });
    t.record("session_start", { a: 1 });
    expect(fs.existsSync(path.join(tmp, "e.jsonl"))).toBe(false);
  });

  it("appends JSONL events when enabled", () => {
    const fp = path.join(tmp, "out", "e.jsonl");
    const t = new Telemetry({ enabled: true, filePath: fp });
    t.record("session_start", { provider: "deepseek" });
    t.record("turn", { inputTokens: 10, outputTokens: 5 });
    const lines = fs.readFileSync(fp, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.event).toBe("session_start");
    expect(first.props.provider).toBe("deepseek");
    expect(typeof first.ts).toBe("string");
  });

  it("never throws on a bad path", () => {
    // A path whose parent is a file, not a directory → mkdir fails silently.
    const filePath = path.join(tmp, "afile");
    fs.writeFileSync(filePath, "x");
    const t = new Telemetry({ enabled: true, filePath: path.join(filePath, "nested.jsonl") });
    expect(() => t.record("x")).not.toThrow();
  });

  it("fromWorkspace honors the env toggle", () => {
    process.env.CCR_TELEMETRY = "1";
    const t = Telemetry.fromWorkspace(tmp);
    expect(t.enabled).toBe(true);
  });
});
