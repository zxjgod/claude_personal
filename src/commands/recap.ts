// /recap — summarize what this session accomplished (M18.4)
// ============================================================
// Injects a prompt that asks the model to summarize the current session,
// grounded in the transcript and the change-tracker's file list. Mirrors B's
// `commands/recap`. The change list is gathered locally (no model call needed
// up front); the model produces the prose recap.
// ============================================================
import chalk from "chalk";
import { listChanges } from "../change-tracker.js";
import { MemoryStore } from "../memory-extract.js";
import type { CommandResult, SlashCommand } from "./types.js";

export const recapCommand: SlashCommand = {
  name: "recap",
  description: "Summarize what was done this session",
  run: (_args, ctx): CommandResult | void => {
    const changes = listChanges(ctx.sessionId);
    const changedLines =
      changes.length > 0
        ? changes.map((c) => `- ${c.kind} ${c.path} (×${c.edits})`).join("\n")
        : "- (no files changed this session)";

    // M19.3: surface any durable memories so the recap can reference them.
    const memories = new MemoryStore(ctx.workspaceRoot).list();
    const memoryLines =
      memories.length > 0
        ? memories.slice(-10).map((m) => `- ${m.text}`).join("\n")
        : "";

    const prompt = [
      `Summarize what was accomplished in this session, based on the conversation so far.`,
      ``,
      `Files changed this session:`,
      changedLines,
      ...(memoryLines
        ? [``, `Durable notes on record (for context):`, memoryLines]
        : []),
      ``,
      `Produce a short recap with:`,
      `1. **What was asked** — the user's main goals this session.`,
      `2. **What was done** — key changes and decisions, with file references.`,
      `3. **Anything left open** — follow-ups, TODOs, or unresolved questions.`,
      ``,
      `Keep it tight (a few short paragraphs / bullets). Do not re-run any tools unless you genuinely need to re-read a file to answer accurately.`,
    ].join("\n");

    console.log(chalk.gray(`  Recapping ${ctx.messages.length} messages, ${changes.length} file change(s)…`));
    return { handled: true, prompt };
  },
};

export default recapCommand;
