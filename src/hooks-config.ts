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
// Protocol (stdin JSON → stdout JSON / exit code):
//   Every hook's stdin carries the official envelope — session_id,
//   transcript_path, cwd, hook_event_name — plus the event-specific fields.
//   PreToolUse  stdin  { …, tool_name, tool_input }              → { decision: "block", reason }
//   PostToolUse stdin  { …, tool_name, tool_input, tool_response } → { decision: "block", reason }
//   Stop        stdin  { …, stop_hook_active }                    → { decision: "block", reason }
//   Exit code 2 is the official no-JSON blocking path: stderr is the reason
//   fed back to the model (`echo reason >&2; exit 2`), taking precedence
//   over stdout JSON. CLAUDE_PROJECT_DIR is exported pointing at the
//   workspace root, and the command runs there (not the process startup cwd).
//
// Fail-safe: a hook that errors, times out, or emits non-JSON is treated as a
// no-op (allow / continue). A broken hook never blocks the user's work.
// ============================================================

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Hook, HookRegistry } from "./hooks.js";
import { readProjectSettings, readSettings } from "./settings.js";
import { sanitizeChildEnv } from "./utils/env-sanitize.js";
import { ccrPath } from "./workspace-config.js";

export interface HookCommandSpec {
  type: "command" | "http" | "prompt" | "agent" | "mcp_tool";
  command?: string;
  url?: string;
  prompt?: string;
  tool?: string;
  server?: string;
  headers?: Record<string, string>;
  input?: Record<string, unknown>;
  timeout?: number;
  async?: boolean;
}
export interface HookConfigEntry {
  matcher: string;
  hooks: HookCommandSpec[];
}
export type HooksConfig = Partial<Record<(typeof PHASES)[number], HookConfigEntry[]>>;
export interface HookServices {
  evaluate?(
    prompt: string,
    input: Record<string, unknown>,
    agent: boolean,
  ): Promise<Record<string, unknown>>;
  callMcpTool?(tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}
let services: HookServices = {};
export function configureHookServices(next: HookServices): void {
  services = next;
}

/**
 * Session context threaded into every spawned hook command: the official
 * stdin envelope (session_id / transcript_path / cwd) and the directory the
 * command runs in. Optional so programmatic registrations keep working.
 */
export interface HookRunContext {
  sessionId: string;
  workspaceRoot: string;
  transcriptRoot?: string;
}

const PHASES = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "UserPromptSubmit",
  "Notification",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "TeammateIdle",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUseFailure",
  "SubagentStart",
  "TaskCreated",
  "TaskCompleted",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "Elicitation",
  "ElicitationResult",
  "StopFailure",
] as const;

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 100_000;

// ============================================================
// Settings loading
// ============================================================

export { readSettings } from "./settings.js";

/**
 * Keys this replica ACTUALLY consumes — hooks/permissionMode/permissions/
 * telemetry/env/model are read by hooks-config, cli-config and
 * permission-policy. Keys the official client supports but we do NOT implement
 * (statusLine, apiKeyHelper, additionalDirectories, cleanupPeriodDays,
 * includeCoAuthoredBy, enableAllProjectMcpServers) must stay OUT of this set:
 * warnUnknownSettings exists precisely to tell users their setting won't take
 * effect, and whitelisting an unconsumed key reintroduces the silent no-op
 * the diagnostic was built to surface (a user-configured statusLine used to
 * be "known" yet do nothing, with no warning).
 */
const KNOWN_SETTINGS_KEYS = new Set([
  "hooks",
  "permissionMode",
  "permissions",
  "telemetry",
  "env",
  "model",
]);

