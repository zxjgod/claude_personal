import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
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
    if (v[key] !== undefined) {
      const p = v[key];
      // `path.isAbsolute("../x")` is false — dot segments must be rejected
      // explicitly or a manifest could stage component files outside the
      // plugin directory (install-time traversal).
      if (
        typeof p !== "string" ||
        path.isAbsolute(p) ||
        p.replace(/\\/g, "/").split("/").includes("..")
      )
        throw new Error(`Invalid plugin path: ${key}`);
    }
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
/**
 * Minimal ZIP extractor: central directory scan + stored/deflate entries —
 * enough for plugin archives without a third-party dependency. Zip64 and
 * path-escaping entries are rejected outright (zip-slip).
 */
/** Per-entry uncompressed cap (declared AND actual — headers can lie). */
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;

export function extractZip(bytes: Buffer, destDir: string): void {
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (i >= 0 && bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid ZIP archive (no end-of-central-directory)");
  const count = bytes.readUInt16LE(eocd + 10);
  let off = bytes.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (off + 46 > bytes.length || bytes.readUInt32LE(off) !== 0x02014b50)
      throw new Error("Corrupt ZIP central directory");
    const method = bytes.readUInt16LE(off + 10);
    const compSize = bytes.readUInt32LE(off + 20);
    const uncompSize = bytes.readUInt32LE(off + 24);
    const nameLen = bytes.readUInt16LE(off + 28);
    const extraLen = bytes.readUInt16LE(off + 30);
    const commentLen = bytes.readUInt16LE(off + 32);
    const localOff = bytes.readUInt32LE(off + 42);
    const name = bytes.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff)
      throw new Error(`Zip64 archives are not supported: ${name}`);
    // Decompression-bomb floor: a plugin is source files — anything declaring
    // (or actually inflating to) more than this is an attack, not a plugin.
    if (uncompSize > MAX_ZIP_ENTRY_BYTES)
      throw new Error(
        `ZIP entry declares ${uncompSize} bytes uncompressed (cap ${MAX_ZIP_ENTRY_BYTES}): ${name}`,
      );
    const parts = name.replace(/\\/g, "/").split("/");
    if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || parts.includes(".."))
      throw new Error(`ZIP entry escapes the plugin directory: ${name}`);
    const target = path.join(destDir, ...parts);
    if (name.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (localOff + 30 > bytes.length || bytes.readUInt32LE(localOff) !== 0x04034b50)
      throw new Error(`Corrupt ZIP local header for ${name}`);
    // The LOCAL header carries its own (possibly different) name/extra lengths.
    const dataStart =
      localOff + 30 + bytes.readUInt16LE(localOff + 26) + bytes.readUInt16LE(localOff + 28);
    const data = bytes.subarray(dataStart, dataStart + compSize);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (method === 0) {
      if (data.length > MAX_ZIP_ENTRY_BYTES)
        throw new Error(`ZIP entry exceeds ${MAX_ZIP_ENTRY_BYTES} bytes: ${name}`);
      fs.writeFileSync(target, data);
    } else if (method === 8) {
      let inflated: Buffer;
      try {
        // maxOutputLength enforces the cap on the ACTUAL inflated size — the
        // declared uncompSize checked above is attacker-controlled and may lie.
        inflated = inflateRawSync(data, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
          throw new Error(`ZIP entry inflates beyond ${MAX_ZIP_ENTRY_BYTES} bytes: ${name}`);
        throw e;
      }
      fs.writeFileSync(target, inflated);
    } else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
  }
}

/**
 * Install a plugin from a URL. Two source shapes are supported:
 *  - a .zip archive (or any URL whose bytes start PK\x03\x04) containing the
 *    whole plugin — plugin.json plus its component dirs;
 *  - a bare plugin.json manifest, whose DECLARED component paths are then
 *    fetched relative to the manifest URL. Before this, only the manifest was
 *    downloaded, so every remote "install" produced metadata whose
 *    skills/commands/agents silently did not exist.
 */
export async function installRemotePlugin(
  workspaceRoot: string,
  source: string,
): Promise<PluginManifest> {
  if (!/^https?:\/\//i.test(source)) throw new Error("Remote plugin source must be an http(s) URL");
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Plugin download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  // Stage under the OS temp dir: pluginRoot() may not exist yet in a fresh
  // workspace, and mkdtempSync there used to ENOENT before install's mkdir ran.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-"));
  try {
    let dir = temp;
    if (bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50) {
      extractZip(bytes, temp);
      // Archives commonly wrap the payload in one top-level folder
      // (Compress-Archive, GitHub codeload) — descend to the dir with plugin.json.
      if (!fs.existsSync(path.join(temp, "plugin.json"))) {
        const sub = fs
          .readdirSync(temp, { withFileTypes: true })
          .find((e) => e.isDirectory() && fs.existsSync(path.join(temp, e.name, "plugin.json")));
        if (!sub) throw new Error("ZIP archive contains no plugin.json");
        dir = path.join(temp, sub.name);
      }
    } else {
      const manifest = validatePluginManifest(JSON.parse(bytes.toString("utf8")));
      fs.writeFileSync(path.join(temp, "plugin.json"), bytes);
      for (const key of ["skills", "commands", "agents", "hooks", "mcp"] as const) {
        const rel = manifest[key];
        if (!rel) continue;
        try {
          const r = await fetch(new URL(rel, source));
          if (!r.ok) continue;
          // A DIRECTORY-typed component (e.g. "skills/") can't be fetched as
          // one file — 404 lands here and the install stays manifest-only for
          // that component. Ship a zip to cover directory components.
          const target = path.join(temp, ...rel.replace(/\\/g, "/").split("/"));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, Buffer.from(await r.arrayBuffer()));
        } catch {
          /* best effort — see comment above */
        }
      }
    }
    return installPlugin(workspaceRoot, dir);
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

/**
 * Fetch a remote marketplace index ({ plugins: [manifest + source] }) and
 * persist it via writeMarketplace. Entries that fail validation are dropped
 * rather than aborting the whole add.
 */
export async function addMarketplaceFromUrl(
  workspaceRoot: string,
  url: string,
): Promise<MarketplaceIndex> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Marketplace URL must be an http(s) URL");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Marketplace fetch failed: HTTP ${response.status}`);
  const value = (await response.json()) as { plugins?: unknown[] };
  const plugins: MarketplaceIndex["plugins"] = [];
  for (const entry of Array.isArray(value.plugins) ? value.plugins : []) {
    const source = (entry as { source?: unknown })?.source;
    if (typeof source !== "string") continue;
    try {
      plugins.push({ ...validatePluginManifest(entry), source });
    } catch {
      /* invalid entry — skip */
    }
  }
  writeMarketplace(workspaceRoot, { plugins });
  return { plugins };
}

/** Look up a plugin by name in the workspace marketplace index. */
export function findMarketplacePlugin(
  workspaceRoot: string,
  name: string,
): (PluginManifest & { source: string }) | undefined {
  return readMarketplace(workspaceRoot).plugins.find((p) => p.name === name);
}
