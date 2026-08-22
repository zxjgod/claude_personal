// ============================================================
// Config-driven hooks — load `.claude/settings.json` hooks (kernel §8)
// ============================================================
// Real Claude Code hooks are shell commands declared in `.claude/settings.json`
// and run with a JSON payload on stdin; their stdout JSON decides whether a
// tool call proceeds. This module bridges that config format onto the in-memory
// HookRegistry: it reads the settings, validates the `hooks` block, and builds
// a Hook per phase whose pre/post/stop spawns the configured command.
//
// Config shape:
//
//   { "hooks": {
//       "PreToolUse":  [ { "matcher": "Edit|Write", "hooks": [
//                          { "type": "command", "command": "hook-script", "timeout": 60 }
//                        ] } ],
//       "PostToolUse": [ … ],
//       "Stop":        [ … ]
//   } }
//
// Protocol (stdin JSON → stdout JSON):
//   PreToolUse  stdin  { tool_name, tool_input }          → { decision: "block"|"allow", reason }
//   PostToolUse stdin  { tool_name, tool_input, tool_response } → { decision: "block"|"continue", reason }
//   Stop        stdin  { stop_hook_active }               → { decision: "block", reason }
//
// Fail-safe: a hook that errors, times out, or emits non-JSON is treated as a
// no-op (allow / continue). A broken hook never blocks the user's work.
// ============================================================

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Hook, HookRegistry } from "./hooks.js";

export interface HookCommandSpec {
  type: "command";
  command: string;
  /** Per-command timeout in seconds (default 60). */
  timeout?: number;
}

export interface HookConfigEntry {
  matcher: string;
  hooks: HookCommandSpec[];
}

export interface HooksConfig {
  PreToolUse?: HookConfigEntry[];
  PostToolUse?: HookConfigEntry[];
  Stop?: HookConfigEntry[];
}

const PHASES = ["PreToolUse", "PostToolUse", "Stop"] as const;

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 100_000;

// ============================================================
// Settings loading
// ============================================================

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the merged project settings: `.claude/settings.json` overlaid by
 * `.claude/settings.local.json` (local wins on a per-key basis). Returns null
 * when neither file exists or is parseable.
 */
export function readSettings(workspaceRoot: string): Record<string, unknown> | null {
  const base = readJsonFile(path.join(workspaceRoot, ".claude", "settings.json")) ?? {};
  const local = readJsonFile(path.join(workspaceRoot, ".claude", "settings.local.json"));
  return local ? { ...base, ...local } : base;
}

/** Parse the `hooks` block out of a settings object, dropping malformed entries. */
export function parseHooksConfig(
  settings: Record<string, unknown> | null | undefined,
): HooksConfig {
  const config: HooksConfig = {};
  if (!settings) return config;
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null) return config;
  for (const phase of PHASES) {
    const raw = (hooks as Record<string, unknown>)[phase];
    if (!Array.isArray(raw)) continue;
    const entries: HookConfigEntry[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const { matcher, hooks: specs } = entry as Record<string, unknown>;
      if (typeof matcher !== "string" || !matcher || !Array.isArray(specs)) continue;
      const commands: HookCommandSpec[] = [];
      for (const spec of specs) {
        if (typeof spec !== "object" || spec === null) continue;
        const s = spec as Record<string, unknown>;
        if (s.type !== "command" || typeof s.command !== "string" || !s.command) continue;
        commands.push({
          type: "command",
          command: s.command,
          timeout: typeof s.timeout === "number" && s.timeout > 0 ? s.timeout : undefined,
        });
      }
      if (commands.length > 0) entries.push({ matcher, hooks: commands });
    }
    if (entries.length > 0) config[phase] = entries;
  }
  return config;
}

// ============================================================
// Command execution
// ============================================================

function parseJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one hook command with a JSON payload on stdin, returning its parsed
 * stdout JSON. Never rejects: any error/timeout/non-JSON resolves to `{}`
 * (a no-op). `decision` is the only field the callers interpret.
 */