/** Emit diagnostics for settings keys that this replica does not consume. */
export function warnUnknownSettings(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const unknown = Object.keys(settings).filter((key) => !KNOWN_SETTINGS_KEYS.has(key));
  for (const key of unknown) console.warn(`Warning: unsupported settings key ignored: ${key}`);
  return unknown;
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
      // Official semantics: an omitted (or empty) matcher means the hook
      // applies to ALL tools/events — dropping the entry used to silently
      // kill a matcher-less PreToolUse hook.
      const effectiveMatcher = typeof matcher === "string" && matcher ? matcher : "*";
      if (!Array.isArray(specs)) continue;
      const commands: HookCommandSpec[] = [];
      for (const spec of specs) {
        if (typeof spec !== "object" || spec === null) continue;
        const s = spec as Record<string, unknown>;
        if (!["command", "http", "prompt", "agent", "mcp_tool"].includes(String(s.type))) continue;
        const required =
          s.type === "command"
            ? "command"
            : s.type === "http"
              ? "url"
              : s.type === "mcp_tool"
                ? "tool"
                : "prompt";
        if (typeof s[required] !== "string" || !s[required]) continue;
        const parsed: HookCommandSpec = {
          type: s.type as HookCommandSpec["type"],
          timeout: typeof s.timeout === "number" && s.timeout > 0 ? s.timeout : undefined,
        };
        if (typeof s.command === "string") parsed.command = s.command;
        if (typeof s.url === "string") parsed.url = s.url;
        if (typeof s.prompt === "string") parsed.prompt = s.prompt;
        if (typeof s.tool === "string") parsed.tool = s.tool;
        if (typeof s.server === "string") parsed.server = s.server;
        if (s.headers && typeof s.headers === "object")
          parsed.headers = s.headers as Record<string, string>;
        if (s.input && typeof s.input === "object")
          parsed.input = s.input as Record<string, unknown>;
        if (s.async === true) parsed.async = true;
        commands.push(parsed);
      }
      if (commands.length > 0) entries.push({ matcher: effectiveMatcher, hooks: commands });
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
      // Official hooks see CLAUDE_PROJECT_DIR pointing at the project —
      // scripts routinely use it to locate repo-relative helpers.
      // Secret-shaped variables are STRIPPED (Top10 follow-up A4, user
      // decision): a hook from a cloned project must not inherit
      // LLM_API_KEY & co. Hooks that need credentials read their own config.
      env: { ...sanitizeChildEnv(process.env), CLAUDE_PROJECT_DIR: cwd },
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
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
    let stderrText = "";
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
    // stderr carries the exit-2 block reason; capture it, bounded like stdout.
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrText.length >= MAX_STDOUT_BYTES) return;
      const text = chunk.toString();
      stderrText += text.slice(0, MAX_STDOUT_BYTES - stderrText.length);
    });
    child.on("error", () => finish({}));
    child.on("close", (code) => {
      const parsed = parseJson(stdout);
      // Exit code 2 is the official no-JSON blocking path: stderr is the
      // reason fed back to the model and takes precedence over stdout JSON
      // (a JSON `reason` is the fallback when stderr is empty). Other exit
      // codes ignore stderr entirely.
      if (code === 2) {
        const reason =
          stderrText.trim() || (typeof parsed?.reason === "string" ? parsed.reason : "");
        finish(reason ? { decision: "block", reason } : { decision: "block" });
        return;
      }
      finish(
        parsed ??
          (stdout.trim() &&
          ["UserPromptSubmit", "SessionStart"].includes(String(stdin.hook_event_name))
            ? { hookSpecificOutput: { additionalContext: stdout.trim() } }
            : {}),
      );
    });

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
  let merged: Record<string, unknown> = {};
  for (const spec of specs) {
    const execute = async (): Promise<Record<string, unknown>> => {
      const timeoutMs = (spec.timeout ?? DEFAULT_HOOK_TIMEOUT_MS / 1000) * 1000;
      try {
        if (spec.type === "command")
          return await runCommandHook(spec.command!, stdin, cwd, timeoutMs);
        if (spec.type === "http") {
          const response = await fetch(spec.url!, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...spec.headers },
            body: JSON.stringify(stdin),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok || !response.body) throw new Error(`Hook HTTP ${response.status}`);
          const reader = response.body.getReader();
          let body = "";
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            body += Buffer.from(chunk.value).toString("utf8");
            if (body.length > MAX_STDOUT_BYTES) {
              await reader.cancel();
              throw new Error("Hook output too large");
            }
          }
          return parseJson(body) ?? {};
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expand = (value: unknown): unknown =>
          typeof value === "string"
            ? value.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
                let item: unknown = stdin;
                for (const part of key.split("."))
                  item =
                    item && typeof item === "object"
                      ? (item as Record<string, unknown>)[part]
                      : undefined;
                return typeof item === "string"
                  ? item
                  : item === undefined
                    ? ""
                    : JSON.stringify(item);
              })
            : value;
        const invocation =
          spec.type === "mcp_tool"
            ? services.callMcpTool?.(
                spec.server ? `mcp__${spec.server}__${spec.tool}` : spec.tool!,
                Object.fromEntries(
                  Object.entries(spec.input ?? {}).map(([key, value]) => [key, expand(value)]),
                ),
              )
            : services.evaluate?.(spec.prompt!, stdin, spec.type === "agent");
        if (!invocation) throw new Error(`Hook ${spec.type} service is unavailable`);
        try {
          return await Promise.race([
            invocation,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Hook timed out")), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        console.warn(`Hook failed: ${String(error)}`);
        return {};
      }
    };
    if (spec.async) {
      void execute().catch(() => {});
      continue;
    }
    const out = await execute();
    const specific =
      out.hookSpecificOutput && typeof out.hookSpecificOutput === "object"
        ? (out.hookSpecificOutput as Record<string, unknown>)
        : {};
    const decision = specific.decision as
      | { behavior?: unknown; updatedInput?: unknown }
      | undefined;
    if (decision?.behavior === "deny") {
      specific.permissionDecision = "deny";
    }
    merged = {
      ...merged,
      ...out,
      hookSpecificOutput: { ...(merged.hookSpecificOutput as object), ...specific },
    };
    if (
      out.decision === "block" ||
      out.ok === false ||
      specific.permissionDecision === "deny" ||
      out.continue === false
    )
      return {
        ...merged,
        decision: "block",
        reason: out.reason || specific.permissionDecisionReason || out.stopReason,
      };
  }
  return merged;
}

