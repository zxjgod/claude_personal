// /rewind — rewind the conversation to before a given turn (M18.6 · P0-3)
// ============================================================
// Drops messages from the end of the transcript back to (and including) a
// target turn, AND restores on-disk files from the session checkpoints
// (src/checkpoint.ts — Write/Edit/MultiEdit/Notebook are shadowed; Bash-side
// edits are not). The target user message carries its checkpoint turn via
// turnOfMessage() — no ordinal arithmetic that synthetic injections, /clear,
// auto-compaction or /resume could desynchronize.
// Turns are counted by user messages: `/rewind 2` removes the last 2 user
// turns (and the assistant/tool messages after each). With no arg, rewinds
// one turn.
// ============================================================
import chalk from "chalk";
import { restoreToTurn, turnOfMessage } from "../checkpoint.js";
import type { Message } from "../types.js";
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
  description: "Rewind the conversation by N turns and restore files (/rewind [n], default 1)",
  run: (args, ctx): undefined => {
    const n = Math.max(1, parseInt(args.trim(), 10) || 1);
    const messages = ctx.messages;
    const userIdx = findUserTurnBoundaries(messages);

    if (userIdx.length === 0) {
      console.log(chalk.yellow("  Nothing to rewind — no user turns yet."));
      return;
    }

    // P0-3: the FIRST message this rewind removes is the (length - n + 1)-th
    // user turn (1-based). Its checkpoint tag — read straight off the message
    // object — identifies the boundary to restore. Turns loaded by /resume
    // carry no tag: the conversation still rewinds, files honestly don't.
    const targetMsgIndex = userIdx[Math.max(0, userIdx.length - n)]!;
    const cpTurn = turnOfMessage(messages[targetMsgIndex] as Message);
    let restored = 0;
    let deleted = 0;
    if (cpTurn !== null) {
      const r = restoreToTurn(ctx.sessionId, cpTurn);
      if (r.failures?.length) {
        console.log(
          chalk.red(
            `  Rewind incomplete: ${r.failures.map((f) => `${f.path}: ${f.error}`).join("; ")}. Conversation and checkpoints retained for retry.`,
          ),
        );
        return;
      }
      restored = r.restored.length;
      deleted = r.deleted.length;
    }

    if (n >= userIdx.length) {
      const before = messages.length;
      messages.length = 0;
      console.log(chalk.gray(`  Rewound all ${userIdx.length} turn(s) (${before} → 0 messages).`));
    } else {
      // Keep everything before the (length - n)-th user message.
      const cutAt = userIdx[userIdx.length - n]!;
      const before = messages.length;
      messages.length = cutAt;
      console.log(chalk.gray(`  Rewound ${n} turn(s) (${before} → ${messages.length} messages).`));
    }
    if (cpTurn === null) {
      console.log(
        chalk.gray("  (This turn predates the current process — no file checkpoint to restore.)"),
      );
    } else if (restored > 0 || deleted > 0) {
      console.log(
        chalk.gray(
          `  Files restored: ${restored} rewritten · ${deleted} deleted (Bash-side edits are not checkpointed).`,
        ),
      );
    } else {
      console.log(chalk.gray("  (No checkpointed file changes to restore for this range.)"));
    }
  },
};

export default rewindCommand;
