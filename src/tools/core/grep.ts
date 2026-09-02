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
import { resolveInWorkspace } from "../utils/path.js";

const execFileAsync = promisify(execFile);

const DEFAULT_HEAD_LIMIT = 250;

// Packaged ripgrep binary (M37). `@vscode/ripgrep` is a thin shim that resolves
// the correct per-platform binary from an optional dependency and exports its
// absolute path as `rgPath`. It THROWS when that platform package is absent,
// which callers treat as "no rg available" → the Node.js fallback runs instead.
// Memoized so the (lazy) dynamic import happens once per process, not per call.
let rgPathPromise: Promise<string> | undefined;

async function resolveRgPath(): Promise<string> {
  rgPathPromise ??= import("@vscode/ripgrep").then((m) => m.rgPath);
  return rgPathPromise;
}

const GrepSchema = z.strictObject({
  pattern: z.string().describe("The regular expression pattern to search for in file contents"),
  path: z.string().optional().describe("File or directory to search in (default: workspace root)"),
  type: z.string().optional().describe("File type to search (e.g. 'js', 'ts', 'py', 'rust')"),
  "-i": z.boolean().optional().describe("Case-insensitive search (default: false)"),
  "-A": z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Number of lines to show after each match (rg -A)"),
  "-B": z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Number of lines to show before each match (rg -B)"),
  "-C": z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Number of lines to show before and after each match (rg -C)"),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      "Output mode: content (default), files_with_matches (file paths only), or count (per-file match counts)",
    ),
  head_limit: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe(`Limit output to first N lines (default: ${DEFAULT_HEAD_LIMIT})`),
  "-n": z.boolean().optional().describe("Show line numbers (default: true)"),
  "-o": z.boolean().optional().describe("Only output the matching part of each line"),
  "-e": z.boolean().optional().describe("Extended regex (PCRE2 features like lookahead)"),
  multiline: z.boolean().optional().describe("Multiline mode (^ and $ match line boundaries)"),
  glob: z.string().optional().describe("Glob pattern to filter files (e.g. '*.ts')"),
  /** Deprecated alias for `glob`, retained for back-compat. */
  include: z.string().optional().describe("Deprecated alias for glob"),
});
type GrepInput = z.infer<typeof GrepSchema>;

// rg has no "--no-..." spelling for `-e`/`-o`; these are pure add-ons.
// `type` maps to `--type <t>`, which relies on rg's built-in type table.
const TYPE_GLOB: Record<string, string> = {
  js: "**/*.{js,jsx,mjs,cjs}",
  ts: "**/*.{ts,tsx,mts,cts}",
  py: "**/*.py",
  rust: "**/*.rs",
  go: "**/*.go",
  json: "**/*.json",
  md: "**/*.md",
  sh: "**/*.sh",
  css: "**/*.css",
  html: "**/*.html",
};

function summarize(mode: GrepInput["output_mode"], count: number): string {
  if (mode === "files_with_matches" || mode === "count") {
    return count === 1 ? "1 file" : `${count} files`;
  }
  return count === 1 ? "1 match" : `${count} matches`;
}

export const GrepTool: Tool = buildTool({
  name: "grep",
  description: "Search file contents with regex",
  promptDescription:
    "Search file contents with a regex pattern. Uses ripgrep (fast, respects .gitignore). " +
    "Parameters: pattern (required, regex), path (optional, file or dir, default workspace root), " +
    "type (optional, file type like 'js'/'py'), -i (case-insensitive), -A/-B/-C (context lines), " +
    "output_mode (content | files_with_matches | count), head_limit (default 250), " +
    "-n (line numbers, default true), -o (only matching part), -e (extended regex), " +
    "multiline (^/$ match lines), glob (file filter like '*.ts'). " +
    "Returns matching lines as 'path:line:content'.",
  schema: GrepSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: "grep search regex content find text rg",

  async call(input, context): Promise<ToolResult> {
    // Resolve `path` through the workspace containment check so an absolute
    // path cannot override the workspace root and search/read files outside it.
    let searchDir: string;
    if (input.path) {
      const resolution = resolveInWorkspace(input.path, context.workspaceRoot);
      if (!resolution.ok) {
        return { content: "", error: resolution.error };
      }
      searchDir = resolution.path;
    } else {
      searchDir = context.workspaceRoot;
    }

    // Prefer ripgrep (fast, gitignore-aware); fall back to a Node.js scan.
    try {
      return await runRipgrep(input, searchDir, context.abortSignal);
    } catch (error) {
      const execError = error as Record<string, unknown>;
      // Interrupt: ripgrep subprocess was killed. Do not fall back.
      if (execError.name === "AbortError" || context.abortSignal?.aborted) {
        return { content: "Search aborted.", metadata: { aborted: true } };
      }
      // rg exit code 1 with empty stdout means "no matches" (not an error).
      if (execError.code === 1 && execError.stdout === "") {
        return { content: "No matches found.", metadata: { linesRead: 0, summary: "No matches" } };
      }
      // rg missing (ENOENT), invalid regex, or any other error → Node.js fallback.
      return runNodeFallback(input, searchDir, context);
    }
  },

  async checkPermissions(_input, _context) {
    return { allowed: true }; // Read-only
  },
});

