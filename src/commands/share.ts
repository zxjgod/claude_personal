// /share — export the session as a shareable markdown doc (M18.5)
// ============================================================
// Enhances /export: produces a self-contained markdown transcript and prints
// it to stdout (or writes to a path) ready to paste into a gist/issue/chat.
// Unlike /export (which always writes a file), /share with no args prints to
// stdout so it can be piped; with an arg it writes to that path. Tool-call
// verbosity is trimmed for readability.
// ============================================================
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { resolveAllowedWorkspaceFile } from "../tools/utils/path.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { CommandContext, CommandResult, SlashCommand } from "./types.js";

/** Render a compact, shareable transcript (no raw tool args/results dump). */
export function renderShareableTranscript(ctx: CommandContext): string {
  const lines: string[] = [
    `# Conversation with ${ctx.modelConfig.model} (${ctx.modelConfig.provider})`,
    ``,
    `_Workspace: \`${ctx.workspaceRoot}\` · ${new Date().toISOString()}_`,
    ``,
    "---",
    ``,
  ];
  for (const m of ctx.messages) {
    if (m.role === "user") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      if (text.trim()) {
        lines.push(`**User:**`, ``, text.trim(), ``, `---`, ``);
      }
    } else if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content : "";
      const calls = (m.tool_calls ?? []).map((tc) => `\`${tc.function.name}\``).join(", ");
      if (text.trim()) {
        lines.push(`**Assistant:**`, ``, text.trim());
      } else if (calls) {
        lines.push(`**Assistant:** _(used tools: ${calls})_`);
      }
      if (text.trim() || calls) lines.push(``, `---`, ``);
    }
    // tool/system messages are omitted for shareability (noise).
  }
  return lines.join("\n");
}

function parseOutputArgs(args: string): { path: string; force: boolean } {
  const force = /(?:^|\s)--force(?=\s|$)/i.test(args);
  const requested = args.replace(/(?:^|\s*)--force(?=\s|$)/gi, "").trim();
  return { path: requested, force };
}

export const shareCommand: SlashCommand = {
  name: "share",
  description: "Export the session as shareable markdown (/share [--force] [path])",
  run: (args, ctx): CommandResult | undefined => {
    const md = renderShareableTranscript(ctx);
    const options = parseOutputArgs(args);
    const target = options.path;

    if (!target) {
      // No path → print to stdout so it can be piped (`/share | pbcopy`).
      // The transcript embeds assistant text (model-produced) — sanitize the
      // terminal print. The file-write path below stays raw on purpose: it is
      // an export document, not terminal output.
      process.stdout.write(`${sanitizeTerminalText(md)}\n`);
      return;
    }
    try {
      const resolution = resolveAllowedWorkspaceFile(target, ctx.workspaceRoot);
      if (!resolution.ok) {
        console.log(chalk.red(`  Could not write: ${sanitizeTerminalText(resolution.error)}`));
        return;
      }
      const abs = resolution.path;
      fs.mkdirSync(path.dirname(abs) || ".", { recursive: true });
      fs.writeFileSync(abs, md, { encoding: "utf8", flag: options.force ? "w" : "wx" });
      console.log(chalk.gray(`  Shared transcript written → ${sanitizeTerminalText(abs)}`));
    } catch (e) {
      const detail = sanitizeTerminalText(e instanceof Error ? e.message : String(e));
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        console.log(chalk.yellow(`  Could not write: ${detail}. Use --force to overwrite.`));
        return undefined;
      }
      console.log(chalk.red(`  Could not write: ${detail}`));
    }
    return undefined;
  },
};

export default shareCommand;
