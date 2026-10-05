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
import {
  emitHookProgress,
  emitHookResponse,
  emitHookStarted,
  type HookOutcome,
  hookIdentity,
} from "./hook-events.js";
import type { Hook, HookRegistry } from "./hooks.js";
import { readProjectSettings, readSettings } from "./settings.js";
import { hookToolInput } from "./tools/utils/official-params.js";
import { sanitizeTerminalText } from "./tui/terminal-width.js";
import { sanitizeChildEnv } from "./utils/env-sanitize.js";
import { atomicWriteFile, withFileLock } from "./utils/file-lock.js";
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
/**
 * Ceiling for a hook's own `timeout` (seconds in the config). Unbounded before:
 * `"timeout": 1e12` in a settings/hooks.json — project-sourced and therefore
 * behind a trust prompt, but a trust prompt does not review arithmetic — pinned
 * every tool call that matched the hook for the effective lifetime of the
 * process. 10 minutes is far beyond any real hook.
 */
const MAX_HOOK_TIMEOUT_MS = 600_000;
const MAX_STDOUT_BYTES = 100_000;
/** Official throttles `hook_progress` frames to one per second. */
const HOOK_PROGRESS_INTERVAL_MS = 1_000;

/**
 * Sentinel rejection for a timed-out prompt/agent/MCP hook. Distinct from a
 * genuine failure so the lifecycle event reports `cancelled`, not `error`.
 */
const HOOK_TIMEOUT = new Error("Hook timed out");

/**
 * How one hook invocation ended, from the lifecycle-event point of view.
 *
 * `malformed` is deliberately NOT an execution failure: the hook ran but
 * produced nothing this runtime could read (a crash, a non-JSON exit). The
 * fail-safe rule still treats it as a no-op — the distinction only reaches
 * the stream, where a consumer can see that a hook misbehaved.
 */
type HookRunStatus = "ok" | "cancelled" | "transport_error" | "malformed";

interface HookRunResult {
  result: Record<string, unknown>;
  status: HookRunStatus;
  stdout: string;
  stderr: string;
  output: string;
  exitCode?: number;
}

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
  // Official nests the screen-reader switch under a `screenReader` object
  // (screenReader.axScreenReader); read by ax-screen-reader.ts.
  "screenReader",
  // Official's kill-switch for the whole background-agent surface; read by
  // bg-startup.ts as the feature gate.
  "disableAgentView",
  // MemorySave approval gate (memory.requireApproval); read by
  // initMemoryApproval (written by /memory-approval).
  "memory",
  // Sub-agent runtime settings (thinking / sidechainMode); read by
  // initSubagentSettings (written by /agents).
  "subagents",
  // Official key: names of mcp.json servers to skip entirely; consumed by
  // cli-tools.ts → MCPLoadOptions.disabledServers.
  "disabledMcpjsonServers",
]);

/** Emit diagnostics for settings keys that this replica does not consume. */
export function warnUnknownSettings(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const unknown = Object.keys(settings).filter((key) => !KNOWN_SETTINGS_KEYS.has(key));
  for (const key of unknown)
    console.warn(`Warning: unsupported settings key ignored: ${sanitizeTerminalText(key)}`);
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
 * stdout JSON plus the raw channels the lifecycle events report. Never
 * rejects: any error/timeout/non-JSON resolves to a no-op `result`.
 * `decision` is the only field the callers interpret.
 */
function runCommandHook(
  command: string,
  stdin: Record<string, unknown>,
  cwd: string,
  timeoutMs: number,
  onOutput?: (snapshot: { stdout: string; stderr: string }) => void,
): Promise<HookRunResult> {
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
    const finish = (
      result: Record<string, unknown>,
      status: HookRunStatus,
      exitCode?: number,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        result,
        status,
        stdout,
        stderr: stderrText,
        output: stdout,
        ...(exitCode !== undefined && { exitCode }),
      });
    };
    const timer = setTimeout(() => {
      killTree();
      finish({}, "cancelled");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length >= MAX_STDOUT_BYTES) return;
      const text = chunk.toString();
      const remaining = MAX_STDOUT_BYTES - stdout.length;
      stdout += text.slice(0, remaining);
      onOutput?.({ stdout, stderr: stderrText });
      if (text.length > remaining) {
        killTree();
        finish({}, "malformed");
      }
    });
    // stderr carries the exit-2 block reason; capture it, bounded like stdout.
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrText.length >= MAX_STDOUT_BYTES) return;
      const text = chunk.toString();
      stderrText += text.slice(0, MAX_STDOUT_BYTES - stderrText.length);
      onOutput?.({ stdout, stderr: stderrText });
    });
    child.on("error", () => finish({}, "malformed"));
    child.on("close", (code) => {
      const parsed = parseJson(stdout);
      // Exit 2 is the official blocking path, so a crash on any OTHER non-zero
      // code with unreadable output is what "the hook misbehaved" looks like.
      const status: HookRunStatus = parsed || code === 0 || code === 2 ? "ok" : "malformed";
      // Exit code 2 is the official no-JSON blocking path: stderr is the
      // reason fed back to the model and takes precedence over stdout JSON
      // (a JSON `reason` is the fallback when stderr is empty). Other exit
      // codes ignore stderr entirely.
      if (code === 2) {
        const reason =
          stderrText.trim() || (typeof parsed?.reason === "string" ? parsed.reason : "");
        finish(
          reason ? { decision: "block", reason } : { decision: "block" },
          status,
          code ?? undefined,
        );
        return;
      }
      finish(
        parsed ??
          (stdout.trim() &&
          ["UserPromptSubmit", "SessionStart"].includes(String(stdin.hook_event_name))
            ? { hookSpecificOutput: { additionalContext: stdout.trim() } }
            : {}),
        status,
        code ?? undefined,
      );
    });

    // A hook that exits before reading stdin makes the write fail with EPIPE.
    // That must NOT settle the promise: the `close` handler still has the exit
    // code, and settling here dropped the official exit-2 block (stderr reason
    // → `{decision:"block"}`) whenever the child exited fast. Just ignore it —
    // `close` always follows.
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(JSON.stringify(stdin));
      child.stdin.end();
    } catch {
      // Already destroyed (a timeout killed the child mid-write) — `close`
      // decides the outcome.
    }
  });
}

