// ============================================================
// MemorySave approval gate — runtime toggle (/memory-approval)
// ============================================================
// The T2 fix (fix-loop round 2, 记忆注入链) made every memory write require
// explicit approval: the saved text is injected verbatim into future
// sessions' system prompts (and project scope is VCS-shared), so an
// unapproved write is a durable prompt-injection channel. Per user decision
// (2026-10-04) the gate DEFAULTS TO OFF — silent writes like the pre-fix
// behavior — while permissions.deny rules and plan mode still apply. The
// toggle lets the user re-enable the strict posture deliberately.
//
// Persistence target follows the install location (see settings-target.ts):
//   global install → ~/.claude-code-replica/settings.json (user level)
//   local run      → <workspace>/.claude/settings.json (project level)
// …unless a project/local layer ALREADY owns the `memory` key: the toggle is
// then written to that layer, because startup merges user → project → local
// (later wins) and writing the lower layer would silently revert on the next
// session. Managed settings (CCR_MANAGED_SETTINGS) are always honored — an
// admin can force the gate ON regardless of install location.
//
// The READ is an OR over the layers, not a merge: a checked-in project file
// may only TIGHTEN the gate, never switch off a user's `true`. (Merging would
// let a repo's `false` loosen it — the same fail-open the deny-rule surface
// refuses.)
//
// Explicit-toggle exception (2026-10-05, "can't switch the gate off" fix): an
// OR read means a stale `true` in the USER'S OWN user-level settings pins the
// gate ON forever — the toggle writes the project layer (key owner) and the
// user-level pin silently keeps winning. A deliberate `/memory-approval off`
// is the user speaking about their own file, so the persist ALSO clears an
// explicit `true` in the user layer. A `true` in the project/local layer is
// NOT cleared (team/repo policy tightening wins; edit the file manually) —
// the persist then reports which layer keeps the gate pinned.
// ============================================================

import * as path from "node:path";
import {
  readManagedSettings,
  readSettingsFile,
  readSettingsFileStrict,
  readUserSettings,
  settingSources,
  userConfigRoot,
} from "./settings.js";
import { settingsWriteTarget } from "./settings-target.js";
import { atomicWriteFile, withFileLock } from "./utils/file-lock.js";

let requireApproval = false; // default OFF (user decision; T2 strict posture opt-in)

function parse(raw: unknown): boolean | undefined {
  const section = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return typeof section.requireApproval === "boolean" ? section.requireApproval : undefined;
}

/** Current gate state (startup-initialized, /memory-approval-mutated). */
export function isMemoryApprovalRequired(): boolean {
  return requireApproval;
}

/** OR the `memory.requireApproval` flag over every active settings layer. */
function resolveRequired(workspaceRoot: string): boolean {
  const sources = new Set(settingSources());
  const layers = [
    ...(sources.has("user") ? [readUserSettings()] : []),
    ...(sources.has("project")
      ? [readSettingsFile(joinLayer(workspaceRoot, "settings.json"))]
      : []),
    ...(sources.has("local")
      ? [readSettingsFile(joinLayer(workspaceRoot, "settings.local.json"))]
      : []),
    readManagedSettings(),
  ];
  return layers.some((layer) => parse(layer.memory) === true);
}

function joinLayer(workspaceRoot: string, file: string): string {
  return path.join(workspaceRoot, ".claude", file);
}

/** Read the toggle from the active settings layers + managed settings. */
export function initMemoryApproval(workspaceRoot: string): void {
  requireApproval = resolveRequired(workspaceRoot);
}

/** Runtime-only override (tests). */
export function setMemoryApproval(required: boolean): void {
  requireApproval = required;
}

/** Result of persisting the toggle. */
export interface MemoryApprovalPersistResult {
  /** Effective gate after the write + re-derive (OR over layers). */
  effective: boolean;
  /**
   * Set when an off-toggle did NOT take effect because another layer still
   * forces the gate ON (project/local file or managed settings). Label of
   * that layer, for the command to tell the user WHERE to look.
   */
  pinnedBy?: string;
}

/** Write `memory.requireApproval` into one settings file, preserving keys. */
function writeToggleToFile(file: string, required: boolean): void {
  const { value: existing, corrupt } = readSettingsFileStrict(file);
  if (corrupt) {
    throw new Error(
      `${file} is not valid JSON — fix or delete it before toggling ` +
        `(refusing to rewrite it: every other setting in it would be lost).`,
    );
  }
  const memorySection = (
    existing.memory && typeof existing.memory === "object" ? existing.memory : {}
  ) as Record<string, unknown>;
  const next = `${JSON.stringify(
    { ...existing, memory: { ...memorySection, requireApproval: required } },
    null,
    2,
  )}\n`;
  withFileLock(file, () => atomicWriteFile(file, next));
}

function userLayerLabel(): string {
  const redirected = !!process.env.CCR_USER_CONFIG_DIR || process.env.CCR_COMPAT_CLAUDE === "1";
  const shown = redirected ? userConfigRoot() : "~/.claude-code-replica";
  return `${shown}/settings.json (user level)`;
}

/** Label of the layer still forcing the gate ON, or undefined. */
function pinningLayer(workspaceRoot: string): string | undefined {
  if (parse(readManagedSettings().memory) === true)
    return `managed settings (${process.env.CCR_MANAGED_SETTINGS ?? "CCR_MANAGED_SETTINGS"})`;
  const sources = new Set(settingSources());
  if (
    sources.has("local") &&
    parse(readSettingsFile(joinLayer(workspaceRoot, "settings.local.json")).memory) === true
  )
    return ".claude/settings.local.json (local)";
  if (
    sources.has("project") &&
    parse(readSettingsFile(joinLayer(workspaceRoot, "settings.json")).memory) === true
  )
    return ".claude/settings.json (project)";
  if (sources.has("user") && parse(readUserSettings().memory) === true) return userLayerLabel();
  return undefined;
}

/**
 * Persist the toggle (preserving other keys) and re-derive the live gate from
 * the layers, so managed settings keep winning for the rest of the session.
 * An explicit off-toggle also clears a stale `true` in the USER layer when
 * the write target is elsewhere (the OR read would otherwise pin the gate ON
 * forever — see the header). Throws when the target file exists but is not
 * valid JSON — writing over it would delete every other key it holds
 * (permissions.deny, hooks, …).
 */
export function persistMemoryApproval(
  required: boolean,
  workspaceRoot: string,
): MemoryApprovalPersistResult {
  const target = settingsWriteTarget(workspaceRoot, "memory");
  writeToggleToFile(target.file, required);
  // Explicit off-toggle clears the user's OWN user-level pin too (their file,
  // their command). A corrupt user file can't be rewritten safely — leave it
  // and let pinningLayer() below report it.
  if (!required && settingSources().includes("user")) {
    const userFile = path.join(userConfigRoot(), "settings.json");
    if (userFile !== target.file && parse(readUserSettings().memory) === true) {
      try {
        writeToggleToFile(userFile, false);
      } catch {
        // fall through — reported via pinnedBy
      }
    }
  }
  requireApproval = resolveRequired(workspaceRoot);
  const pinnedBy = !required && requireApproval ? pinningLayer(workspaceRoot) : undefined;
  return { effective: requireApproval, pinnedBy };
}
