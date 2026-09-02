// ============================================================
// CLI configuration — provider config from env, workspace root,
// permission-mode resolution, max-turns bound, CLAUDE.md loading.
// Pure resolvers: no I/O beyond reading env/argv/settings files.
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readSettings } from "./hooks-config.js";
import { resolveProviderConfig } from "./llm-adapter.js";
import type { ModelConfig, PermissionMode } from "./types.js";

export function loadConfig(): ModelConfig {
  const provider = (process.env.LLM_PROVIDER || "openai") as ModelConfig["provider"];
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
    model: process.env.LLM_MODEL || undefined,
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
        }
      : undefined,
  });

  // Fallback model chain (same provider): LLM_FALLBACK_MODELS="a,b,c".
  const fallbackModels = (process.env.LLM_FALLBACK_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fallbackModels.length > 0) {
    config.fallbackModels = fallbackModels;
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
  // Precedence (highest → lowest): CLI flag → --safe-mode → env → project
  // settings (settings.local.json > settings.json) → user settings (~/.claude).
  const flagIdx = process.argv.indexOf("--permission-mode");
  if (flagIdx !== -1) {
    const m = process.argv[flagIdx + 1] as PermissionMode | undefined;
    if (m && VALID_PERMISSION_MODES.includes(m)) return m;
  }
  // --safe-mode: force a read-only (plan) session regardless of env/config.
  if (process.argv.includes("--safe-mode")) {
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
  const project = readSettings(workspaceRoot);
  const projectMode = project?.permissionMode as PermissionMode | undefined;
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
  const user = readSettings(os.homedir());
  const userMode = user?.permissionMode as PermissionMode | undefined;
  if (userMode && VALID_PERMISSION_MODES.includes(userMode)) {
    return userMode;
  }
  return "default";
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
  const flagIdx = process.argv.indexOf("--max-turns");
  if (flagIdx !== -1) {
    const parsed = parseMaxTurns(process.argv[flagIdx + 1]);
    if (parsed !== undefined) return parsed;
  }
  const envParsed = parseMaxTurns(process.env.CCR_MAX_TURNS);
  if (envParsed !== undefined) return envParsed;
  return Number.POSITIVE_INFINITY;
}

// --- Load CLAUDE.md ---

export function loadClaudeMd(workspaceRoot: string): string | undefined {
  const claudeMdPath = path.join(workspaceRoot, "CLAUDE.md");
  try {
    return fs.readFileSync(claudeMdPath, "utf-8");
  } catch {
    return undefined;
  }
}
