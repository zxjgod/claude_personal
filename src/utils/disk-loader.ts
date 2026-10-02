import * as fs from "node:fs";
import * as path from "node:path";

/** A parsed disk entry ready for a source-specific registrar. */
export interface DiskEntry {
  root: string;
  dirent: fs.Dirent;
  name: string;
  file: string;
  raw: string;
}

export interface DiskLoaderOptions<T> {
  recursive?: boolean;
  /** Internal shared registry for recursive duplicate diagnostics. */
  seenNames?: Set<string>;
  roots: string[];
  accepts: (entry: fs.Dirent) => boolean;
  nameOf: (entry: fs.Dirent) => string | undefined;
  fileOf: (root: string, entry: fs.Dirent) => string;
  parse: (entry: DiskEntry) => T | undefined;
  register: (value: T) => void;
  loadedName?: (value: T, entry: DiskEntry) => string;
}

/**
 * Shared scan/read/register skeleton for disk-backed commands, skills, and
 * agents. Roots are visited in precedence order: later roots override earlier
 * registrations in the source-specific registry.
 */
export function loadDiskEntries<T>(options: DiskLoaderOptions<T>): string[] {
  const loaded: string[] = [];
  const names = options.seenNames ?? new Set<string>();

  for (const root of options.roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(root, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name, "en"));
    } catch {
      continue;
    }

    for (const dirent of entries) {
      if (options.recursive && dirent.isDirectory()) {
        loaded.push(
          ...loadDiskEntries({
            ...options,
            roots: [path.join(root, dirent.name)],
            seenNames: names,
          }),
        );
        continue;
      }
      if (!options.accepts(dirent)) continue;
      const name = options.nameOf(dirent);
      if (!name) continue;
      const file = options.fileOf(root, dirent);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }

      const entry: DiskEntry = { root, dirent, name, file: path.resolve(file), raw };
      let value: T | undefined;
      try {
        value = options.parse(entry);
      } catch (error) {
        console.warn(`Skipped invalid extension ${file}: ${String(error)}`);
        continue;
      }
      if (value === undefined) continue;
      const registeredName = options.loadedName?.(value, entry) ?? name;
      if (names.has(registeredName))
        console.warn(
          `Duplicate extension name ${registeredName} at ${file}; overriding with deterministic directory precedence`,
        );
      names.add(registeredName);
      options.register(value);
      loaded.push(options.loadedName?.(value, entry) ?? name);
    }
  }

  return loaded;
}
