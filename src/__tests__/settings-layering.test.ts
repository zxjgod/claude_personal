// ============================================================
// Tests: settings layering for the toggle commands (#memory / #subagents)
// ============================================================
// Three defects these lock down:
//   1. The memory-approval gate read ONE install-dependent file, so on a global
//      install a checked-in project's `memory.requireApproval: true` was
//      ignored (the gate stayed off). The read is now an OR over the layers,
//      so a repo can only TIGHTEN it — never switch off a user's `true`.
//   2. Persisting a toggle over a CORRUPT settings.json rewrote the file from
//      the `{}` the lenient reader returns, silently deleting every other key
//      (permissions.deny, hooks, …). Both persists now refuse.
//   3. Toggles were written to the install-level default while a project/local
//      layer already owned the key — and startup merges user < project < local,
//      so the next session silently reverted the change. The write now targets
//      the layer that owns the key.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initMemoryApproval,
  isMemoryApprovalRequired,
  persistMemoryApproval,
  setMemoryApproval,
} from "../memory-approval.js";
import { readSettings } from "../settings.js";
import { settingsWriteTarget } from "../settings-target.js";
import {
  getSubagentSettings,
  initSubagentSettings,
  persistSubagentSettings,
  setSubagentSettings,
} from "../subagent-settings.js";

let workspace: string;
let userDir: string;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf-8");
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
}

const projectSettings = (): string => path.join(workspace, ".claude", "settings.json");
const userSettings = (): string => path.join(userDir, "settings.json");

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "settings-layer-ws-"));
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-layer-user-"));
  // A tmp workspace puts the package root outside it → the global-install
  // branch, i.e. the default write target is the user settings file.
  vi.stubEnv("CCR_USER_CONFIG_DIR", userDir);
  delete process.env.CCR_MANAGED_SETTINGS;
  setMemoryApproval(false);
  setSubagentSettings({ thinking: false, sidechainMode: "audit" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.CCR_MANAGED_SETTINGS;
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
});

describe("memory-approval — layered, tighten-only read", () => {
  it("a project layer that requires approval tightens the gate on a global install", () => {
    writeJson(projectSettings(), { memory: { requireApproval: true } });
    initMemoryApproval(workspace);
    expect(isMemoryApprovalRequired()).toBe(true);
  });

  it("a project layer cannot switch OFF a user's true (tighten-only)", () => {
    writeJson(userSettings(), { memory: { requireApproval: true } });
    writeJson(projectSettings(), { memory: { requireApproval: false } });
    initMemoryApproval(workspace);
    expect(isMemoryApprovalRequired()).toBe(true);
  });

  it("managed settings keep winning after /memory-approval off", () => {
    const managed = path.join(workspace, "managed.json");
    writeJson(managed, { memory: { requireApproval: true } });
    process.env.CCR_MANAGED_SETTINGS = managed;
    initMemoryApproval(workspace);
    expect(isMemoryApprovalRequired()).toBe(true);
    persistMemoryApproval(false, workspace);
    expect(isMemoryApprovalRequired()).toBe(true);
  });

  it("refuses to rewrite a corrupt target settings file (other keys must survive)", () => {
    // A target file truncated by an interrupted write must NOT be rebuilt from
    // the lenient reader's `{}` — that deleted permissions.deny, hooks and
    // every other setting it held, while reporting success.
    fs.writeFileSync(userSettings(), '{ "permissions": ', "utf-8");
    expect(() => persistMemoryApproval(true, workspace)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(userSettings(), "utf-8")).toBe('{ "permissions": ');
    expect(isMemoryApprovalRequired()).toBe(false);
  });

  it("a corrupt project file is left alone when it does not own the key", () => {
    fs.mkdirSync(path.dirname(projectSettings()), { recursive: true });
    fs.writeFileSync(projectSettings(), '{ "permissions": ', "utf-8");
    persistMemoryApproval(true, workspace);
    expect(isMemoryApprovalRequired()).toBe(true);
    expect(fs.readFileSync(projectSettings(), "utf-8")).toBe('{ "permissions": ');
    expect(readJson(userSettings()).memory.requireApproval).toBe(true);
  });
});

describe("settingsWriteTarget — write where the value is read from", () => {
  it("falls back to the install-level default when no layer owns the key", () => {
    expect(settingsWriteTarget(workspace, "subagents").file).toBe(userSettings());
  });

  it("targets the project layer that already owns the key", () => {
    writeJson(projectSettings(), { subagents: { thinking: true } });
    expect(settingsWriteTarget(workspace, "subagents").file).toBe(projectSettings());
  });

  it("prefers the local layer over the project layer", () => {
    writeJson(projectSettings(), { subagents: { thinking: true } });
    writeJson(path.join(workspace, ".claude", "settings.local.json"), { subagents: {} });
    expect(settingsWriteTarget(workspace, "subagents").file).toBe(
      path.join(workspace, ".claude", "settings.local.json"),
    );
  });

  it("a toggle written to the owning layer survives the next startup read", () => {
    // Regression: writing the user file while the project layer owned the key
    // printed "persisted" and then reverted on the next session.
    writeJson(projectSettings(), { subagents: { thinking: true } });
    persistSubagentSettings(workspace, { thinking: false });
    expect(readJson(projectSettings()).subagents.thinking).toBe(false);
    initSubagentSettings(readSettings(workspace));
    expect(getSubagentSettings().thinking).toBe(false);
  });

  it("persists to the install default and preserves unrelated keys", () => {
    writeJson(userSettings(), { theme: "dark" });
    persistSubagentSettings(workspace, { sidechainMode: "report" });
    expect(readJson(userSettings())).toMatchObject({
      theme: "dark",
      subagents: { sidechainMode: "report" },
    });
  });
});
