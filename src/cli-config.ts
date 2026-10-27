// ============================================================
// CLI configuration — provider config from env, workspace root,
// permission-mode resolution, max-turns bound, CLAUDE.md loading.
// Pure resolvers: no I/O beyond reading env/argv/settings files.
// ============================================================

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseEffortFlag, parseFallbackModels } from "./cli-session-flags.js";
import { readSettings } from "./hooks-config.js";
import { resolveProviderConfig } from "./llm-adapter.js";
import { initMemoryApproval } from "./memory-approval.js";
import { mergePermissionPolicies, type PermissionPolicy } from "./permission-policy.js";
import { loadProjectInstructions, renderInstructions } from "./project-instructions.js";
import {
  mergeSettings,
  readManagedSettings,
  readProjectSettings,
  readUserSettings,
  type Settings,
  settingSources,
} from "./settings.js";
import { initSubagentSettings } from "./subagent-settings.js";
import type { ModelConfig, PermissionMode } from "./types.js";
import { atomicWriteFile, withFileLock } from "./utils/file-lock.js";

export function loadConfig(): ModelConfig {
  const workspace = process.env.WORKSPACE_ROOT || process.cwd();
  const settings = readSettings(workspace);
  // 拍板 #21/#22: sub-agent runtime settings (thinking default + sidechain
  // mode) ride the same merged settings, key "subagents".
  initSubagentSettings(settings);
  // T2 gate toggle (/memory-approval): defaults OFF (user decision 2026-10-04);
  // read from the resolved settings target (install-location dependent) +
  // managed settings — see memory-approval.ts.
  initMemoryApproval(workspace);
  // env is a credential-adjacent lever (LLM_BASE_URL/PERMISSION_MODE/
  // CCR_TRUST_STORE_SETTINGS are all read from process.env below), so only
  // trusted sources may set it: user settings, managed settings, and the
  // explicit --settings CLI arg. Project/local settings come from a
  // checked-out repository and must never inject process.env.
  const env = mergeSettings(
    (readUserSettings().env as Settings | undefined) ?? {},
    (readManagedSettings().env as Settings | undefined) ?? {},
  );
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value === "string" && process.env[key] === undefined) process.env[key] = value;
    }
  }
  const modelSettings = settings?.model;
  const provider = (process.env.LLM_PROVIDER ||
    (typeof modelSettings === "string"
      ? undefined
      : (modelSettings as { provider?: unknown } | undefined)?.provider) ||
    "openai") as ModelConfig["provider"];
  const apiKey = process.env.LLM_API_KEY;

  if (!apiKey) {
    console.error(
      "Error: LLM_API_KEY is not set. Create a .env file or set the environment variable.",
    );
    // No resources to clean up yet (persistence/mcp not constructed), but flush
    // stdout/stderr before exiting so the message is not truncated on Windows.
    process.exitCode = 1;
    return {} as ModelConfig;
  }

  const config = resolveProviderConfig({
    provider,
    apiKey,
    model:
      flagValues("--model")[0] ||
      process.env.LLM_MODEL ||
      (typeof modelSettings === "string"
        ? modelSettings
        : ((modelSettings as { name?: unknown } | undefined)?.name as string | undefined)),
    baseURL: process.env.LLM_BASE_URL || undefined,
    maxTokens: process.env.LLM_MAX_TOKENS ? parseInt(process.env.LLM_MAX_TOKENS, 10) : undefined,
    temperature: process.env.LLM_TEMPERATURE ? parseFloat(process.env.LLM_TEMPERATURE) : undefined,
    // Cloud gateway routing (11.3): LLM_GATEWAY=bedrock|vertex, plus region
    // and (Vertex) project. Resolved into an OpenAI-compatible base URL.
    options: process.env.LLM_GATEWAY
      ? {
          gateway: process.env.LLM_GATEWAY,
          gatewayRegion: process.env.LLM_GATEWAY_REGION || undefined,
          gatewayProject: process.env.LLM_GATEWAY_PROJECT || undefined,
          // Vertex API version segment (default v1, Google's documented
          // OpenAI-compatible path). Escape hatch for deployments that need
          // v1beta1 — cloud-gateway.ts documents why neither could be
          // live-tested from the build environment.
          gatewayApiVersion: process.env.LLM_GATEWAY_API_VERSION || undefined,
        }
      : undefined,
  });

  // Keep the saved UI preference in the same modelConfig channel that runTui
  // applies before its first frame. The value comes from the merged settings
  // source used by /theme persistence, not a separate theme-only file.
  if (settings.theme === "dark" || settings.theme === "light") {
    config.options = { ...config.options, theme: settings.theme };
  }

  const imageInputOverride = process.env.LLM_SUPPORTS_IMAGES ?? "";
  if (/^(true|false|1|0)$/i.test(imageInputOverride)) {
    config.options = {
      ...(config.options ?? {}),
      supportsImages: /^(true|1)$/i.test(imageInputOverride),
    };
  }

  // Fallback model chain (same provider). Precedence: official
  // `--fallback-model a,b,c` flag → LLM_FALLBACK_MODELS="a,b,c". The official
  // flag is documented as --print only; here the chain is provider-agnostic and
  // already implemented in the agent loop, so it applies to every entry point
  // rather than being artificially restricted to one.
  const fallbackModels =
    parseFallbackModels(process.argv) ??
    (process.env.LLM_FALLBACK_MODELS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (fallbackModels.length > 0) {
    config.fallbackModels = fallbackModels;
  }
  // `--effort <level>` — the session reasoning tier, the same value /effort
  // writes at runtime. Set before returning so headless, TUI and REPL all
  // start on the requested tier; /effort can still change it mid-session.
  const effort = parseEffortFlag(process.argv);
  if (effort) {
    config.options = { ...(config.options ?? {}), effort };
  }
  return config;
}