// ============================================================
// Hook construction
// ============================================================

function buildPhaseHook(
  phase: (typeof PHASES)[number],
  entry: HookConfigEntry,
  ctx?: HookRunContext,
): Hook {
  // Hooks run in the WORKSPACE root (official behavior), not the process's
  // startup cwd — the two diverge under WORKSPACE_ROOT, and a relative script
  // path would then resolve in the wrong directory (same drift class as the
  // mcp authDir bug fixed in a9e50bc).
  // Relative executable paths stay anchored to the configuration's trusted
  // workspace; the runtime envelope still follows the current session/cwd.
  const executionRoot = ctx?.workspaceRoot ?? process.cwd();
  const cwd = () => executionRoot;
  // Official stdin envelope: every hook receives session/transcript/cwd
  // context plus hook_event_name, so scripts written for the official client
  // can orient themselves without parsing tool-specific fields. Undefined
  // values are dropped by JSON.stringify.
  const envelope = () => ({
    session_id: ctx?.sessionId,
    transcript_path: ctx
      ? ccrPath(
          ctx.transcriptRoot ?? ctx.workspaceRoot,
          "sessions",
          `${ctx.sessionId}.transcript.jsonl`,
        )
      : undefined,
    cwd: ctx?.workspaceRoot ?? executionRoot,
    hook_event_name: phase,
  });
  switch (phase) {
    case "PreToolUse":
      return {
        matcher: entry.matcher,
        pre: async ({ toolName, input }) => {
          const out = await runSpecs(
            entry.hooks,
            { ...envelope(), tool_name: toolName, tool_input: input },
            cwd(),
          );
          if (out.decision === "block") {
            return { block: true, reason: (out.reason as string) || "blocked by PreToolUse hook" };
          }
          const specific = out.hookSpecificOutput as Record<string, unknown> | undefined;
          return {
            input: specific?.updatedInput as Record<string, unknown> | undefined,
            permissionDecision:
              specific?.permissionDecision === "allow" || specific?.permissionDecision === "ask"
                ? specific.permissionDecision
                : undefined,
            additionalContext:
              typeof specific?.additionalContext === "string"
                ? specific.additionalContext
                : undefined,
          };
        },
      };
    case "PostToolUse":
      return {
        matcher: entry.matcher,
        post: async ({ toolName, input, result }) => {
          const out = await runSpecs(
            entry.hooks,
            {
              ...envelope(),
              tool_name: toolName,
              tool_input: input,
              tool_response: result,
            },
            cwd(),
          );
          if (out.decision === "block") {
            return {
              result: {
                content: "",
                error: (out.reason as string) || "blocked by PostToolUse hook",
              },
            };
          }
          const extra = (out.hookSpecificOutput as { additionalContext?: unknown })
            ?.additionalContext;
          return typeof extra === "string"
            ? { result: { ...result, content: `${result.content}\n\n${extra}` } }
            : {};
        },
      };
    case "Stop":
      return {
        matcher: entry.matcher,
        stop: async ({ stopHookActive }) => {
          const out = await runSpecs(
            entry.hooks,
            { ...envelope(), stop_hook_active: stopHookActive },
            cwd(),
          );
          if (out.decision === "block") {
            return { blockingError: (out.reason as string) || "stop hook requested more work" };
          }
          return {};
        },
      };
    default:
      return {
        matcher: entry.matcher,
        eventName: phase,
        event: async (payload) => {
          if (payload.event !== phase) return;
          const out = await runSpecs(entry.hooks, { ...envelope(), ...payload }, cwd());
          const extra = (out.hookSpecificOutput as { additionalContext?: unknown })
            ?.additionalContext;
          const decision = (
            out.hookSpecificOutput as { decision?: { behavior?: unknown; updatedInput?: unknown } }
          )?.decision;
          return {
            block: out.decision === "block",
            reason: typeof out.reason === "string" ? out.reason : undefined,
            additionalContext: typeof extra === "string" ? extra : undefined,
            permissionDecision:
              decision?.behavior === "allow" || decision?.behavior === "deny"
                ? decision.behavior
                : undefined,
            input:
              decision?.updatedInput && typeof decision.updatedInput === "object"
                ? (decision.updatedInput as Record<string, unknown>)
                : undefined,
          };
        },
      };
  }
}

