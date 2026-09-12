import * as fs from "node:fs";
import * as path from "node:path";
import { ccrPath } from "./workspace-config.js";

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  dependencies?: Record<string, string>;
  skills?: string;
  commands?: string;
  agents?: string;
  hooks?: string;
  mcp?: string;
  disabled?: boolean;
}
export interface MarketplaceIndex {
  plugins: Array<PluginManifest & { source: string }>;
}
export function pluginRoot(workspaceRoot: string): string {
  return ccrPath(workspaceRoot, "plugins");
}
export function marketplacePath(workspaceRoot: string): string {
  return ccrPath(workspaceRoot, "marketplace.json");
}
function validName(x: unknown): x is string {
  return typeof x === "string" && /^[A-Za-z0-9_-]+$/.test(x);
}
function validVersion(x: unknown): x is string {
  return typeof x === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(x);
}
export function validatePluginManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== "object") throw new Error("Plugin manifest must be an object");
  const v = value as Partial<PluginManifest>;
  if (!validName(v.name)) throw new Error("Invalid plugin name");
  if (!validVersion(v.version)) throw new Error("Plugin version must use semver (x.y.z)");
  for (const key of ["skills", "commands", "agents", "hooks", "mcp"] as const)
    if (v[key] !== undefined && (typeof v[key] !== "string" || path.isAbsolute(v[key])))
      throw new Error(`Invalid plugin path: ${key}`);
  return { ...v, name: v.name, version: v.version, disabled: v.disabled === true };
}
function readManifest(dir: string): PluginManifest | null {
  try {
    return validatePluginManifest(
      JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8")),
    );
  } catch {
    return null;
  }
}
export function listPlugins(workspaceRoot: string): PluginManifest[] {
  try {
    return fs
      .readdirSync(pluginRoot(workspaceRoot), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readManifest(path.join(pluginRoot(workspaceRoot), e.name)))
      .filter((x): x is PluginManifest => x !== null);
  } catch {
    return [];
  }
}
export function pluginDirs(workspaceRoot: string): string[] {
  return listPlugins(workspaceRoot)
    .filter((p) => !p.disabled)
    .map((p) => path.join(pluginRoot(workspaceRoot), p.name));
}
export function installPlugin(workspaceRoot: string, sourceDir: string): PluginManifest {
  const manifest = readManifest(sourceDir);
  if (!manifest) throw new Error("Invalid or missing plugin.json");
  fs.mkdirSync(pluginRoot(workspaceRoot), { recursive: true });
  fs.cpSync(sourceDir, path.join(pluginRoot(workspaceRoot), manifest.name), {
    recursive: true,
    force: true,
  });
  return manifest;
}
export async function installRemotePlugin(
  workspaceRoot: string,
  source: string,
): Promise<PluginManifest> {
  if (!/^https?:\/\//i.test(source)) throw new Error("Remote plugin source must be an http(s) URL");
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Plugin download failed: HTTP ${response.status}`);
  const temp = fs.mkdtempSync(path.join(pluginRoot(workspaceRoot), ".download-"));
  try {
    fs.writeFileSync(path.join(temp, "plugin.json"), await response.text());
    return installPlugin(workspaceRoot, temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
export function removePlugin(workspaceRoot: string, name: string): void {
  if (!validName(name)) throw new Error("Invalid plugin name");
  fs.rmSync(path.join(pluginRoot(workspaceRoot), name), { recursive: true, force: true });
}
export function setPluginDisabled(
  workspaceRoot: string,
  name: string,
  disabled: boolean,
): PluginManifest {
  const dir = path.join(pluginRoot(workspaceRoot), name);
  const m = readManifest(dir);
  if (!m) throw new Error(`Plugin not found: ${name}`);
  m.disabled = disabled;
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(m, null, 2));
  return m;
}
export function checkPluginDependencies(workspaceRoot: string): string[] {
  const installed = new Map(listPlugins(workspaceRoot).map((p) => [p.name, p.version]));
  const errors: string[] = [];
  for (const plugin of listPlugins(workspaceRoot)) {
    for (const [name, required] of Object.entries(plugin.dependencies ?? {})) {
      const actual = installed.get(name);
      if (!actual) errors.push(`${plugin.name} requires ${name}@${required}`);
      else if (/^\d+\.\d+\.x$/.test(required) && !actual.startsWith(required.slice(0, -1)))
        errors.push(`${plugin.name} requires ${name}@${required}, found ${actual}`);
    }
  }
  return errors;
}
export function readMarketplace(workspaceRoot: string): MarketplaceIndex {
  try {
    const v = JSON.parse(fs.readFileSync(marketplacePath(workspaceRoot), "utf8"));
    return {
      plugins: Array.isArray(v.plugins)
        ? v.plugins.filter((p: unknown) => {
            try {
              validatePluginManifest(p);
              return true;
            } catch {
              return false;
            }
          })
        : [],
    };
  } catch {
    return { plugins: [] };
  }
}
export function writeMarketplace(workspaceRoot: string, index: MarketplaceIndex): void {
  fs.mkdirSync(path.dirname(marketplacePath(workspaceRoot)), { recursive: true });
  fs.writeFileSync(marketplacePath(workspaceRoot), JSON.stringify(index, null, 2));
}
