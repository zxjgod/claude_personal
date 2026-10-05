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
// ============================================================

import * as path from "node:path";
import {
  readManagedSettings,
  readSettingsFile,
  readSettingsFileStrict,
  readUserSettings,
  settingSources,
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

/**
 * Persist the toggle (preserving other keys) and re-derive the live gate from
 * the layers, so managed settings keep winning for the rest of the session.
 * Throws when the target file exists but is not valid JSON — writing over it
 * would delete every other key it holds (permissions.deny, hooks, …).
 */
export function persistMemoryApproval(required: boolean, workspaceRoot: string): boolean {
  const target = settingsWriteTarget(workspaceRoot, "memory");
  const { value: existing, corrupt } = readSettingsFileStrict(target.file);
  if (corrupt) {
    throw new Error(
      `${target.file} is not valid JSON — fix or delete it before toggling ` +
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
  withFileLock(target.file, () => atomicWriteFile(target.file, next));
  requireApproval = resolveRequired(workspaceRoot);
  return requireApproval;
}
