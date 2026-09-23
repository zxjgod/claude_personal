// /memory — view or append to CLAUDE.md + view/save/extract durable memories
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { listChanges } from "../change-tracker.js";
import {
  extractMemoriesHeuristic,
  extractMemoriesWithModel,
  MemoryStore,
} from "../memory-extract.js";
import type { SlashCommand } from "./types.js";

export const memoryCommand: SlashCommand = {
  name: "memory",
  description:
    "View/append CLAUDE.md, view/save durable memories, or extract (/memory, /memory add <text>, /memory save <text>, /memory extract [--model])",
  run: (args, ctx): Promise<undefined> | undefined => {
    const claudeMdPath = path.join(ctx.workspaceRoot, "CLAUDE.md");
    const trimmed = args.trim();

    // /memory add <text> — append a bullet to CLAUDE.md.
    if (trimmed.toLowerCase().startsWith("add ")) {
      const note = trimmed.slice(4).trim();
      if (!note) {
        console.log(chalk.yellow("  Usage: /memory add <text>"));
        return;
      }
      try {
        const exists = fs.existsSync(claudeMdPath);
        const prefix = exists && fs.readFileSync(claudeMdPath, "utf-8").endsWith("\n") ? "" : "\n";
        fs.appendFileSync(claudeMdPath, `${prefix}- ${note}\n`, "utf-8");
        console.log(chalk.gray(`  Appended to CLAUDE.md: "${note}"`));
        console.log(chalk.gray("  (Restart the session to load it into the system prompt.)"));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.log(chalk.red(`  Could not write CLAUDE.md: ${detail}`));
      }
      return;
    }

    // /memory save <text> — write one durable memory to the retrieval store
    // (.claude/memories.jsonl). Unlike /memory add (CLAUDE.md, always in the
    // system prompt), saved memories surface by relevance in future sessions.
    if (trimmed.toLowerCase().startsWith("save ")) {
      const note = trimmed.slice(5).trim();
      if (!note) {
        console.log(chalk.yellow("  Usage: /memory save <text>"));
        return;
      }
      const store = new MemoryStore(ctx.workspaceRoot);
      const written = store.append([{ source: "manual", text: note, tags: ["manual"] }]);
      if (written.length === 0) {
        console.log(chalk.gray("  Already remembered (deduped)."));
      } else {
        console.log(chalk.gray(`  Saved → ${store.path}`));
      }
      return;
    }

    // /memory extract [--model] — pull durable facts/preferences from this
    // session into .claude/memories.jsonl (deduped). --model adds one
    // model-assisted pass over the transcript for higher-quality extraction
    // (routed through the M5 fast model when CCR_FAST_MODEL is configured).
    // NOTE: `\b` cannot delimit `--model` — `-` is not a word character, so
    // neither side of the flag forms a boundary; match on whitespace instead.
    if (/^extract(\s|$)/i.test(trimmed)) {
      const useModel = /(^|\s)--model(\s|$)/i.test(trimmed);
      const run = async (): Promise<void> => {
        const store = new MemoryStore(ctx.workspaceRoot);
        const candidates = extractMemoriesHeuristic(ctx.messages, listChanges(ctx.sessionId));
        if (useModel) {
          const fast = ctx.fastModelFactory?.() ?? null;
          candidates.push(
            ...(await extractMemoriesWithModel(
              ctx.messages,
              fast?.callModel ?? ctx.callModel,
              fast?.modelConfig ?? ctx.modelConfig,
            )),
          );
        }
        const written = store.append(candidates);
        if (written.length === 0) {
          console.log(
            chalk.gray(
              candidates.length === 0
                ? "  Nothing durable found to remember this session."
                : "  No new memories (all already stored).",
            ),
          );
          return;
        }
        console.log(chalk.gray(`  Stored ${written.length} memorie(s) → ${store.path}`));
        for (const m of written) console.log(`    ${chalk.green("+")} ${m.text}`);
      };
      return run().then(() => undefined);
    }

    // /memory — show durable memories store + current CLAUDE.md.
    const store = new MemoryStore(ctx.workspaceRoot);
    const memories = store.list();
    if (memories.length > 0) {
      console.log("");
      console.log(chalk.bold(`  Durable memories (${memories.length}) — ${store.path}:`));
      for (const m of memories.slice(-15)) {
        const tag = m.tags?.length ? chalk.gray(` [${m.tags.join(",")}]`) : "";
        console.log(`    ${chalk.cyan("•")} ${m.text}${tag}`);
      }
      console.log(chalk.gray("  (Use /memory extract to capture more from this session.)"));
    }

    try {
      const content = fs.readFileSync(claudeMdPath, "utf-8");
      console.log("");
      console.log(chalk.bold(`  CLAUDE.md (${claudeMdPath}):`));
      console.log("");
      for (const line of content.split("\n")) console.log(`  ${chalk.gray(line)}`);
    } catch {
      if (memories.length === 0) {
        console.log(
          chalk.gray("  No CLAUDE.md found. Use /init to create one, or /memory add <text>."),
        );
      }
    }
    return;
  },
};

export default memoryCommand;
