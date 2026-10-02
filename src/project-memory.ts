import * as fs from "node:fs";
import * as path from "node:path";
/** Worktrees use the primary repository's memory rather than isolated copies. */
export function memoryProjectRoot(workspace: string): string {
  try {
    let current = path.resolve(workspace);
    while (true) {
      const git = path.join(current, ".git");
      if (fs.existsSync(git)) {
        if (fs.statSync(git).isDirectory()) return current;
        const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(git, "utf8"));
        if (match) {
          const gitDir = path.resolve(current, match[1]!);
          const common = path.resolve(
            gitDir,
            fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim(),
          );
          if (path.basename(common) === ".git") return path.dirname(common);
        }
        return current;
      }
      if (path.dirname(current) === current) return workspace;
      current = path.dirname(current);
    }
  } catch {
    return workspace;
  }
}
export function memoryIndex(root: string): string {
  const file = path.join(memoryProjectRoot(root), ".claude", "memory", "MEMORY.md");
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(0, 200).join("\n").slice(0, 25000);
  } catch {
    return "";
  }
}
