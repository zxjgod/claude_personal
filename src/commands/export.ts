// /export — export the current session to a markdown file
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { CommandContext, SlashCommand } from "./types.js";

/**
 * Render the current session's messages as a readable markdown transcript
 * (for /export and /share). Pure and synchronous — only reads ctx.
 */
export function renderSessionMarkdown(ctx: CommandContext): string {
  const lines: string[] = [
    `# Session ${ctx.sessionId}`,
    "",
    `Workspace: \`${ctx.workspaceRoot}\``,
    `Model: ${ctx.modelConfig.model} (${ctx.modelConfig.provider})`,
    `Exported: ${new Date().toISOString()}`,
    `Messages: ${ctx.messages.length}`,
    "",
    "---",
    "",
  ];
  for (const m of ctx.messages) {
    if (m.role === "user") {
      lines.push("## 👤 user", "");
      for (const block of m.content) {
        if (block.type === "text") lines.push(block.text);
      }
      lines.push("");
    } else if (m.role === "assistant") {
      lines.push("## ● assistant", "");
      if (typeof m.content === "string" && m.content) lines.push(m.content);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          lines.push(`\`\`\`tool:${tc.function.name}`);
          lines.push(tc.function.arguments);
          lines.push("```");
          lines.push("");
        }
      }
      lines.push("");
    } else if (m.role === "tool") {
      lines.push(`<details><summary>tool: ${m.name}</summary>`, "");
      lines.push("```");
      lines.push(m.content);
      lines.push("```");
      lines.push("</details>", "");
    } else if (m.role === "system") {
      lines.push("<details><summary>system</summary>", "");
      lines.push(m.content);
      lines.push("</details>", "");
    }
  }
  return lines.join("\n");
}

export const exportCommand: SlashCommand = {
  name: "export",
  description: "Export the current session to a markdown file (/export [path])",
  run: (args, ctx) => {
    const target =
      args.trim() || path.join(ctx.workspaceRoot, `session-${ctx.sessionId.slice(0, 8)}.md`);
    const md = renderSessionMarkdown(ctx);
    try {
      fs.mkdirSync(path.dirname(target) || ".", { recursive: true });
      fs.writeFileSync(target, md, "utf-8");
      console.log(chalk.gray(`  Exported ${ctx.messages.length} messages → ${target}`));
    } catch (e: any) {
      console.log(chalk.red(`  Could not write ${target}: ${e.message}`));
    }
  },
};

export default exportCommand;