function runCommandHook(
  command: string,
  stdin: Record<string, unknown>,
  cwd: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    // `shell: true` lets the platform shell (sh on Unix, cmd.exe on Windows)
    // handle quoting, which avoids cmd's well-known `/c` quote-stripping bug
    // when a command embeds a quoted path (e.g. `node "C:\Program Files\…"`).
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const killTree = (): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).unref();
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // Process may already be gone.
      }
    };
    let stdout = "";
    let settled = false;
    const finish = (value: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killTree();
      finish({});
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length >= MAX_STDOUT_BYTES) return;
      const text = chunk.toString();
      const remaining = MAX_STDOUT_BYTES - stdout.length;
      stdout += text.slice(0, remaining);
      if (text.length > remaining) {
        killTree();
        finish({});
      }
    });
    child.on("error", () => finish({}));
    child.on("close", () => finish(parseJson(stdout) ?? {}));

    child.stdin.on("error", () => finish({}));
    child.stdin.write(JSON.stringify(stdin));
    child.stdin.end();
  });
}

/** Run a list of command specs in order; the first `block` decision wins. */
async function runSpecs(
  specs: HookCommandSpec[],
  stdin: Record<string, unknown>,
  cwd: string,
): Promise<Record<string, unknown>> {
  for (const spec of specs) {
    const out = await runCommandHook(
      spec.command,
      stdin,
      cwd,
      (spec.timeout ?? DEFAULT_HOOK_TIMEOUT_MS / 1000) * 1000,
    );
    if (out.decision === "block") return out;
  }
  return {};
}

// ============================================================
// Hook construction
// ============================================================

function buildPhaseHook(phase: (typeof PHASES)[number], entry: HookConfigEntry): Hook {
  const cwd = process.cwd();
  switch (phase) {
    case "PreToolUse":
      return {
        matcher: entry.matcher,
        pre: async ({ toolName, input }) => {
          const out = await runSpecs(entry.hooks, { tool_name: toolName, tool_input: input }, cwd);
          if (out.decision === "block") {
            return { block: true, reason: (out.reason as string) || "blocked by PreToolUse hook" };
          }
          return {};
        },
      };
    case "PostToolUse":
      return {
        matcher: entry.matcher,
        post: async ({ toolName, input, result }) => {
          const out = await runSpecs(
            entry.hooks,
            { tool_name: toolName, tool_input: input, tool_response: result },
            cwd,
          );
          if (out.decision === "block") {
            return {
              result: {
                content: "",
                error: (out.reason as string) || "blocked by PostToolUse hook",
              },
            };
          }
          return {};
        },
      };
    case "Stop":
      return {
        matcher: entry.matcher,
        stop: async ({ stopHookActive }) => {
          const out = await runSpecs(entry.hooks, { stop_hook_active: stopHookActive }, cwd);
          if (out.decision === "block") {
            return { blockingError: (out.reason as string) || "stop hook requested more work" };
          }
          return {};
        },
      };
  }
}

/**
 * Register every hook in a HooksConfig onto a HookRegistry. Returns the number
 * of hooks registered. Matching is done by the registry's own matcher logic
 * (a matcher may be a plain tool name, "*", or a regex such as "Edit|Write").
 */
export function registerHooksFromConfig(registry: HookRegistry, config: HooksConfig): number {
  let count = 0;
  for (const phase of PHASES) {
    for (const entry of config[phase] ?? []) {
      registry.register(buildPhaseHook(phase, entry));
      count++;
    }
  }
  return count;
}

/**
 * Load hooks from the project settings and register them. Convenience wrapper:
 * readSettings → parseHooksConfig → registerHooksFromConfig. Returns the count.
 *
 * LOW-LEVEL: this bypasses the trust gate. Interacting with a checked-out
 * repository should go through loadHooksFromSettingsTrusted instead — project
 * hooks execute arbitrary shell commands with the user's environment.
 */
