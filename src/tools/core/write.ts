// ============================================================
// Write Tool
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { recordChange } from "../../change-tracker.js";
import { shadowBeforeWrite } from "../../checkpoint.js";
import { checkDangerousPattern, isBlockedPath } from "../../permissions.js";
import { checkReadBeforeEdit, refreshRead } from "../../read-tracker.js";
import type { Tool, ToolResult } from "../../types.js";
import { InputValidator } from "../../utils/input-validator.js";
import { buildTool } from "../registry.js";
import { formatSize } from "../utils/file.js";
import { relForDisplay, resolveInWorkspace, statMtimeMs } from "../utils/path.js";

const WriteSchema = z.strictObject({
  filePath: z.string().describe("The absolute path where to write the file"),
  content: z.string().describe("Content to write to the file"),
});

export const WriteTool: Tool = buildTool({
  name: "write",
  description: "Create or overwrite a file",
  promptDescription:
    "Create or overwrite a file at the specified absolute path. " +
    "Creates parent directories automatically if they don't exist. " +
    "Parameters: filePath (required, absolute path where to write), " +
    "content (required, the text content to write). " +
    "Use for creating new files or replacing entire file contents. " +
    "For partial edits, use the edit tool instead.",
  schema: WriteSchema,
  isReadOnly: false,
  isConcurrencySafe: false, // Same file writes must be serial
  getPath: (input) => input.filePath,
  searchHint: "file create write new save",

  async call(input, context): Promise<ToolResult> {
    // P1: Validate file path input (boundary enforcement follows below via
    // resolveInWorkspace — InputValidator only checks shape/patterns).
    const pathValidation = InputValidator.validateFilePath(input.filePath);
    if (!pathValidation.valid) {
      return { content: "", error: pathValidation.error };
    }

    // P1: Validate content length (10MB limit)
    const contentValidation = InputValidator.validateContentLength(input.content, 10 * 1024 * 1024);
    if (!contentValidation.valid) {
      return { content: "", error: contentValidation.error };
    }

    const resolution = resolveInWorkspace(
      input.filePath,
      context.workspaceRoot,
      context.allowedDirectories,
    );
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
      // Overwriting an existing file without having read it silently clobbers
      // unseen content — enforce the same read-before-write gate the Edit
      // tools use (new files pass unconditionally).
      const existed = fs.existsSync(filePath);
      if (existed) {
        const gate = checkReadBeforeEdit(context.sessionId, filePath, statMtimeMs(filePath));
        if (!gate.ok) {
          return { content: "", error: gate.reason! };
        }
      }

      // Create parent directories
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });

      shadowBeforeWrite(context.sessionId, filePath); // P0-3: shadow for rewind
      fs.writeFileSync(filePath, input.content, "utf-8");

      // Keep the read tracker current so a follow-up Edit sees fresh state.
      const after = statMtimeMs(filePath);
      if (after !== undefined) refreshRead(context.sessionId, filePath, after);

      const size = Buffer.byteLength(input.content, "utf-8");
      const action = existed ? "Updated" : "Created";
      const lines = input.content.split("\n");
      const preview = lines.slice(0, 10).join("\n");

      recordChange(
        context.sessionId,
        relForDisplay(filePath, context.workspaceRoot),
        existed ? "modified" : "created",
        formatSize(size),
      );

      return {
        content: `${action} file: ${input.filePath} (${formatSize(size)})`,
        metadata: {
          fileSize: size,
          codePreview: {
            filePath: input.filePath,
            text: preview.slice(0, 4000),
            totalLines: lines.length,
            truncated: preview.length > 4000,
          },
        },
      };
    } catch (error) {
      return {
        content: "",
        error: `Error writing file: ${(error as Error).message}`,
      };
    }
  },

  async checkPermissions(input, context) {
    const danger = checkDangerousPattern("write", input, context.workspaceRoot);
    if (danger.dangerous) {
      return { allowed: false, reason: danger.reason! };
    }
    return { allowed: true };
  },
});
