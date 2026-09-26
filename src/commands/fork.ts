// /fork — ask the model to explore an alternate path via a sub-agent (M18.2)
// ============================================================
// Where /branch splits the session into a separate resumable file, /fork
// keeps the conversation in-place and injects a prompt ASKING the model to
// spin up a `general` sub-agent (via the task tool) carrying a recap of the
// conversation so far. (#45 honesty: nothing is spawned directly — the model
// decides whether to honor the request, exactly like any other injected
// prompt.) The prompt channel (CommandResult.prompt) runs it through the
// normal agent loop, so the turn's tool calls and result render like any
// other turn.
// ============================================================
import chalk from "chalk";
import type { Message, TextContent } from "../types.js";
import type { CommandResult, SlashCommand } from "./types.js";

function recapOfMessages(messages: Message[]): string {
  // A compact, best-effort text recap: last ~6 user/assistant turns.
  const turns: string[] = [];
  for (const m of messages.slice(-12)) {
    if (m.role === "user") {
      const t = Array.isArray(m.content)
        ? m.content
            .filter((b): b is TextContent => b.type === "text")
            .map((b) => b.text)
            .join(" ")
        : String(m.content ?? "");
      if (t.trim()) turns.push(`User: ${t.trim().slice(0, 400)}`);
    } else if (m.role === "assistant") {
      const t = typeof m.content === "string" ? m.content : "";
      if (t.trim()) turns.push(`Assistant: ${t.trim().slice(0, 400)}`);
    }
  }
  return turns.join("\n") || "(conversation so far)";
}

export const forkCommand: SlashCommand = {
  name: "fork",
  description: "Ask the model to explore an alternate path via a sub-agent",
  run: (args, ctx): CommandResult | undefined => {
    if (ctx.messages.length === 0) {
      console.log(chalk.yellow("  Nothing to fork — the conversation is empty."));
      return;
    }
    const goal = args.trim();
    const recap = recapOfMessages(ctx.messages);
    const task = goal
      ? `Explore this alternate direction: ${goal}`
      : `Explore a promising alternate direction based on the conversation so far`;

    const prompt = [
      `Use the task tool with subagent_name "general" to fork the current conversation.`,
      ``,
      `Context recap (the conversation up to this fork point):`,
      recap,
      ``,
      `${task}. Summarize what the sub-agent finds in 1-2 short paragraphs.`,
    ].join("\n");

    console.log(chalk.gray(`  Forking from ${ctx.messages.length} messages…`));
    return { handled: true, prompt };
  },
};

export default forkCommand;
