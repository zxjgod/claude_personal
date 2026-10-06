// ============================================================
// Settings target resolution — WHERE toggle commands persist
// ============================================================
// /agents and /memory-approval persist their toggles to a settings.json, but
// WHICH one follows the install location:
//
//   - globally-installed CLI (package root OUTSIDE the workspace — e.g. an
//     npm -g install under %APPDATA%\npm\node_modules): the settings belong
//     to the user, shared across every project the CLI runs in
//     → ~/.claude-code-replica/settings.json (user level)
//   - local/dev run (package root inside or == the workspace — e.g. npm start
//     from a cloned repo): the settings belong to that project
//     → <workspace>/.claude/settings.json (project level)
//
// packageRoot is injectable for tests (the local-run branch is otherwise
// unreachable from a tmp workspace).
// ============================================================

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSettingsFile,
  type SettingSource,
  settingSources,
  userConfigRoot,
} from "./settings.js";

function defaultPackageRoot(): string {
  // One level up in dev (src/) and the old flat dist/, two levels up from a
  // bundled dist/chunks/ chunk — walk up to the first dir with package.json.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ["..", "../.."]) {
    const candidate = path.resolve(here, rel);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return path.resolve(here, "..");
}

/** True when the running CLI's own package lives OUTSIDE the workspace. */
export function isGlobalInstall(workspaceRoot: string, pkgRoot?: string): boolean {
  const own = path.resolve(pkgRoot ?? defaultPackageRoot());
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, own);
  return rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel));
}

/** Absolute path of the settings.json the toggle commands read and write. */
export function settingsTargetFile(workspaceRoot: string, pkgRoot?: string): string {
  return isGlobalInstall(workspaceRoot, pkgRoot)
    ? path.join(userConfigRoot(), "settings.json")
    : path.join(workspaceRoot, ".claude", "settings.json");
}

function userTargetLabel(): string {
  // userConfigRoot() honors CCR_USER_CONFIG_DIR / CCR_COMPAT_CLAUDE — a
  // hardcoded "~/.claude-code-replica/settings.json" named a file the writer
  // never touched under those settings, so the user edited the wrong one.
  const redirected = !!process.env.CCR_USER_CONFIG_DIR || process.env.CCR_COMPAT_CLAUDE === "1";
  const shown = redirected ? userConfigRoot() : "~/.claude-code-replica";
  return `${shown}/settings.json (user level)`;
}

/** Short display label for the target (used in command output and menu hints). */
export function settingsTargetLabel(workspaceRoot: string, pkgRoot?: string): string {
  return isGlobalInstall(workspaceRoot, pkgRoot)
    ? userTargetLabel()
    : ".claude/settings.json (project level)";
}

/** One settings layer on disk + how to name it in output. */
interface Layer {
  file: string;
  label: string;
}

/** Ordered highest → lowest precedence, restricted to the active sources. */
// biome-ignore lint/correctness/noUnusedFunctionParameters: reserved slot for a package-level settings layer; no such source exists yet
function activeLayers(workspaceRoot: string, pkgRoot?: string): Layer[] {
  const sources = new Set<SettingSource>(settingSources());
  const layers: Layer[] = [];
  if (sources.has("local"))
    layers.push({
      file: path.join(workspaceRoot, ".claude", "settings.local.json"),
      label: ".claude/settings.local.json (local)",
    });
  if (sources.has("project"))
    layers.push({
      file: path.join(workspaceRoot, ".claude", "settings.json"),
      label: ".claude/settings.json (project)",
    });
  if (sources.has("user"))
    layers.push({ file: path.join(userConfigRoot(), "settings.json"), label: userTargetLabel() });
  return layers;
}

function definesKey(file: string, key: string): boolean {
  return Object.hasOwn(readSettingsFile(file), key);
}

/**
 * WHERE a toggle for `key` must be written so it actually takes effect.
 *
 * Startup merges user → project → local (later wins), so writing a toggle to
 * the install-level default while a project/local layer already defines the
 * key silently reverts on the next session — the command even printed
 * "persisted". Write to the highest-precedence layer that owns the key, and
 * only fall back to the install-level default when no layer owns it.
 */
export function settingsWriteTarget(workspaceRoot: string, key: string, pkgRoot?: string): Layer {
  for (const layer of activeLayers(workspaceRoot, pkgRoot)) {
    if (definesKey(layer.file, key)) return layer;
  }
  const file = settingsTargetFile(workspaceRoot, pkgRoot);
  return { file, label: settingsTargetLabel(workspaceRoot, pkgRoot) };
}
