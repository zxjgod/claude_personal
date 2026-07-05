// ============================================================
// Grep Tool
// ============================================================

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

const execFileAsync = promisify(execFile);

const GrepSchema = z.strictObject({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z.string().optional().describe("Directory or file to search (default: workspace root)"),
  include: z.string().optional().describe("File pattern filter, e.g. '*.ts'"),
});
type GrepInput = z.infer<typeof GrepSchema>;

export const GrepTool: Tool = buildTool({
  name: "grep",
  description: "Search file contents with regex",
  promptDescription:
    "Search file contents with regex pattern. Uses ripgrep if available, falls back to Node.js.",
  schema: GrepSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    const searchDir = input.path
      ? path.resolve(context.workspaceRoot, input.path)
      : context.workspaceRoot;

    // Try ripgrep first, fall back to Node.js
    try {
      // Build the rg invocation as an argv array passed to execFile rather
      // than a shell-quoted string. The old code used Unix single-quotes
      // (`--glob '*.ts'`, `'${pattern}'`) which are not valid quoting under
      // cmd.exe — the project's primary shell on Windows — so the main rg
      // path was effectively broken there and silently fell back. execFile
      // passes args verbatim with no shell, so the same argv works on every
      // platform and there is no injection surface to worry about.
      const argv = [
        "rg",
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--glob",
        "!node_modules",
        "--glob",
        "!.git",
      ];
      if (input.include) {
        argv.push("--glob", input.include);
      }
      argv.push(input.pattern, searchDir);

      const { stdout } = await execFileAsync(argv[0]!, argv.slice(1), {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
        signal: context.abortSignal, // Ctrl+C 中断时杀死 ripgrep 子进程
      });

      const lines = stdout.trim().split("\n").filter(Boolean);
      const MAX_RESULTS = 250;
      const truncated = lines.length > MAX_RESULTS;

      if (lines.length === 0) {
        return { content: "No matches found." };
      }

      return {
        content: lines.slice(0, MAX_RESULTS).join("\n"),
        truncated,
        metadata: { linesRead: Math.min(lines.length, MAX_RESULTS) },
      };
    } catch (error: any) {
      // 中断时 ripgrep 子进程被杀
      if (error.name === "AbortError" || context.abortSignal?.aborted) {
        return { content: "Search aborted.", metadata: { aborted: true } };
      }
      // rg not found or error — fall back
      if (error.code === 1 && error.stdout === "") {
        return { content: "No matches found." };
      }

      try {
        // Fallback: use fast-glob + manual regex search
        const pattern = input.include || "**/*";
        const files = await fg(pattern, {
          cwd: searchDir,
          ignore: ["**/node_modules/**", "**/.git/**"],
          absolute: true,
        });

        const results: string[] = [];
        const regex = new RegExp(input.pattern, "gi");

        for (const file of files.slice(0, 100)) {
          try {
            const stat = fs.statSync(file);
            if (stat.isDirectory() || stat.size > 1024 * 1024) continue;

            const content = fs.readFileSync(file, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                const relPath = path.relative(context.workspaceRoot, file);
                results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                regex.lastIndex = 0; // Reset
              }
            }
          } catch {
            // Skip unreadable files
          }
        }

        const MAX_RESULTS = 250;
        const truncated = results.length > MAX_RESULTS;

        if (results.length === 0) {
          return { content: "No matches found." };
        }

        return {
          content: results.slice(0, MAX_RESULTS).join("\n"),
          truncated,
          metadata: { linesRead: Math.min(results.length, MAX_RESULTS) },
        };
      } catch (fallbackError: any) {
        return {
          content: "",
          error: `Error searching: ${fallbackError.message}`,
        };
      }
    }
  },

  async checkPermissions(_input, _context) {
    return { allowed: true }; // Read-only
  },
});
