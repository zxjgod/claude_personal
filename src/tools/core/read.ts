// ============================================================
// Read Tool
// ============================================================

import * as fs from "node:fs";
import { z } from "zod";
import { isBlockedPath } from "../../permissions.js";
import { markRead } from "../../read-tracker.js";
import type { Tool, ToolResult } from "../../types.js";
import { InputValidator } from "../../utils/input-validator.js";
import { buildTool } from "../registry.js";
import { formatSize, imageMediaType, isBinary, MAX_IMAGE_BYTES } from "../utils/file.js";
import { resolveInWorkspace } from "../utils/path.js";

const ReadSchema = z.strictObject({
  filePath: z.string().describe("The absolute path to the file to read"),
  offset: z.number().int().optional().describe("Line number to start reading from (1-based)"),
  limit: z.number().int().optional().describe("Maximum number of lines to read"),
});
type ReadInput = z.infer<typeof ReadSchema>;

export const ReadTool: Tool = buildTool({
  name: "read",
  description: "Read a file from the local filesystem",
  promptDescription:
    "Read a file from the local filesystem. Returns text content with line numbers (4-space padded). " +
    "Parameters: filePath (required, absolute path to the file), " +
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
  searchHint: "file read view cat open display",

  async call(input, context): Promise<ToolResult> {
    // P1: Validate file path input
    const pathValidation = InputValidator.validateFilePath(input.filePath, context);
    if (!pathValidation.valid) {
      return { content: "", error: pathValidation.error };
    }

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
