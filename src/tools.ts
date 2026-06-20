// ============================================================
// Core Tools — Read, Write, Edit, Bash, Glob, Grep
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { createTool } from "./tool-registry.js";
import {
  checkDangerousPattern,
  isBlockedPath,
} from "./permissions.js";
import { TodoTool } from "./todo-tool.js";
import { WebFetchTool } from "./web-fetch.js";
import { WebSearchTool } from "./web-search.js";
import { TaskTool } from "./task-tool.js";
import {
  markRead,
  checkReadBeforeEdit,
  refreshRead,
} from "./read-tracker.js";
import { recordChange } from "./change-tracker.js";
import { NotebookEditTool, LspDiagnosticsTool } from "./tools-m8.js";
import {
  EnterPlanModeTool,
  ExitPlanModeTool,
  AskUserQuestionTool,
} from "./tools-m8-interactive.js";
import { TEAM_TOOLS } from "./tools-team.js";

const execAsync = promisify(exec);

// --- Input type definitions for each tool ---

interface ReadInput {
  filePath: string;
  offset?: number;
  limit?: number;
  [key: string]: unknown;
}

interface WriteInput {
  filePath: string;
  content: string;
  [key: string]: unknown;
}

interface EditInput {
  filePath: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  [key: string]: unknown;
}

interface BashInput {
  command: string;
  description: string;
  timeout?: number;
  [key: string]: unknown;
}

interface GlobInput {
  pattern: string;
  path?: string;
  [key: string]: unknown;
}

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
  [key: string]: unknown;
}

// ============================================================
// Read Tool
// ============================================================

export const ReadTool: Tool = createTool<ReadInput>({
  name: "read",
  description: "Read a file from the local filesystem",
  promptDescription:
    "Read a file from the local filesystem. Returns text content with line numbers. " +
    "Images (PNG/JPG/GIF/WebP) and PDFs are returned as visual content blocks you can see directly.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "The absolute path to the file to read",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-based)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read",
      },
    },
    required: ["filePath"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    const resolution = resolveInWorkspace(input.filePath, context.workspaceRoot);
    if (!resolution.ok) {
      return { content: "", error: resolution.error };
    }
    const filePath = resolution.path;

    if (isBlockedPath(filePath)) {
      return {
        content: "",
        error: `Access denied: "${input.filePath}" is a blocked path`,
      };
    }

    try {
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        return {
          content: "",
          error: `"${input.filePath}" is a directory, not a file`,
        };
      }

      // Check for binary files
      const buffer = fs.readFileSync(filePath);

      // Images and PDFs return as multimodal content blocks.
      const mediaType = imageMediaType(filePath);
      if (mediaType) {
        if (stat.size > MAX_IMAGE_BYTES) {
          return {
            content: `[Image too large to load: ${input.filePath} (${stat.size} bytes, max ${MAX_IMAGE_BYTES})]`,
            metadata: { fileSize: stat.size },
          };
        }
        markRead(context.sessionId, filePath, stat.mtimeMs);
        return {
          content: `[Loaded ${mediaType}: ${input.filePath}]`,
          metadata: { fileSize: stat.size },
          images: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: buffer.toString("base64"),
              },
            },
          ],
        };
      }

      if (isBinary(buffer)) {
        markRead(context.sessionId, filePath, stat.mtimeMs);
        return {
          content: `[Binary file: ${filePath}]`,
          metadata: { fileSize: stat.size },
        };
      }

      let lines = buffer.toString("utf-8").split("\n");
      const totalLines = lines.length;

      // Apply offset and limit
      const start = (input.offset ?? 1) - 1;
      const end = input.limit ? start + input.limit : Math.min(start + 2000, totalLines);
      lines = lines.slice(start, end);

      // Add line numbers (4-space padded)
      const numbered = lines
        .map((line, i) => {
          const num = String(start + i + 1).padStart(4, " ");
          return `${num}: ${line}`;
        })
        .join("\n");

      const truncated = end < totalLines;

      markRead(context.sessionId, filePath, stat.mtimeMs);

      return {
        content: numbered,
        truncated,
        metadata: {
          linesRead: lines.length,
          fileSize: stat.size,
        },
      };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return { content: "", error: `File not found: "${input.filePath}"` };
      }
      return {
        content: "",
        error: `Error reading file: ${error.message}`,
      };
    }
  },

  async checkPermissions(_input, _context) {
    return { allowed: true }; // Read-only, always allowed
  },
});

