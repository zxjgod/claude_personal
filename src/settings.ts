import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const unavailableUserRoot = path.join(os.tmpdir(), `ccr-no-user-${randomUUID()}`);

export type Settings = Record<string, unknown>;
export type SettingSource = "user" | "project" | "local";
export function userConfigRoot(): string {
  if (process.env.CCR_USER_CONFIG_DIR) return process.env.CCR_USER_CONFIG_DIR;
  let home: string | undefined;
  try {
    home = os.homedir();
  } catch {
    /* user profile unavailable */
  }
  if (!home) return unavailableUserRoot;
  return path.join(
    home,
    process.env.CCR_COMPAT_CLAUDE === "1" ? ".claude" : ".claude-code-replica",
  );
}
// Warn once per file — readSettingsFile runs at several startup phases.
const corruptWarned = new Set<string>();

export function readSettingsFile(file: string): Settings {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {}; // Missing/unreadable file is normal (most sources don't exist).
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) return value;
    throw new Error("top-level value is not an object");
  } catch (error) {
    // Review fix ("损坏 settings 静默吞掉 deny 规则"): a settings file that
    // EXISTS but does not parse used to degrade to {} in silence — its deny
    // rules vanished with no trace (fail-open). Warn loudly; the caller still
    // gets {} (refusing to start over a typo'd settings file is worse UX),
    // but the dropped rules are never silent again.
    if (!corruptWarned.has(file)) {
      corruptWarned.add(file);
      console.error(
        `Warning: settings file ${file} is not valid JSON ` +
          `(${error instanceof Error ? error.message : String(error)}) — ` +
          `ALL its settings, including any permission deny rules, are IGNORED.`,
      );
    }
    return {};
  }
}
/**
 * Like readSettingsFile, but REPORTS corruption instead of degrading to `{}`.
 * Read paths want the lenient behavior (a typo in settings must not stop the
 * CLI); WRITE paths must not: a read-modify-write over a `{}` produced by a
 * corrupt file silently deletes every other key in it (permissions.deny,
 * hooks, …). Persisting a toggle therefore refuses to touch a corrupt file.
 */
export function readSettingsFileStrict(file: string): { value: Settings; corrupt: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { value: {}, corrupt: false }; // missing file is normal
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) return { value, corrupt: false };
  } catch {
    // fall through to the corrupt report below
  }
  return { value: {}, corrupt: true };
}

function isRecord(value: unknown): value is Settings {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Objects merge recursively, array entries accumulate, scalars take the higher-priority value. */
export function mergeSettings(...layers: Settings[]): Settings {
  const merged: Settings = {};
  for (const layer of layers)
    for (const [key, value] of Object.entries(layer)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      const previous = merged[key];
      if (isRecord(value)) merged[key] = mergeSettings(isRecord(previous) ? previous : {}, value);
      else if (Array.isArray(value))
        merged[key] = [...new Set([...(Array.isArray(previous) ? previous : []), ...value])];
      else merged[key] = value;
    }
  return merged;
}
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0
    ? process.argv[index + 1]
    : process.argv.find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function settingSources(): SettingSource[] {
  const value = arg("--setting-sources") ?? process.env.CCR_SETTING_SOURCES;
  return (["user", "project", "local"] as SettingSource[]).filter(
    (source) => value === undefined || value.split(",").includes(source),
  );
}
export function readUserSettings(): Settings {
  return readSettingsFile(path.join(userConfigRoot(), "settings.json"));
}
export function readProjectSettings(root: string): Settings {
  return mergeSettings(
    ...(["project", "local"] as const)
      .filter((source) => settingSources().includes(source))
      .map((source) =>
        readSettingsFile(
          path.join(root, ".claude", source === "local" ? "settings.local.json" : "settings.json"),
        ),
      ),
  );
}
export function readManagedSettings(): Settings {
  const file = process.env.CCR_MANAGED_SETTINGS;
  return file ? readSettingsFile(file) : {};
}
export function readSettings(root: string, sources = settingSources()): Settings {
  const layers = sources.map((source) =>
    readSettingsFile(
      source === "user"
        ? path.join(userConfigRoot(), "settings.json")
        : path.join(root, ".claude", source === "local" ? "settings.local.json" : "settings.json"),
    ),
  );
  const additional = arg("--settings");
  if (additional) {
    if (additional.trim().startsWith("{")) {
      try {
        const value: unknown = JSON.parse(additional);
        if (!isRecord(value)) throw new Error("Expected settings object");
        layers.push(value);
      } catch {
        throw new Error("--settings is not a valid JSON object");
      }
    } else layers.push(readSettingsFile(path.resolve(root, additional)));
  }
  return mergeSettings(...layers, readManagedSettings());
}