async function runRipgrep(
  input: GrepInput,
  searchDir: string,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  // Resolve the PACKAGED ripgrep binary instead of a host `rg` on PATH. This
  // removes the hidden host dependency, fixes the old path's cmd.exe quoting
  // breakage on Windows, and keeps the whole search as a direct argv → execFile
  // call (no shell layer, no injection surface). If the platform binary is
  // unavailable (optionalDependencies missing), this throws and the caller
  // falls back to runNodeFallback.
  let rgPath: string;
  try {
    rgPath = await resolveRgPath();
  } catch {
    throw new Error("packaged ripgrep binary unavailable for this platform");
  }

  // Build the rg invocation as an argv array passed to execFile rather than a
  // shell-quoted string. The old code used Unix single-quotes (`--glob '*.ts'`,
  // `'${pattern}'`) which are not valid quoting under cmd.exe — the project's
  // primary shell on Windows — so the main rg path was effectively broken there
  // and silently fell back. execFile passes args verbatim with no shell, so the
  // same argv works on every platform and there is no injection surface.
  const argv = [
    rgPath,
    "--no-config",
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--glob",
    "!node_modules",
    "--glob",
    "!.git",
  ];

  if (input["-i"]) argv.push("-i");
  if (input["-A"] != null) argv.push("-A", String(input["-A"]));
  if (input["-B"] != null) argv.push("-B", String(input["-B"]));
  if (input["-C"] != null) argv.push("-C", String(input["-C"]));
  if (input["-n"] === false) argv.push("--no-line-number");
  if (input["-o"]) argv.push("--only-matching");
  if (input["-e"]) argv.push("--pcre2");
  if (input.multiline) argv.push("--multiline");
  if (input.type) argv.push("--type", input.type);

  switch (input.output_mode) {
    case "files_with_matches":
      argv.push("--files-with-matches");
      break;
    case "count":
      argv.push("--count");
      break;
    default:
      break;
  }

  // `glob` is the canonical filter; `include` is a deprecated alias.
  const fileFilter = input.glob ?? input.include;
  if (fileFilter) argv.push("--glob", fileFilter);

  // `--` terminates option parsing, so a pattern beginning with `-` (e.g.
  // "-foo", "-\d+") is treated as the regex, not a ripgrep flag.
  argv.push("--", input.pattern, searchDir);

  const { stdout } = await execFileAsync(argv[0]!, argv.slice(1), {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    signal: abortSignal, // Ctrl+C kills the ripgrep child process
  });

  const rawLines = stdout.trim().split("\n").filter(Boolean);
  const headLimit = input.head_limit ?? DEFAULT_HEAD_LIMIT;
  const truncated = rawLines.length > headLimit;
  const lines = rawLines.slice(0, headLimit);

  if (lines.length === 0) {
    return { content: "No matches found.", metadata: { linesRead: 0, summary: "No matches" } };
  }

  return {
    content: lines.join("\n"),
    truncated,
    metadata: {
      linesRead: lines.length,
      summary: summarize(input.output_mode, rawLines.length),
    },
  };
}