// ============================================================
// Write Tool
// ============================================================

export const WriteTool: Tool = createTool<WriteInput>({
  name: "write",
  description: "Create or overwrite a file",
  promptDescription:
    "Create or overwrite a file. Creates parent directories automatically.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "The absolute path where to write the file",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["filePath", "content"],
  },
  isReadOnly: false,
  isConcurrencySafe: false, // Same file writes must be serial

  async call(input, context): Promise<ToolResult> {
    const resolution = resolveInWorkspace(input.filePath, context.workspaceRoot);
    if (!resolution.ok) {
      return { content: "", error: resolution.error };
    }
    const filePath = resolution.path;

    if (isBlockedPath(filePath)) {
      return {
        content: "",
        error: `Access denied: "${input.filePath}" is a blocked path`,
      };
    }

    try {
      // Create parent directories
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });

      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, input.content, "utf-8");

      const size = Buffer.byteLength(input.content, "utf-8");
      const action = existed ? "Updated" : "Created";

      recordChange(
        context.sessionId,
        relForDisplay(filePath, context.workspaceRoot),
        existed ? "modified" : "created",
        formatSize(size),
      );

      return {
        content: `${action} file: ${input.filePath} (${formatSize(size)})`,
        metadata: { fileSize: size },
      };
    } catch (error: any) {
      return {
        content: "",
        error: `Error writing file: ${error.message}`,
      };
    }
  },

  async checkPermissions(input, context) {
    const danger = checkDangerousPattern(
      "write",
      input,
      context.workspaceRoot,
    );
    if (danger.dangerous) {
      return { allowed: false, reason: danger.reason! };
    }
    return { allowed: true };
  },
});

// ============================================================
// Edit Tool (Search/Replace — the most critical tool!)
// ============================================================

export const EditTool: Tool = createTool<EditInput>({
  name: "edit",
  description: "Make precise edits using search/replace",
  promptDescription:
    "Make precise edits using search/replace. old_string must match exactly including whitespace and indentation. If not unique, add more surrounding context lines.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "The absolute path to the file to edit",
      },
      old_string: {
        type: "string",
        description:
          "The text to replace. Must match EXACTLY including whitespace and indentation. If not unique, add more surrounding context lines.",
      },
      new_string: {
        type: "string",
        description:
          "The text to replace it with. Use empty string to delete.",
      },
      replace_all: {
        type: "boolean",
        description:
          "Replace every occurrence of old_string instead of requiring a unique match. Defaults to false.",
      },
    },
    required: ["filePath", "old_string", "new_string"],
  },
  isReadOnly: false,
  isConcurrencySafe: false, // Same file edits must be serial

  async call(input, context): Promise<ToolResult> {
    const resolution = resolveInWorkspace(input.filePath, context.workspaceRoot);
    if (!resolution.ok) {
      return { content: "", error: resolution.error };
    }
    const filePath = resolution.path;

    if (isBlockedPath(filePath)) {
      return {
        content: "",
        error: `Access denied: "${input.filePath}" is a blocked path`,
      };
    }

    try {
      const statBefore = statMtimeMs(filePath);
      const gate = checkReadBeforeEdit(context.sessionId, filePath, statBefore);
      if (!gate.ok) {
        return { content: "", error: gate.reason! };
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const oldStr = input.old_string;
      const newStr = input.new_string;
      const replaceAll = input.replace_all === true;

      // Count occurrences
      let count = 0;
      let pos = 0;
      while ((pos = content.indexOf(oldStr, pos)) !== -1) {
        count++;
        pos += oldStr.length;
      }

      if (count === 0) {
        return {
          content: "",
          error:
            `old_string not found in file. Tip: re-read the file to ensure ` +
            `exact whitespace and indentation match.`,
        };
      }

      if (count > 1 && !replaceAll) {
        return {
          content: "",
          error:
            `Found ${count} matches for old_string. Provide more surrounding ` +
            `context lines to make the match unique, or set replace_all: true.`,
        };
      }

      // Replace via index-based splicing instead of String.replace, which
      // would interpret special patterns ($&, $1, $`, $') in new_string and
      // silently corrupt the content.
      let newContent: string;
      if (replaceAll) {
        newContent = spliceAll(content, oldStr, newStr);
      } else {
        const idx = content.indexOf(oldStr);
        newContent =
          content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
      }
      fs.writeFileSync(filePath, newContent, "utf-8");

      // Keep the read tracker current so chained edits don't trip the gate.
      const after = statMtimeMs(filePath);
      if (after !== undefined) refreshRead(context.sessionId, filePath, after);

      // Generate a simple diff
      const diff = generateSimpleDiff(oldStr, newStr);
      const summary = replaceAll
        ? `Edit applied to ${input.filePath} (${count} occurrence${count > 1 ? "s" : ""}):`
        : `Edit applied to ${input.filePath}:`;
      recordChange(
        context.sessionId,
        relForDisplay(filePath, context.workspaceRoot),
        "modified",
        diff,
      );
      return {
        content: `${summary}\n${diff}`,
        metadata: { fileSize: Buffer.byteLength(newContent, "utf-8") },
      };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return { content: "", error: `File not found: "${input.filePath}"` };
      }
      return {
        content: "",
        error: `Error editing file: ${error.message}`,
      };
    }
  },

  async checkPermissions(input, context) {
    const danger = checkDangerousPattern(
      "edit",
      input,
      context.workspaceRoot,
    );
    if (danger.dangerous) {
      return { allowed: false, reason: danger.reason! };
    }
    return { allowed: true };
  },
});