export function loadHooksFromSettings(workspaceRoot: string, registry: HookRegistry): number {
  const settings = readSettings(workspaceRoot);
  const config = parseHooksConfig(settings);
  return registerHooksFromConfig(registry, config);
}

// --- Project-hook trust gate ------------------------------------------------
// Hooks declared by a checked-out repo run arbitrary shell commands inheriting
// the user's full environment (API keys included). Loading them unconditionally
// would make "clone a malicious repo and run the assistant" a supply-chain
// exploit, so a project's hooks must be explicitly trusted ONCE per
// (workspaceRoot, config-content) pair. Trust is keyed on a fingerprint of the
// hook commands, so editing the hook config invalidates prior approval.

function trustStorePath(): string {
  return (
    process.env.CCR_TRUST_STORE ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".claude-code-replica",
      "trusted-hooks.json",
    )
  );
}

/** Stable fingerprint over every (phase, matcher, command) in the config. */
export function hooksConfigFingerprint(config: HooksConfig): string {
  const flat: string[] = [];
  for (const phase of PHASES) {
    for (const entry of config[phase] ?? []) {
      for (const spec of entry.hooks) {
        flat.push([phase, entry.matcher, spec.command].join("\u001f"));
      }
    }
  }
  flat.sort();
  return crypto.createHash("sha256").update(flat.join("\n")).digest("hex");
}

/** Human-readable "Phase [matcher]: command" lines for the trust prompt. */
export function describeHooksConfig(config: HooksConfig): string[] {
  const lines: string[] = [];
  for (const phase of PHASES) {
    for (const entry of config[phase] ?? []) {
      for (const spec of entry.hooks) {
        lines.push(`${phase} [${entry.matcher}]: ${spec.command}`);
      }
    }
  }
  return lines;
}

export function isHooksConfigTrusted(workspaceRoot: string, fingerprint: string): boolean {
  try {
    const store = JSON.parse(fs.readFileSync(trustStorePath(), "utf-8")) as Record<string, string>;
    return store[workspaceRoot] === fingerprint;
  } catch {
    return false;
  }
}

export function trustHooksConfig(workspaceRoot: string, fingerprint: string): void {
  try {
    const file = trustStorePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let store: Record<string, string> = {};
    try {
      store = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>;
    } catch {
      // Missing or corrupt store — start fresh.
    }
    store[workspaceRoot] = fingerprint;
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
  } catch {
    // Trust persistence is best-effort; failing to save just re-prompts next time.
  }
}

export interface TrustedHooksResult {
  /** Hooks actually registered (0 when none configured or not trusted). */
  loaded: number;
  /** True when the project HAS hooks but they were not trusted/confirmed. */
  skippedUntrusted: boolean;
}

/**
 * Trust-gated variant of loadHooksFromSettings. Hooks are registered only when
 * the config fingerprint is already trusted, or the user confirms via the
 * `confirm` callback (pass null in non-interactive contexts → fail-closed).
 */
export async function loadHooksFromSettingsTrusted(
  workspaceRoot: string,
  registry: HookRegistry,
  confirm: ((descriptions: string[]) => Promise<boolean>) | null,
): Promise<TrustedHooksResult> {
  const settings = readSettings(workspaceRoot);
  const config = parseHooksConfig(settings);
  const descriptions = describeHooksConfig(config);
  if (descriptions.length === 0) return { loaded: 0, skippedUntrusted: false };

  const fingerprint = hooksConfigFingerprint(config);
  if (isHooksConfigTrusted(workspaceRoot, fingerprint)) {
    return { loaded: registerHooksFromConfig(registry, config), skippedUntrusted: false };
  }
  if (confirm && (await confirm(descriptions))) {
    trustHooksConfig(workspaceRoot, fingerprint);
    return { loaded: registerHooksFromConfig(registry, config), skippedUntrusted: false };
  }
  return { loaded: 0, skippedUntrusted: true };
}
