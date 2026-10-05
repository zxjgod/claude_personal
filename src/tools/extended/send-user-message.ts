// ============================================================
// Official `--brief` — the SendUserMessage tool.
//
// The official flag's own one-liner is "Enable SendUserMessage tool for
// agent-to-user communication": the tool IS the feature. It is registered ONLY
// under `--brief` (src/cli-tools.ts), so a default session never advertises a
// channel it was not asked for.
//
// Deviations from official, all deliberate (see docs/更新日志):
//   1. `attachments` accepts the PATH form only. The object form
//      ({file_uuid, file_name, size, is_image}) refers to a device-side upload
//      channel this CLI has no equivalent for, and the model can never
//      legitimately hold such a reference — so it is REJECTED with a named
//      error instead of being quietly dropped.
//   2. Official's prompt text claims replies outside this tool are "visible in
//      the detail view, but most won't open it". That is true of official's
//      chat view, not of this terminal — plain assistant text here is fully
//      visible. Copying the claim verbatim would teach the model to distrust
//      output the user actually reads, so the wording below describes what
//      this surface really does.
// ============================================================

import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";
import { relForDisplay, resolveAllowedWorkspaceFile } from "../utils/path.js";

/** Official tool name (exact casing — official spells it `SendUserMessage`). */
export const SEND_USER_MESSAGE_TOOL_NAME = "SendUserMessage";

/**
 * Official `status` enum. Recorded on the call, but this CLI has no background
 * delivery channel, so `proactive` does not route anywhere special yet — that
 * is the `--bg` / `claude agents` surface, which is unimplemented.
 */
export const SEND_USER_MESSAGE_STATUSES = ["normal", "proactive"] as const;

/** The device-upload attachment form official also accepts. */
const UploadedFileRefSchema = z.strictObject({
  file_uuid: z.string(),
  file_name: z.string(),
  size: z.number(),
  is_image: z.boolean(),
});

const SendUserMessageSchema = z.strictObject({
  message: z
    .string()
    .min(1)
    .describe("The message text, in markdown. Delivered to the user verbatim."),
  attachments: z
    .array(z.union([z.string(), UploadedFileRefSchema]))
    .optional()
    .describe(
      "Files to surface with the message: paths, absolute or relative to the " +
        "workspace root — images, diffs, logs. Each is resolved inside the " +
        "workspace and checked against the session's path policy.",
    ),
  status: z
    .enum(SEND_USER_MESSAGE_STATUSES)
    .optional()
    .describe(
      "'normal' when replying to what the user just asked; 'proactive' when " +
        "you're initiating — a scheduled task finished, a blocker surfaced, " +
        "you need input on something they haven't asked about.",
    ),
});

export const SendUserMessageTool: Tool = buildTool({
  name: SEND_USER_MESSAGE_TOOL_NAME,
  description: "Send a message to the user",
  promptDescription:
    "Send a message to the user. `message` supports markdown and reaches them " +
    "verbatim — it is a checkpoint, not narration attached to some other tool call.\n\n" +
    "`attachments` takes file paths (absolute or relative to the workspace root) " +
    "for files you can read here — images, diffs, logs.\n\n" +
    "`status` labels intent: 'normal' when replying to what they just asked; " +
    "'proactive' when you're initiating — a scheduled task finished, a blocker " +
    "surfaced, you need input on something they haven't asked about. Set it " +
    "honestly.",
  schema: SendUserMessageSchema,
  isReadOnly: true,
  // Not concurrency-safe: messages are an ordered narrative for the user, so
  // the agent loop must not batch or reorder them against other tool calls.
  isConcurrencySafe: false,
  formatResult(result: ToolResult): string {
    // The message IS the result — skip the default "[0ms]" suffix, which would
    // otherwise be appended to every message the user reads.
    return result.error ? `Error: ${result.error}` : result.content;
  },
  async call(input, context): Promise<ToolResult> {
    const message = input.message.trim();
    if (!message) {
      return { content: "", error: "SendUserMessage requires a non-empty message" };
    }
    const files: string[] = [];
    for (const entry of input.attachments ?? []) {
      if (typeof entry !== "string") {
        return {
          content: "",
          error:
            "attachments entry is a {file_uuid, ...} object, which references a " +
            "device upload channel this CLI does not have. Pass a workspace-relative " +
            `or absolute file path instead (rejected: ${entry.file_name}).`,
        };
      }
      const resolved = resolveAllowedWorkspaceFile(
        entry,
        context.workspaceRoot,
        context.allowedDirectories,
      );
      if (!resolved.ok) return { content: "", error: `attachments: ${entry} — ${resolved.error}` };
      files.push(relForDisplay(resolved.path, context.workspaceRoot));
    }
    const footer = files.length > 0 ? `\n[attached: ${files.join(", ")}]` : "";
    return { content: message + footer };
  },
});
