// ============================================================
// Glob Tool
// ============================================================

import * as path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

const GlobSchema = z.strictObject({
  pattern: z.string().describe("Glob pattern, e.g. '**/*.ts' or 'src/**/*.test.ts'"),
  path: z.string().optional().describe("Directory to search in (default: workspace root)"),
});
type GlobInput = z.infer<typeof GlobSchema>;

export const GlobTool: Tool = buildTool({
  name: "glob",
  description: "Find files matching a glob pattern",
  promptDescription:
    "Find files matching a glob pattern. Parameters: pattern (required, glob pattern like '**/*.ts'), " +
    "path (optional, directory to search in, defaults to workspace root). " +
    "Returns a sorted list of matching file paths, one per line. " +
    "Example patterns: '**/*.ts', 'src/**/*.test.ts', '*.json'",
  schema: GlobSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: "glob find files pattern match search",

  async call(input, context): Promise<ToolResult> {
    const searchDir = input.path
      ? path.resolve(context.workspaceRoot, input.path)
      : context.workspaceRoot;

    try {
      const files = await fg(input.pattern, {
        cwd: searchDir,
        ignore: ["**/node_modules/**", "**/.git/**"],
        absolute: false,
        dot: false,
      });

      const MAX_RESULTS = 500;
      const truncated = files.length > MAX_RESULTS;
      const resultFiles = files.slice(0, MAX_RESULTS);
      // Sort for deterministic output
      resultFiles.sort();

      const content =
        resultFiles.length === 0 ? "No files found matching pattern." : resultFiles.join("\n");

      return {
        content,
        truncated,
        metadata: { linesRead: resultFiles.length },
      };
    } catch (error: any) {
      return {
        content: "",
        error: `Error searching files: ${error.message}`,
      };
    }
  },

  async checkPermissions(_input, _context) {
    return { allowed: true }; // Read-only
  },
});