// --- Workspace ---

export function getWorkspaceRoot(): string {
  return process.env.WORKSPACE_ROOT || process.cwd();
}

const VALID_PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "auto",
  "dontAsk",
];

export function getPermissionMode(workspaceRoot: string): PermissionMode {
  const managed = readManagedSettings();
  const managedMode = (managed.permissionMode ??
    (managed.permissions as { defaultMode?: unknown })?.defaultMode) as PermissionMode;
  if (VALID_PERMISSION_MODES.includes(managedMode)) return managedMode;
  // Precedence (highest → lowest): CLI flag → --safe-mode → env → project
  // settings (settings.local.json > settings.json) → user settings (~/.claude).
  const flagMode = flagValues("--permission-mode")[0] as PermissionMode | undefined;
  if (flagMode && VALID_PERMISSION_MODES.includes(flagMode)) return flagMode;
  // --safe-mode: force a read-only (plan) session regardless of env/config.
  if (process.argv.includes("--read-only")) {
    return "plan";
  }
  const envMode = process.env.PERMISSION_MODE as PermissionMode | undefined;
  if (envMode && VALID_PERMISSION_MODES.includes(envMode)) {
    return envMode;
  }
  // Project settings live inside the checked-out repository, so treat them as
  // UNTRUSTED: a cloned repo must not be able to silently opt the session into
  // a no-confirmation mode. Privileged modes are only honored from sources the
  // user controls directly — the CLI flag, PERMISSION_MODE, or user settings.
  const PROJECT_FORBIDDEN_MODES: PermissionMode[] = ["bypassPermissions", "auto"];
  const project = readProjectSettings(workspaceRoot);
  const projectMode = (project?.permissionMode ??
    (project?.permissions as { defaultMode?: unknown })?.defaultMode) as PermissionMode | undefined;
  if (projectMode && VALID_PERMISSION_MODES.includes(projectMode)) {
    if (PROJECT_FORBIDDEN_MODES.includes(projectMode)) {
      console.error(
        `Warning: project .claude/settings.json requests permissionMode ` +
          `"${projectMode}", which is not honored from project settings. ` +
          `Use --permission-mode, PERMISSION_MODE, or user settings instead.`,
      );
    } else {
      return projectMode;
    }
  }
  const trusted = readSettings(workspaceRoot, settingSources().includes("user") ? ["user"] : []);
  const mode = (trusted.permissionMode ??
    (trusted.permissions as { defaultMode?: unknown })?.defaultMode) as PermissionMode;
  return VALID_PERMISSION_MODES.includes(mode) ? mode : "default";
}

