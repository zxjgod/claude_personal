// ============================================================
// Edit Tool (Search/Replace — the most critical tool!)
// ============================================================

import * as fs from "node:fs";
import { z } from "zod";
import { recordChange } from "../../change-tracker.js";
import { checkDangerousPattern, isBlockedPath } from "../../permissions.js";
import { checkReadBeforeEdit, refreshRead } from "../../read-tracker.js";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";
import { generateSimpleDiff, spliceAll } from "../utils/diff.js";
import { relForDisplay, resolveInWorkspace, statMtimeMs } from "../utils/path.js";

const EditSchema = z.strictObject({
  filePath: z.string().describe("The absolute path to the file to edit"),
  old_string: z
    .string()
    .describe(
      "The text to replace. Must match EXACTLY including whitespace and indentation. If not unique, add more surrounding context lines.",
    ),
  new_string: z.string().describe("The text to replace it with. Use empty string to delete."),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence of old_string instead of requiring a unique match. Defaults to false.",
    ),
});
type EditInput = z.infer<typeof EditSchema>;

export const EditTool: Tool = buildTool({
  name: "edit",
  description: "Make precise edits using search/replace",
  promptDescription:
    "Make precise edits using search/replace. old_string must match exactly including whitespace and indentation. If not unique, add more surrounding context lines.",
  schema: EditSchema,
  isReadOnly: false,
  isConcurrencySafe: false, // Same file edits must be serial
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
        newContent = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
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
    const danger = checkDangerousPattern("edit", input, context.workspaceRoot);
    if (danger.dangerous) {
      return { allowed: false, reason: danger.reason! };
    }
    return { allowed: true };
  },
});

// ============================================================
// MultiEdit Tool — atomic batch edits on a single file
// ============================================================

const MultiEditSchema = z.strictObject({
  filePath: z.string().describe("The absolute path to the file to edit"),
  edits: z
    .array(
      z.strictObject({
        old_string: z.string().describe("Text to find (exact match)"),
        new_string: z.string().describe("Replacement text"),
        replace_all: z
          .boolean()
          .optional()
          .describe("Replace all occurrences of this edit's old_string"),
      }),
    )
    .describe(
      "Ordered list of edits. Each is {old_string, new_string, replace_all?}. " +
        "Applied sequentially; all must succeed or none are written.",
    ),
});
type MultiEditInput = z.infer<typeof MultiEditSchema>;

export const MultiEditTool: Tool = buildTool({
  name: "multi_edit",
  description: "Apply multiple search/replace edits to a single file atomically",
  promptDescription:
    "Apply multiple search/replace edits to ONE file in a single atomic operation. " +
    "Provide filePath and edits (an array of {old_string, new_string, replace_all?}). " +
    "Edits apply in order, each to the result of the previous one. " +
    "If ANY edit fails (no match, or a non-unique match without replace_all), " +
    "NOTHING is written — the file is left untouched. Prefer this over multiple " +
    "edit calls when changing several places in the same file.",
  schema: MultiEditSchema,
  isReadOnly: false,
  isConcurrencySafe: false, // Same file — must be serial
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
        const { old_string: oldStr, new_string: newStr, replace_all } = input.edits[i];

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
          working = working.slice(0, idx) + newStr + working.slice(idx + oldStr.length);
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
