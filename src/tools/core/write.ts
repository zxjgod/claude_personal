// ============================================================
// Write Tool
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { recordChange } from "../../change-tracker.js";
import { checkDangerousPattern, isBlockedPath } from "../../permissions.js";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";
import { formatSize } from "../utils/file.js";
import { relForDisplay, resolveInWorkspace } from "../utils/path.js";

const WriteSchema = z.strictObject({
  filePath: z.string().describe("The absolute path where to write the file"),
  content: z.string().describe("Content to write to the file"),
});
type WriteInput = z.infer<typeof WriteSchema>;

export const WriteTool: Tool = buildTool({
  name: "write",
  description: "Create or overwrite a file",
  promptDescription: "Create or overwrite a file. Creates parent directories automatically.",
  schema: WriteSchema,
  isReadOnly: false,
  isConcurrencySafe: false, // Same file writes must be serial
  getPath: (input) => input.filePath,

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
    const danger = checkDangerousPattern("write", input, context.workspaceRoot);
    if (danger.dangerous) {
      return { allowed: false, reason: danger.reason! };
    }
    return { allowed: true };
  },
});