function flagValues(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg === flag && process.argv[i + 1]) out.push(process.argv[++i]!);
    else if (arg.startsWith(`${flag}=`)) out.push(arg.slice(flag.length + 1));
  }
  return out
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

// --- Project allow-rule trust gate (Top10 follow-up A3, user decision:
// one-time fingerprint confirmation) ---
// A cloned repo can ship `.claude/settings.json` with `permissions.allow`
// entries — `allow: ["*"]` would silently erode every default prompt. Allow
// rules from the PROJECT scope therefore require a one-time fingerprint
// confirmation (same mechanism as the MCP project trust gate); deny/ask rules
// stay effective untrusted (they only ever ADD friction). User-level rules and
// CLI flags are the user's own voice and are never gated.

function projectAllowTrustStorePath(): string {
  if (process.env.CCR_TRUST_STORE_SETTINGS) return process.env.CCR_TRUST_STORE_SETTINGS;
  // Same rule as the audit log (A8): when neither HOME nor USERPROFILE
  // exists, DISABLE ("" → every read/write throws → untrusted → project
  // allow rules fail closed) rather than falling back to "." — a trust store
  // landing inside the (possibly cloned) working tree would let a malicious
  // repo pre-seed its own trust. Fourth-round review.
  const home = process.env.HOME || process.env.USERPROFILE;
  return home ? path.join(home, ".claude-code-replica", "trusted-project-settings.json") : "";
}

/** The project's allow rules + their content fingerprint, or null when none. */
function projectAllowFingerprint(workspaceRoot: string): { allow: string[]; fp: string } | null {
  const perms = readProjectSettings(workspaceRoot)?.permissions as { allow?: unknown } | undefined;
  const allow = Array.isArray(perms?.allow)
    ? (perms!.allow as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (allow.length === 0) return null;
  const fp = crypto
    .createHash("sha256")
    .update(JSON.stringify([...allow].sort()))
    .digest("hex");
  return { allow, fp };
}

/** Trust is keyed by the RESOLVED settings path (like the MCP project gate):
 *  the same allow list in a different clone is a different trust decision. */
function projectSettingsKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, ".claude", "settings.json");
}

function isProjectAllowTrusted(workspaceRoot: string, fp: string): boolean {
  try {
    const store = JSON.parse(fs.readFileSync(projectAllowTrustStorePath(), "utf-8")) as Record<
      string,
      string
    >;
    return store[projectSettingsKey(workspaceRoot)] === fp;
  } catch {
    return false;
  }
}

function trustProjectAllow(workspaceRoot: string, fp: string): void {
  try {
    const file = projectAllowTrustStorePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let store: Record<string, string> = {};
    try {
      store = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>;
    } catch {
      // Missing or corrupt store — start fresh.
    }
    store[projectSettingsKey(workspaceRoot)] = fp;
    // Locked + atomic: the store is keyed per workspace, so a plain overwrite
    // could drop ANOTHER workspace's approvals (or be read half-written by a
    // concurrent process, re-prompting the user).
    withFileLock(file, () => atomicWriteFile(file, JSON.stringify(store, null, 2)));
  } catch {
    // Best-effort persistence; failure just re-prompts next launch.
  }
}

/**
 * Interactive one-time confirmation of the project's allow rules. Call at
 * startup BEFORE getPermissionPolicy. Non-TTY: untrusted allow rules are
 * ignored for the session (fail-closed) with a warning. Editing the rules
 * changes the fingerprint and re-prompts.
 */
