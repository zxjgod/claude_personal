// ============================================================
// Read Tool
// ============================================================

import * as fs from "node:fs";
import chalk from "chalk";
import { z } from "zod";
import { markRead } from "../../read-tracker.js";
import type { Tool, ToolResult } from "../../types.js";
import { InputValidator } from "../../utils/input-validator.js";
import { buildTool } from "../registry.js";
import { imageMediaType, isBinary, MAX_IMAGE_BYTES } from "../utils/file.js";
import { resolveAllowedWorkspaceFile } from "../utils/path.js";

const ReadSchema = z.strictObject({
  filePath: z.string().describe("The absolute path to the file to read"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Line number to start reading from (1-based)"),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
});

export const ReadTool: Tool = buildTool({
  name: "read",
  description: "Read a file from the local filesystem",
  promptDescription:
    "Read a file from the local filesystem. Returns text content with line numbers (4-space padded). " +
    "Parameters: file_path (required, absolute path to the file; `filePath` " +
    "is also accepted), " +
    "offset (optional, line number to start reading from, 1-based), " +
    "limit (optional, maximum number of lines to read, default 2000). " +
    "Images (PNG/JPG/GIF/WebP) and PDFs are returned as visual content blocks you can see directly.",
  schema: ReadSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  // M30: never spill a Read result — its line window is already bounded by
  // offset/limit, and spilling would loop "Read → spill file → Read the spill".
  maxResultSizeChars: Number.POSITIVE_INFINITY,
  getPath: (input) => input.filePath,

  async call(input, context): Promise<ToolResult> {
    // P1: Validate file path input (boundary enforcement follows below via
    // resolveInWorkspace — InputValidator only checks shape/patterns).
    const pathValidation = InputValidator.validateFilePath(input.filePath);
    if (!pathValidation.valid) {
      return { content: "", error: pathValidation.error };
    }

    // Defense in depth (Top10 follow-up A9): the tool itself enforces the
    // full boundary + blocked-path policy (raw input AND resolved/realpath
    // forms) instead of relying on the executor's system-level check — a
    // caller that invokes ReadTool.call directly gets the same protection.
    const resolution = resolveAllowedWorkspaceFile(
      input.filePath,
      context.workspaceRoot,
      context.allowedDirectories,
    );
    if (!resolution.ok) {
      return { content: "", error: resolution.error };
    }
    const filePath = resolution.path;

    try {
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        return {
          content: "",
          error: `"${input.filePath}" is a directory, not a file`,
        };
      }

      const mediaType = imageMediaType(filePath);

      // Speculative prefetch (Top10 #6): a background read the model has not
      // seen must NOT satisfy the read-before-edit gate. Skip markRead and
      // instead report {readPath, readMtimeMs} (the mtime of the version being
      // returned) in metadata, so the cache-hit consumer in tool-executor can
      // PROMOTE the read when — and only when — the content actually reaches
      // the model as a real Read result.
      const specMeta = context.speculative ? { readPath: filePath, readMtimeMs: stat.mtimeMs } : {};
      const noteRead = (): void => {
        if (!context.speculative) markRead(context.sessionId, filePath, stat.mtimeMs);
      };

      // Images/PDFs are loaded wholesale into memory below, so the size gate
      // MUST run before any read: a multi-GB PNG rejected only after
      // readFileSync would already have OOM'd the process.
      if (mediaType && stat.size > MAX_IMAGE_BYTES) {
        return {
          content: `[Image too large to load: ${input.filePath} (${stat.size} bytes, max ${MAX_IMAGE_BYTES})]`,
          metadata: { fileSize: stat.size },
        };
      }

      // Never load an unbounded text file wholesale into memory: a multi-GB
      // file would be read into RAM and split into lines with no cap, risking
      // OOM. Read only a bounded prefix for oversized non-image files and flag
      // truncation.
      const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024; // 10MB
      let buffer: Buffer;
      let fileTruncated = false;
      if (!mediaType && stat.size > MAX_TEXT_FILE_BYTES) {
        const fd = fs.openSync(filePath, "r");
        try {
          const head = Buffer.alloc(MAX_TEXT_FILE_BYTES);
          const bytesRead = fs.readSync(fd, head, 0, MAX_TEXT_FILE_BYTES, 0);
          buffer = head.subarray(0, bytesRead);
        } finally {
          fs.closeSync(fd);
        }
        fileTruncated = true;
      } else {
        buffer = fs.readFileSync(filePath);
      }

      // Images and PDFs return as multimodal content blocks.
      if (mediaType) {
        noteRead();
        return {
          content: `[Loaded ${mediaType}: ${input.filePath}]`,
          metadata: { fileSize: stat.size, ...specMeta },
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
        noteRead();
        return {
          content: `[Binary file: ${filePath}]`,
          metadata: { fileSize: stat.size, ...specMeta },
        };
      }

      // Render notebooks structurally so the model can reason about cells
      // without parsing a large JSON blob. Keep outputs bounded and preserve
      // source line numbering inside each cell.
      if (filePath.toLowerCase().endsWith(".ipynb")) {
        try {
          const notebook = JSON.parse(buffer.toString("utf-8")) as {
            cells?: Array<{
              cell_type?: string;
              source?: string | string[];
              outputs?: unknown[];
              execution_count?: number | null;
            }>;
          };
          if (Array.isArray(notebook.cells)) {
            const rendered = notebook.cells
              .map((cell, index) => {
                const source = Array.isArray(cell.source)
                  ? cell.source.join("")
                  : String(cell.source ?? "");
                const lines = source
                  .split("\n")
                  .map((line, i) => `${String(i + 1).padStart(4, " ")}: ${line}`)
                  .join("\n");
                const outputCount = Array.isArray(cell.outputs) ? cell.outputs.length : 0;
                return `Cell ${index} [${cell.cell_type ?? "unknown"}]${cell.execution_count != null ? ` execution=${cell.execution_count}` : ""}${outputCount ? ` outputs=${outputCount}` : ""}\n${lines}`;
              })
              .join("\n\n");
            noteRead();
            return {
              content: rendered || "(empty notebook)",
              metadata: {
                fileSize: stat.size,
                summary: `Read notebook (${notebook.cells.length} cells)`,
                linesRead: rendered.split("\n").length,
                ...specMeta,
              },
            };
          }
        } catch {
          // Invalid notebook JSON falls through to normal text rendering.
        }
      }

      let lines = buffer.toString("utf-8").split("\n");
      const totalLines = lines.length;

      // Apply offset and limit
      const start = (input.offset ?? 1) - 1;
      const end = input.limit ? start + input.limit : Math.min(start + 2000, totalLines);

      // Review follow-up #8: an offset past the loaded 10MB prefix used to
      // return an empty result whose only hint was the generic "result too
      // long, truncated" suffix — the model had no way to learn the file was
      // cut at a BYTE budget it can't address by line. Say exactly that.
      if (fileTruncated && start >= totalLines) {
        noteRead();
        return {
          content:
            `[offset ${start + 1} is beyond this file's readable window: it is ` +
            `${stat.size} bytes and only the first ${MAX_TEXT_FILE_BYTES} bytes ` +
            `(≈${totalLines} lines) are loadable. Lines past that point cannot be ` +
            `read by this tool — use grep to locate content, or split the file.]`,
          metadata: { linesRead: 0, fileSize: stat.size, ...specMeta },
        };
      }

      lines = lines.slice(start, end);

      // Strip trailing `\r` from CRLF files. The `\r` is invisible in the
      // terminal but pollutes every line the model sees; showing it would
      // push the model to embed `\r` into Edit old_string/new_string. (Edit
      // is CRLF-tolerant on match, so LF-only search text still works.)
      lines = lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

      // Per-line cap (Top10 follow-up T1, real-CC semantics): a minified
      // bundle is ONE line — the offset/limit window counts LINES, and this
      // tool never spills (maxResultSizeChars: Infinity), so a multi-MB
      // single line used to enter the model context whole.
      const MAX_LINE_CHARS = 2000;
      let lineTruncated = false;
      lines = lines.map((line) => {
        if (line.length <= MAX_LINE_CHARS) return line;
        lineTruncated = true;
        // Cut at a CODE POINT boundary (fourth-round review): a raw index can
        // split a surrogate pair (emoji / CJK extensions), leaving a lone high
        // surrogate that JSON-escapes into garbage in the model context. Same
        // discipline as hardWrapLine in live-window.
        let cut = MAX_LINE_CHARS;
        const last = line.charCodeAt(cut - 1);
        if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // high surrogate at the cut
        return `${line.slice(0, cut)} …[+${line.length - cut} chars]`;
      });

      // Add line numbers (4-space padded)
      const numbered = lines
        .map((line, i) => {
          const num = String(start + i + 1).padStart(4, " ");
          return `${num}: ${line}`;
        })
        .join("\n");

      const truncated = fileTruncated || end < totalLines || lineTruncated;

      noteRead();

      return {
        // #8: when the file itself was cut at the 10MB byte budget, say so IN
        // the content — the generic `truncated` suffix ("result too long")
        // would otherwise misattribute a file-size cut to a window-size cut.
        content: fileTruncated
          ? `${numbered}\n[file truncated: ${stat.size} bytes on disk; showing only the first ${MAX_TEXT_FILE_BYTES} bytes ≈ ${totalLines} lines]`
          : numbered,
        truncated,
        metadata: {
          linesRead: lines.length,
          fileSize: stat.size,
          summary: lines.length === 1 ? "Read 1 line" : `Read ${lines.length} lines`,
          ...specMeta,
        },
      };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return {
          content: "",
          error:
            `File not found: ${input.filePath}\n` +
            chalk.gray(
              `   Hint: check the path, or use the Glob tool to search for it (e.g. "*.ts")`,
            ),
        };
      }
      if (errno.code === "EACCES") {
        return {
          content: "",
          error:
            `Permission denied: cannot read "${input.filePath}"\n` +
            chalk.gray("   Hint: check the file permissions"),
        };
      }
      if (errno.code === "EISDIR") {
        return {
          content: "",
          error:
            `Path is a directory, not a file: ${input.filePath}\n` +
            chalk.gray("   Hint: use the Glob tool to list directory contents"),
        };
      }
      return {
        content: "",
        error: `Error reading file: ${errno.message}`,
      };
    }
  },

  async checkPermissions(_input, _context) {
    return { allowed: true }; // Read-only, always allowed
  },
});