// ============================================================
// MultiEdit Tool — atomic batch edits on a single file
// ============================================================

interface MultiEditOp {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface MultiEditInput {
  filePath: string;
  edits: MultiEditOp[];
  [key: string]: unknown;
}

export const MultiEditTool: Tool = createTool<MultiEditInput>({
  name: "multi_edit",
  description: "Apply multiple search/replace edits to a single file atomically",
  promptDescription:
    "Apply multiple search/replace edits to ONE file in a single atomic operation. " +
    "Provide filePath and edits (an array of {old_string, new_string, replace_all?}). " +
    "Edits apply in order, each to the result of the previous one. " +
    "If ANY edit fails (no match, or a non-unique match without replace_all), " +
    "NOTHING is written — the file is left untouched. Prefer this over multiple " +
    "edit calls when changing several places in the same file.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "The absolute path to the file to edit",
      },
      edits: {
        type: "array",
        description:
          "Ordered list of edits. Each is {old_string, new_string, replace_all?}. " +
          "Applied sequentially; all must succeed or none are written.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Text to find (exact match)" },
            new_string: { type: "string", description: "Replacement text" },
            replace_all: {
              type: "boolean",
              description: "Replace all occurrences of this edit's old_string",
            },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["filePath", "edits"],
  },
  isReadOnly: false,
  isConcurrencySafe: false, // Same file — must be serial

  async call(input, context): Promise<ToolResult> {
    const resolution = resolveInWorkspace(input.filePath, context.workspaceRoot);
    if (!resolution.ok) {
      return { content: "", error: resolution.error };
    }
    const filePath = resolution.path;

    if (isBlockedPath(filePath)) {
      return {
        content: "",
        error: `Access denied: "${input.filePath}" is a blocked path`,
      };
    }

    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return { content: "", error: "edits must be a non-empty array" };
    }

