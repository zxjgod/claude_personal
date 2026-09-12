// ============================================================
// Edit Tool (Search/Replace — the most critical tool!)
// ============================================================

import * as fs from "node:fs";
import chalk from "chalk";
import { z } from "zod";
import { recordChange } from "../../change-tracker.js";
import { shadowBeforeWrite } from "../../checkpoint.js";
import { checkDangerousPattern, isBlockedPath } from "../../permissions.js";
import { checkReadBeforeEdit, refreshRead } from "../../read-tracker.js";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";
import {
  crlfTolerantPair,
  diffDisplayLines,
  generateSimpleDiff,
  spliceAll,
} from "../utils/diff.js";
import { relForDisplay, resolveInWorkspace, statMtimeMs } from "../utils/path.js";

const EditSchema = z.strictObject({
  filePath: z.string().describe("The absolute path to the file to edit"),
  old_string: z
    .string()
    .min(1, "old_string must not be empty")
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

export const EditTool: Tool = buildTool({
  name: "edit",
  description: "Make precise edits using search/replace",
  promptDescription:
    "Make precise edits using search/replace. " +
    "IMPORTANT: old_string must match EXACTLY including whitespace and indentation. " +
    "If the match is not unique, add more surrounding context lines or use replace_all: true. " +
    "Parameters: filePath (required, absolute path), " +
    "old_string (required, exact text to find), " +
    "new_string (required, replacement text, use empty string to delete), " +
    "replace_all (optional, replace all occurrences). " +
    "Never use this to rewrite entire files — use for targeted changes only.",
  schema: EditSchema,
  isReadOnly: false,
  isConcurrencySafe: false, // Same file edits must be serial
  getPath: (input) => input.filePath,
  searchHint: "edit modify replace search change update",

  async call(input, context): Promise<ToolResult> {
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
      const statBefore = statMtimeMs(filePath);
      const gate = checkReadBeforeEdit(context.sessionId, filePath, statBefore);
      if (!gate.ok) {
        return { content: "", error: gate.reason! };
      }

      const content = fs.readFileSync(filePath, "utf-8");
      // CRLF tolerance: Read output strips `\r`, so the model sends LF-only
      // search text; retry with the pair upconverted when the exact match
      // misses inside a CRLF file (see crlfTolerantPair).
      const { oldStr, newStr } = crlfTolerantPair(content, input.old_string, input.new_string);
      const replaceAll = input.replace_all === true;

      // A no-op edit still rewrites the file and refreshes the read tracker —
      // refuse it instead of corrupting freshness bookkeeping.
      if (oldStr === newStr || input.old_string === input.new_string) {
        return {
          content: "",
          error: "old_string and new_string are identical — nothing to change.",
        };
      }

      // Count occurrences
      let count = 0;
      let pos = content.indexOf(oldStr, 0);
      while (pos !== -1) {
        count++;
        // `|| 1` guards an empty old_string, which would otherwise loop forever
        // (indexOf("", pos) === pos, and pos += 0 never advances). Mirrors the
        // multi_edit guard; the schema's .min(1) rejects it earlier in practice.
        pos += oldStr.length || 1;
        pos = content.indexOf(oldStr, pos);
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
      // Offset of the first match. The count>1 && !replaceAll case already
      // returned above, so this is the only match when replaceAll is false —
      // and it seeds the display line numbers below either way.
      const idx = content.indexOf(oldStr);
      let newContent: string;
      if (replaceAll) {
        newContent = spliceAll(content, oldStr, newStr);
      } else {
        newContent = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
      }
      shadowBeforeWrite(context.sessionId, filePath); // P0-3: shadow for rewind
      fs.writeFileSync(filePath, newContent, "utf-8");

      // Keep the read tracker current so chained edits don't trip the gate.
      const after = statMtimeMs(filePath);
      if (after !== undefined) refreshRead(context.sessionId, filePath, after);

      // Generate a simple diff
      const diff = generateSimpleDiff(oldStr, newStr);
      // Display-only companion carrying absolute file line numbers for the TUI
      // gutter. Kept out of `content` so the model-facing result is unchanged.
      const startLine = content.slice(0, idx).split("\n").length;
      const diffLines = diffDisplayLines(oldStr, newStr, startLine);
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
        metadata: { fileSize: Buffer.byteLength(newContent, "utf-8"), diffLines },
      };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return {
          content: "",
          error:
            `File not found: ${input.filePath}\n` +
            chalk.gray(
              "   Hint: cannot edit a non-existent file; use the Write tool to create it first",
            ),
        };
      }
      if (errno.code === "EACCES") {
        return {
          content: "",
          error:
            `Permission denied: cannot edit "${input.filePath}"\n` +
            chalk.gray("   Hint: check the file permissions"),
        };
      }
      if (errno.code === "EBUSY" || errno.code === "ETXTBSY") {
        return {
          content: "",
          error:
            `File is in use: ${input.filePath}\n` +
            chalk.gray("   Hint: the file may be open in another program; close it and retry"),
        };
      }
      return {
        content: "",
        error: `Error editing file: ${errno.message}`,
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
        old_string: z
          .string()
          .min(1, "old_string must not be empty")
          .describe("Text to find (exact match)"),
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

export const MultiEditTool: Tool = buildTool({
  name: "multi_edit",
  description: "Apply multiple search/replace edits to a single file atomically",
  promptDescription:
    "Apply multiple search/replace edits to ONE file in a single atomic operation. " +
    "Use when you need to make several changes to the same file — all edits succeed or none are written. " +
    "Parameters: filePath (required, absolute path), " +
    "edits (required, array of {old_string, new_string, replace_all?}). " +
    "Edits apply in order; each sees the result of previous edits. " +
    "If ANY edit fails, NO changes are written. Prefer this over multiple edit calls.",
  schema: MultiEditSchema,
  isReadOnly: false,
  isConcurrencySafe: false, // Same file — must be serial
  getPath: (input) => input.filePath,
  searchHint: "batch edit multiple changes atomic",

  async call(input, context): Promise<ToolResult> {
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
        const edit = input.edits[i];

        if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") {
          return {
            content: "",
            error: `Edit #${i + 1}: old_string and new_string are required.`,
          };
        }

        // CRLF tolerance per edit, evaluated against the CURRENT working text
        // (previous edits may have introduced or removed CRLF regions).
        const { oldStr, newStr } = crlfTolerantPair(working, edit.old_string, edit.new_string);
        const replace_all = edit.replace_all;

        let count = 0;
        let pos = working.indexOf(oldStr, 0);
        while (pos !== -1) {
          count++;
          pos += oldStr.length || 1;
          pos = working.indexOf(oldStr, pos);
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
      shadowBeforeWrite(context.sessionId, filePath); // P0-3: shadow for rewind
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
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return {
          content: "",
          error:
            `File not found: ${input.filePath}\n` +
            chalk.gray(
              "   Hint: cannot edit a non-existent file; use the Write tool to create it first",
            ),
        };
      }
      if (errno.code === "EACCES") {
        return {
          content: "",
          error:
            `Permission denied: cannot edit "${input.filePath}"\n` +
            chalk.gray("   Hint: check the file permissions"),
        };
      }
      if (errno.code === "EBUSY" || errno.code === "ETXTBSY") {
        return {
          content: "",
          error:
            `File is in use: ${input.filePath}\n` +
            chalk.gray("   Hint: the file may be open in another program; close it and retry"),
        };
      }
      return { content: "", error: `Error editing file: ${errno.message}` };
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