/**
 * Effective timeout for one hook spec, in ms. Exported for testing.
 */
export function hookTimeoutMs(seconds?: number): number {
  return Math.min((seconds ?? DEFAULT_HOOK_TIMEOUT_MS / 1000) * 1000, MAX_HOOK_TIMEOUT_MS);
}

/** Run a list of command specs in order; the first `block` decision wins. */
async function runSpecs(
  specs: HookCommandSpec[],
  stdin: Record<string, unknown>,
  cwd: string,
  matcher?: string,
): Promise<Record<string, unknown>> {
  const eventName = String(stdin.hook_event_name ?? "");
  let merged: Record<string, unknown> = {};
  for (const spec of specs) {
    const id = hookIdentity(eventName, matcher, crypto.randomUUID());
    const startedAt = Date.now();
    const execute = async (): Promise<HookRunResult> => {
      const timeoutMs = hookTimeoutMs(spec.timeout);
      // Official streams a hook's growing output on a 1s interval, so a hook
      // that finishes inside the first second reports no progress at all.
      let lastProgressAt = startedAt;
      const onOutput = (snapshot: { stdout: string; stderr: string }): void => {
        const now = Date.now();
        if (now - lastProgressAt < HOOK_PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        emitHookProgress(id, snapshot);
      };
      try {
        if (spec.type === "command")
          return await runCommandHook(spec.command!, stdin, cwd, timeoutMs, onOutput);
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
          const parsed = parseJson(body);
          return {
            result: parsed ?? {},
            status: parsed ? "ok" : "malformed",
            stdout: body,
            stderr: "",
            output: body,
            exitCode: response.status,
          };
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
          const out = await Promise.race([
            invocation,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(HOOK_TIMEOUT), timeoutMs);
            }),
          ]);
          return {
            result: out,
            status: "ok",
            stdout: "",
            stderr: "",
            output: JSON.stringify(out),
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        console.warn(`Hook failed: ${String(error)}`);
        const stderr = String(error);
        return {
          result: {},
          status: error === HOOK_TIMEOUT ? "cancelled" : "transport_error",
          stdout: "",
          stderr,
          output: stderr,
        };
      }
    };
    const report = (run: HookRunResult, specific: Record<string, unknown> | undefined): void => {
      const blocked =
        run.result.decision === "block" ||
        run.result.ok === false ||
        specific?.permissionDecision === "deny" ||
        run.result.continue === false;
      const outcome: HookOutcome =
        run.status === "cancelled"
          ? "cancelled"
          : run.status === "transport_error"
            ? "error"
            : blocked
              ? "blocking"
              : run.status === "malformed"
                ? "non_blocking_error"
                : "success";
      emitHookResponse(id, {
        outcome,
        output: run.output,
        stdout: run.stdout,
        stderr: run.stderr,
        exitCode: run.exitCode,
        durationMs: Date.now() - startedAt,
      });
    };
    emitHookStarted(id);
    if (spec.async) {
      // Fire-and-forget, but never unhandled: a throwing report()/sink would
      // otherwise become an unhandled rejection and kill the CLI (Node >= 22).
      void execute()
        .then((run) =>
          report(run, run.result.hookSpecificOutput as Record<string, unknown> | undefined),
        )
        .catch(() => {});
      continue;
    }
    const run = await execute();
    const out = run.result;
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
    ) {
      report(run, specific);
      return {
        ...merged,
        decision: "block",
        reason: out.reason || specific.permissionDecisionReason || out.stopReason,
      };
    }
    report(run, specific);
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
            { ...envelope(), tool_name: toolName, tool_input: hookToolInput(toolName, input) },
            cwd(),
            entry.matcher,
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
              tool_input: hookToolInput(toolName, input),
              tool_response: result,
            },
            cwd(),
            entry.matcher,
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
            entry.matcher,
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
          const out = await runSpecs(
            entry.hooks,
            { ...envelope(), ...payload },
            cwd(),
            entry.matcher,
          );
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
    // Locked + atomic (see cli-config's trust store): a plain overwrite could
    // drop another workspace's approvals, and a half-written store parses as
    // empty — silently re-prompting for every workspace's hooks.
    withFileLock(file, () => atomicWriteFile(file, JSON.stringify(store, null, 2)));
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
