// /rewind — rewind the conversation to before a given turn (M18.6)
// ============================================================
// Drops messages from the end of the transcript back to (and including) a
// target turn. Turns are counted by user messages: `/rewind 2` removes the
// last 2 user turns (and the assistant/tool messages after each). With no
// arg, rewinds one turn. This is a local-only snapshot rewind — it does not
// un-write files; pair with git to revert on-disk changes.
// ============================================================
import chalk from "chalk";
import type { SlashCommand } from "./types.js";

function findUserTurnBoundaries(messages: { role: string }[]): number[] {
  const idx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") idx.push(i);
  });
  return idx;
}

export const rewindCommand: SlashCommand = {
  name: "rewind",
  description: "Rewind the conversation by N turns (/rewind [n], default 1)",
  run: (args, ctx): undefined => {
    const n = Math.max(1, parseInt(args.trim(), 10) || 1);
    const messages = ctx.messages;
    const userIdx = findUserTurnBoundaries(messages);

    if (userIdx.length === 0) {
      console.log(chalk.yellow("  Nothing to rewind — no user turns yet."));
      return;
    }
    if (n >= userIdx.length) {
      const before = messages.length;
      messages.length = 0;
      console.log(chalk.gray(`  Rewound all ${userIdx.length} turn(s) (${before} → 0 messages).`));
      return;
    }

    // Keep everything before the (length - n)-th user message.
    const cutAt = userIdx[userIdx.length - n]!;
    const before = messages.length;
    messages.length = cutAt;
    console.log(chalk.gray(`  Rewound ${n} turn(s) (${before} → ${messages.length} messages).`));
    console.log(chalk.gray("  (On-disk files are not reverted — use git to undo edits.)"));
  },
};

export default rewindCommand;