    try {
      const statBefore = statMtimeMs(filePath);
      const gate = checkReadBeforeEdit(context.sessionId, filePath, statBefore);
      if (!gate.ok) {
        return { content: "", error: gate.reason! };
      }

      const original = fs.readFileSync(filePath, "utf-8");
      let working = original;

      // Apply edits in memory; bail out before writing if any fails.
      for (let i = 0; i < input.edits.length; i++) {
        const { old_string: oldStr, new_string: newStr, replace_all } =
          input.edits[i];

        if (typeof oldStr !== "string" || typeof newStr !== "string") {
          return {
            content: "",
            error: `Edit #${i + 1}: old_string and new_string are required.`,
          };
        }

        let count = 0;
        let pos = 0;
        while ((pos = working.indexOf(oldStr, pos)) !== -1) {
          count++;
          pos += oldStr.length || 1;
        }

        if (count === 0) {
          return {
            content: "",
            error:
              `Edit #${i + 1}: old_string not found (after previous edits applied). ` +
              `No changes were written.`,
          };
        }
        if (count > 1 && replace_all !== true) {
          return {
            content: "",
            error:
              `Edit #${i + 1}: found ${count} matches. Add context to make it unique, ` +
              `or set replace_all: true. No changes were written.`,
          };
        }

        if (replace_all === true) {
          working = spliceAll(working, oldStr, newStr);
        } else {
          const idx = working.indexOf(oldStr);
          working =
            working.slice(0, idx) + newStr + working.slice(idx + oldStr.length);
        }
      }

      // All edits succeeded — commit once.
      fs.writeFileSync(filePath, working, "utf-8");

      const after = statMtimeMs(filePath);
      if (after !== undefined) refreshRead(context.sessionId, filePath, after);

      recordChange(
        context.sessionId,
        relForDisplay(filePath, context.workspaceRoot),
        "modified",
        `${input.edits.length} edits`,
      );

      return {
        content: `Applied ${input.edits.length} edits to ${input.filePath} atomically.`,
        metadata: { fileSize: Buffer.byteLength(working, "utf-8") },
      };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return { content: "", error: `File not found: "${input.filePath}"` };
      }
      return { content: "", error: `Error editing file: ${error.message}` };
    }
  },

  async checkPermissions(input, context) {
    const danger = checkDangerousPattern("edit", input, context.workspaceRoot);
    if (danger.dangerous) {
      return { allowed: false, reason: danger.reason! };
    }
    return { allowed: true };
  },
});

// ============================================================
// Bash Tool
// ============================================================

export const BashTool: Tool = createTool<BashInput>({
  name: "bash",
  description: "Execute a shell command",
  promptDescription:
    "Execute a shell command. Commands must be non-interactive. Output truncated at 30k characters.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The CLI command to execute",
      },
      description: {
        type: "string",
        description: "What this command does (shown to user)",
      },
      timeout: {
        type: "number",
        description: "Timeout in ms (default: 120000)",
      },
    },
    required: ["command", "description"],
  },
  isReadOnly: false,
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    const timeout = input.timeout ?? 120_000;

    try {
      const { stdout, stderr } = await execAsync(input.command, {
        cwd: context.workspaceRoot,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        shell: process.env.ComSpec || (process.platform === "win32" ? "cmd.exe" : "/bin/bash"),
      });

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += (output ? "\n" : "") + stderr;

      const truncated = output.length > 30_000;
      if (truncated) {
        output = output.slice(0, 30_000) + "\n[... result too long, truncated]";
      }

      return {
        content: output || "(no output)",
        truncated,
        metadata: { exitCode: 0 },
      };
    } catch (error: any) {
      let output = "";
      if (error.stdout) output += error.stdout;
      if (error.stderr) output += (output ? "\n" : "") + error.stderr;

      const truncated = output.length > 30_000;
      if (truncated) {
        output = output.slice(0, 30_000) + "\n[... result too long, truncated]";
      }

      return {
        content: output || error.message,
        truncated,
        metadata: { exitCode: error.code || 1 },
      };
    }
  },

  async checkPermissions(input, context) {
    const danger = checkDangerousPattern(
      "bash",
      input,
      context.workspaceRoot,
    );
    if (danger.dangerous) {
      return { allowed: false, reason: danger.reason! };
    }
    return { allowed: true };
  },
});

// ============================================================
// Glob Tool
// ============================================================

