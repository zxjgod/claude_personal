// ============================================================
// /copy — copy the last assistant reply to the system clipboard
// ============================================================
// The official client copies the most recent response so it can be pasted
// elsewhere without selecting text by hand in a terminal. Only the assistant's
// prose is copied — tool calls and thinking blocks are not part of a "reply".
// ============================================================

import chalk from "chalk";
import type { Message } from "../types.js";
import { writeClipboardText } from "../utils/clipboard-text.js";
import type { CommandResult, SlashCommand } from "./types.js";

/**
 * The text of the most recent assistant reply, or null when the session has no
 * assistant message carrying prose. Pure — unit-tested without a clipboard.
 */
export function lastAssistantText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content.trim() : "";
    if (text.length > 0) return text;
    // An assistant turn that was tool-calls only carries no reply text — keep
    // walking back to the last turn that actually said something.
  }
  return null;
}

export const copyCommand: SlashCommand = {
  name: "copy",
  description: "Copy the last reply to the clipboard",
  run: async (_args, ctx): Promise<CommandResult | undefined> => {
    const text = lastAssistantText(ctx.messages);
    if (!text) {
      console.log(chalk.gray("  Nothing to copy — no assistant reply in this session yet."));
      return { handled: true };
    }

    const ok = await writeClipboardText(text);
    if (!ok) {
      console.log(
        chalk.yellow(
          "  Could not reach the system clipboard (needs clip / pbcopy / wl-copy or xclip).",
        ),
      );
      return { handled: true };
    }

    const lines = text.split("\n").length;
    console.log(chalk.gray(`  Copied the last reply (${lines} line${lines === 1 ? "" : "s"}).`));
    return { handled: true };
  },
};

export default copyCommand;