/**
 * Register every hook in a HooksConfig onto a HookRegistry. Returns the number
 * of hooks registered. Matching is done by the registry's own matcher logic
 * (a matcher may be a plain tool name, "*", or a regex such as "Edit|Write").
 */
export function registerHooksFromConfig(
  registry: HookRegistry,
  config: HooksConfig,
  ctx?: HookRunContext,
): number {
  let count = 0;
  for (const phase of PHASES) {
    for (const entry of config[phase] ?? []) {
      registry.register(buildPhaseHook(phase, entry, ctx));
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
export function loadHooksFromSettings(
  workspaceRoot: string,
  registry: HookRegistry,
  ctx?: HookRunContext,
): number {
  const settings = readSettings(workspaceRoot);
  const config = parseHooksConfig(settings);
  return registerHooksFromConfig(registry, config, ctx);
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
        flat.push([phase, entry.matcher, JSON.stringify(spec)].join("\u001f"));
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
        lines.push(
          `${phase} [${entry.matcher}]: ${spec.command ?? spec.url ?? spec.prompt ?? spec.tool}`,
        );
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
  ctx?: HookRunContext,
): Promise<TrustedHooksResult> {
  const settings = readProjectSettings(workspaceRoot);
  const config = parseHooksConfig(settings);
  return loadHooksConfigTrusted(workspaceRoot, config, registry, confirm, ctx);
}
export async function loadHooksConfigTrusted(
  workspaceRoot: string,
  config: HooksConfig,
  registry: HookRegistry,
  confirm: ((descriptions: string[]) => Promise<boolean>) | null,
  ctx?: HookRunContext,
): Promise<TrustedHooksResult> {
  const descriptions = describeHooksConfig(config);
  if (descriptions.length === 0) return { loaded: 0, skippedUntrusted: false };

  const fingerprint = hooksConfigFingerprint(config);
  if (isHooksConfigTrusted(workspaceRoot, fingerprint)) {
    return { loaded: registerHooksFromConfig(registry, config, ctx), skippedUntrusted: false };
  }
  if (confirm && (await confirm(descriptions))) {
    trustHooksConfig(workspaceRoot, fingerprint);
    return { loaded: registerHooksFromConfig(registry, config, ctx), skippedUntrusted: false };
  }
  return { loaded: 0, skippedUntrusted: true };
}