export async function confirmProjectAllowRules(
  workspaceRoot: string,
  opts: { interactive?: boolean } = {},
): Promise<void> {
  const found = projectAllowFingerprint(workspaceRoot);
  if (!found || isProjectAllowTrusted(workspaceRoot, found.fp)) return;
  const interactive = opts.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (interactive) {
    console.log(
      "\nThis project's .claude/settings.json defines permission ALLOW rules that skip confirmation prompts:",
    );
    for (const rule of found.allow.slice(0, 20)) console.log(`   ${rule}`);
    if (found.allow.length > 20) console.log(`   …and ${found.allow.length - 20} more`);
    const { askYesNo } = await import("./cli-prompts.js");
    if (await askYesNo("Trust these project allow rules? [y/N] ")) {
      trustProjectAllow(workspaceRoot, found.fp);
      return;
    }
  }
  console.warn(
    "cli-config: project permission allow rules are NOT trusted (no confirmation possible); they are ignored for this session. deny/ask rules still apply.",
  );
}

/** Resolve durable permission rules: user settings, project settings, then CLI flags. */
export function getPermissionPolicy(workspaceRoot: string): PermissionPolicy {
  const project = readProjectSettings(workspaceRoot);
  // Untrusted project allow rules are stripped before the merge (A3 gate);
  // confirmProjectAllowRules() at startup is what flips the fingerprint.
  const found = projectAllowFingerprint(workspaceRoot);
  const projectPerms =
    found && !isProjectAllowTrusted(workspaceRoot, found.fp)
      ? { ...(project?.permissions as object), allow: [] }
      : project?.permissions;
  const trusted = readSettings(workspaceRoot, settingSources().includes("user") ? ["user"] : []);
  const policy = mergePermissionPolicies(
    trusted.permissions,
    projectPerms,
    readManagedSettings().permissions,
  );
  policy.allow.push(...flagValues("--allowedTools"), ...flagValues("--allowed-tools"));
  policy.deny.push(...flagValues("--disallowedTools"), ...flagValues("--disallowed-tools"));
  if (process.argv.includes("--dangerously-skip-permissions")) {
    // Preserve the explicit opt-out semantics while still leaving the safety
    // floor in checkPermission intact. NOTE (Top10 follow-up A10, honest
    // docs): despite the name, this flag does NOT skip the dangerous-pattern
    // confirmations or blocked-path floor — it only pre-allows the ordinary
    // prompt. That is deliberate (safer than the official behavior); the help
    // text says so.
    policy.allow.push("*");
  }
  return policy;
}

// --- Max turns (loop bound) ---
/**
 * Parse a maxTurns value: a positive integer is used as-is; "unlimited" /
 * "infinity" / "0" disable the cap entirely. Returns undefined for anything
 * invalid so callers fall back to the default.
 */
export function parseMaxTurns(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "unlimited" || trimmed === "infinity" || trimmed === "0") {
    return Number.POSITIVE_INFINITY;
  }
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the main agent loop's maxTurns bound. Precedence: CLI `--max-turns <n>`
 * → env `CCR_MAX_TURNS` → unlimited by default. A finite value is an explicit
 * operator safety ceiling, never an implicit reason to cut off a main task.
 */
export function resolveMaxTurns(): number {
  // flagValues covers BOTH "--max-turns 5" and "--max-turns=5" — the old
  // indexOf lookup silently missed the "=" form and fell through to
  // unlimited (fail-open).
  const flagRaw = flagValues("--max-turns")[0];
  if (flagRaw !== undefined) {
    const parsed = parseMaxTurns(flagRaw);
    if (parsed !== undefined) return parsed;
  }
  const envParsed = parseMaxTurns(process.env.CCR_MAX_TURNS);
  if (envParsed !== undefined) return envParsed;
  return Number.POSITIVE_INFINITY;
}

// --- Load CLAUDE.md ---

export function loadClaudeMd(workspaceRoot: string): string | undefined {
  return renderInstructions(loadProjectInstructions(workspaceRoot)) || undefined;
}