async function runNodeFallback(
  input: GrepInput,
  searchDir: string,
  context: { workspaceRoot: string },
): Promise<ToolResult> {
  // Fallback: fast-glob + manual regex search, honoring the common options.
  // A `glob`/`include` filter wins over `type` when both are given (the model
  // rarely passes both; rg already handles the combination exactly).
  const patterns: string[] = [];
  if (input.glob || input.include) patterns.push(input.glob ?? input.include!);
  else if (input.type && TYPE_GLOB[input.type]) patterns.push(TYPE_GLOB[input.type]!);
  if (patterns.length === 0) patterns.push("**/*");

  const files = await fg(patterns, {
    cwd: searchDir,
    ignore: ["**/node_modules/**", "**/.git/**"],
    absolute: true,
    onlyFiles: true,
  });

  if (input["-e"]) {
    return {
      content: "",
      error: "Extended PCRE2 search is unavailable without ripgrep.",
    };
  }
  const flags = input["-i"] ? (input.multiline ? "gim" : "gi") : input.multiline ? "gm" : "g";
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, flags);
  } catch {
    return { content: "", error: `Invalid regex pattern: ${input.pattern}` };
  }

  const headLimit = input.head_limit ?? DEFAULT_HEAD_LIMIT;
  const results: string[] = [];
  const fileMatchCount = new Map<string, number>();

  for (const file of files) {
    if (results.length >= headLimit) break;
    try {
      const stat = fs.statSync(file);
      if (stat.isDirectory() || stat.size > 1024 * 1024) continue;

      const content = fs.readFileSync(file, "utf-8");
      const contentLines = content.split("\n");
      const relPath = path.relative(context.workspaceRoot, file);

      const contextBefore = input["-B"] ?? input["-C"] ?? 0;
      const contextAfter = input["-A"] ?? input["-C"] ?? 0;
      // Honor -n:false (suppress line numbers) and -o (only matching substrings).
      const showLineNum = input["-n"] !== false;
      const onlyRegex = input["-o"] ? new RegExp(input.pattern, flags) : null;

      for (let i = 0; i < contentLines.length; i++) {
        const line = contentLines[i]!;
        regex.lastIndex = 0;
        if (!regex.test(line)) continue;
        if (input.output_mode === "files_with_matches") {
          fileMatchCount.set(relPath, 1);
          continue;
        }
        if (input.output_mode === "count") {
          fileMatchCount.set(relPath, (fileMatchCount.get(relPath) ?? 0) + 1);
          continue;
        }
        if (onlyRegex) {
          // -o: emit each matching substring (context lines are not emitted with
          // -o; they would duplicate the match on the same line).
          let m = onlyRegex.exec(line);
          while (m !== null) {
            results.push(showLineNum ? `${relPath}:${i + 1}:${m[0]}` : m[0]);
            if (m.index === onlyRegex.lastIndex) onlyRegex.lastIndex++;
            if (results.length >= headLimit) break;
            m = onlyRegex.exec(line);
          }
        } else {
          // content mode: emit match lines with optional context
          const start = Math.max(0, i - contextBefore);
          const end = Math.min(contentLines.length - 1, i + contextAfter);
          for (let j = start; j <= end; j++) {
            const sep = j === i ? ":" : "-";
            const prefix = showLineNum ? `${relPath}:${j + 1}${sep}` : "";
            results.push(`${prefix}${contentLines[j]!.trim()}`);
          }
        }
        if (results.length >= headLimit) break;
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (input.output_mode === "files_with_matches") {
    const filesOut = [...fileMatchCount.keys()];
    return {
      content: filesOut.length === 0 ? "No matches found." : filesOut.join("\n"),
      truncated: filesOut.length > headLimit,
      metadata: {
        linesRead: filesOut.length,
        summary: summarize("files_with_matches", filesOut.length),
      },
    };
  }
  if (input.output_mode === "count") {
    const counts = [...fileMatchCount.entries()].map(([f, n]) => `${f}:${n}`);
    return {
      content: counts.length === 0 ? "No matches found." : counts.join("\n"),
      truncated: counts.length > headLimit,
      metadata: { linesRead: counts.length, summary: summarize("count", counts.length) },
    };
  }

  const truncated = results.length > headLimit;
  const clipped = results.slice(0, headLimit);
  if (clipped.length === 0) {
    return { content: "No matches found.", metadata: { linesRead: 0, summary: "No matches" } };
  }
  return {
    content: clipped.join("\n"),
    truncated,
    metadata: { linesRead: clipped.length, summary: summarize("content", results.length) },
  };
}
