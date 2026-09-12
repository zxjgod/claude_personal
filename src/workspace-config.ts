import * as path from "node:path";

/** All CCR-owned configuration lives inside the current workspace `.claude`. */
export function ccrConfigRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude");
}
export function ccrPath(workspaceRoot: string, ...parts: string[]): string {
  return path.join(ccrConfigRoot(workspaceRoot), ...parts);
}
