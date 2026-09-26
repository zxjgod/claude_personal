// ============================================================
// RestoreContext Tool — recover evicted tool-result content (F2)
// ============================================================
// The context pipeline trims/evicts old tool results when the window is over
// budget (layers 2/3 of context-pipeline.ts). Every trimmed original is
// stashed in the loop's CollapseStore keyed by tool_call_id, and the stub
// left behind in the conversation names that id. This tool hands the
// original back to the model on demand — cheaper and more faithful than
// re-running the tool (the file may have changed since the result was
// captured). The restored content is returned as THIS call's result; history
// is never rewritten (that would break the prompt-cache prefix).
// ============================================================

import { z } from "zod";
import { buildTool } from "../registry.js";

/** Cap per restore so one recovery can't re-blow the context window. */
const MAX_RESTORE_CHARS = 50_000;

const RestoreContextSchema = z.strictObject({
  tool_call_id: z
    .string()
    .min(1)
    .describe("The tool_call_id named in the eviction/trim stub to recover"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Character offset to resume from when a previous restore was truncated"),
});

export const RestoreContextTool = buildTool({
  name: "RestoreContext",
  description:
    "Recover the full original content of a tool result that the context pipeline trimmed or evicted",
  promptDescription:
    "Recover the original content of a trimmed/evicted tool result. " +
    "Eviction stubs in the conversation carry the tool_call_id to pass here. " +
    "Use this instead of re-running a read/grep when the exact earlier output matters.",
  schema: RestoreContextSchema,
  isReadOnly: true,
  requiresApproval: false,
  isConcurrencySafe: true,

  async call(input, context) {
    const store = context.collapseStore;
    if (!store) {
      return { content: "", error: "No recoverable content store in this context." };
    }
    const original = store.restore(input.tool_call_id);
    if (original === undefined) {
      return {
        content: "",
        error:
          `Nothing stashed for tool_call_id "${input.tool_call_id}". ` +
          `Only results the context pipeline trimmed or evicted are recoverable; ` +
          `${store.size} item(s) are currently recoverable (ids are named in their stubs).`,
      };
    }

    const total = original.length;
    const offset = input.offset ?? 0;
    if (offset >= total) {
      return {
        content: "",
        error: `Offset ${offset} is beyond the restored content length (${total} chars).`,
      };
    }
    const slice = original.slice(offset, offset + MAX_RESTORE_CHARS);
    const end = offset + slice.length;
    const truncated =
      end < total
        ? `\n[... restored ${slice.length} of ${total} chars — call again with offset ${end} for the rest ...]`
        : "";
    return {
      content: `[Restored original for ${input.tool_call_id} — ${total} chars]\n${slice}${truncated}`,
      metadata: { summary: `Restored ${Math.min(slice.length, total)} of ${total} chars` },
    };
  },
});