export const GlobTool: Tool = createTool<GlobInput>({
  name: "glob",
  description: "Find files matching a glob pattern",
  promptDescription:
    'Find files matching a glob pattern. Example patterns: "**/*.ts", "src/**/*.test.ts"',
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern, e.g. '**/*.ts' or 'src/**/*.test.ts'",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: workspace root)",
      },
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

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
        resultFiles.length === 0
          ? "No files found matching pattern."
          : resultFiles.join("\n");

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

// ============================================================
// Grep Tool
// ============================================================

export const GrepTool: Tool = createTool<GrepInput>({
  name: "grep",
  description: "Search file contents with regex",
  promptDescription:
    "Search file contents with regex pattern. Uses ripgrep if available, falls back to Node.js.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      path: {
        type: "string",
        description: "Directory or file to search (default: workspace root)",
      },
      include: {
        type: "string",
        description: "File pattern filter, e.g. '*.ts'",
      },
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    const searchDir = input.path
      ? path.resolve(context.workspaceRoot, input.path)
      : context.workspaceRoot;

    // Try ripgrep first, fall back to Node.js
    try {
      let cmd = `rg --line-number --no-heading --color never `;

      if (input.include) {
        cmd += `--glob '${input.include}' `;
      }

      // Ignore common directories
      cmd += `--glob '!node_modules' --glob '!.git' `;

      // Escape the pattern for shell
      const escaped = input.pattern.replace(/'/g, "'\\''");
      cmd += `'${escaped}' '${searchDir}'`;

      const { stdout } = await execAsync(cmd, {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
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

// ============================================================
// Helpers
// ============================================================

/**
 * Resolve a user-supplied path against the workspace root and confirm it
 * stays inside the workspace. Returns the absolute path on success, or an
 * error string on rejection.
 *
 * Guards two escapes the previous `startsWith(workspaceRoot)` check missed:
 *  1. Prefix aliasing — "/proj" must not match a sibling "/proj-evil".
 *     We compare against `workspaceRoot + path.sep` (and allow the root
 *     itself).
 *  2. Absolute-path override — `path.resolve(root, "/etc/passwd")` discards
 *     the root and returns "/etc/passwd". We resolve, then re-verify
 *     containment, so an absolute input outside the workspace is rejected.
 */
export function resolveInWorkspace(
  inputPath: string,
  workspaceRoot: string,
): { ok: true; path: string } | { ok: false; error: string } {  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, inputPath);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return {
      ok: false,
      error: `Access denied: "${inputPath}" is outside workspace`,
    };
  }
  return { ok: true, path: resolved };
}

/** Workspace-relative path for display; falls back to absolute if outside. */
export function relForDisplay(absPath: string, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, absPath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/");
  }
  return absPath;
}

function isBinary(buffer: Buffer): boolean {
  // Check first 8KB for null bytes (common binary indicator)
  const sampleSize = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function generateSimpleDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  let diff = "";
  for (const line of oldLines) {
    if (!newLines.includes(line)) {
      diff += `- ${line}\n`;
    }
  }
  for (const line of newLines) {
    if (!oldLines.includes(line)) {
      diff += `+ ${line}\n`;
    }
  }

  return diff || "(whitespace-only change)";
}

/**
 * Replace every occurrence of `oldStr` with `newStr` using index-based
 * splicing. Unlike String.replaceAll, this treats both strings as literal
 * text — no special-pattern interpretation in the replacement.
 */
function spliceAll(content: string, oldStr: string, newStr: string): string {
  if (oldStr === "") return content;
  let result = "";
  let pos = 0;
  let idx: number;
  while ((idx = content.indexOf(oldStr, pos)) !== -1) {
    result += content.slice(pos, idx) + newStr;
    pos = idx + oldStr.length;
  }
  result += content.slice(pos);
  return result;
}

/** Current mtimeMs of a file, or undefined if it doesn't exist. */
export function statMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

// Max bytes for an inline image/PDF (base64 inflates ~33%, so keep modest).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Extensions the Anthropic/OpenAI vision APIs accept as image/document blocks.
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** Return the media type for a multimodal-readable file, or undefined. */
function imageMediaType(filePath: string): string | undefined {
  return IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()];
}

// ============================================================
// All Core Tools
// ============================================================

export const CORE_TOOLS: Tool[] = [
  ReadTool,
  WriteTool,
  EditTool,
  MultiEditTool,
  BashTool,
  GlobTool,
  GrepTool,
  TodoTool,
  WebFetchTool,
  WebSearchTool,
  TaskTool,
  NotebookEditTool,
  LspDiagnosticsTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
  AskUserQuestionTool,
  ...TEAM_TOOLS,
];
