// /onboarding — first-use guided setup (M18.7)
// ============================================================
// Checks the workspace for the basics (CLAUDE.md, .env, build) and, if
// anything's missing, injects a prompt that walks the model through creating
// them. Extends /init: /init only writes CLAUDE.md; /onboarding also checks
// the API/env/build and produces a step-by-step setup plan. Mirrors B's
// `commands/onboarding`.
// ============================================================
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { CommandContext, CommandResult, SlashCommand } from "./types.js";

interface OnboardingCheck {
  ok: boolean;
  label: string;
  hint?: string;
}

function diagnose(ctx: CommandContext): OnboardingCheck[] {
  const checks: OnboardingCheck[] = [];
  const claudeMd = path.join(ctx.workspaceRoot, "CLAUDE.md");
  checks.push({
    ok: fs.existsSync(claudeMd),
    label: "CLAUDE.md project memory",
    hint: fs.existsSync(claudeMd) ? undefined : "missing — /init can scaffold one",
  });
  checks.push({
    ok: Boolean(ctx.modelConfig.apiKey),
    label: "LLM_API_KEY",
    hint: ctx.modelConfig.apiKey ? undefined : "missing — set in .env",
  });
  checks.push({
    ok: fs.existsSync(".env"),
    label: ".env file",
    hint: fs.existsSync(".env") ? undefined : "missing — copy .env.example",
  });
  checks.push({
    ok: fs.existsSync("dist/cli.js"),
    label: "build (dist/cli.js)",
    hint: fs.existsSync("dist/cli.js") ? undefined : "not built — run npm run build",
  });
  checks.push({
    ok: ctx.messages.length > 0,
    label: "started a conversation",
    hint: ctx.messages.length > 0 ? undefined : "just say hi to begin",
  });
  return checks;
}

export const onboardingCommand: SlashCommand = {
  name: "onboarding",
  description: "First-use guided setup: check CLAUDE.md/.env/build and get started",
  run: (_args, ctx): CommandResult | void => {
    const checks = diagnose(ctx);
    console.log("");
    console.log(chalk.bold("  Onboarding check:"));
    for (const c of checks) {
      const mark = c.ok ? chalk.green("✓") : chalk.yellow("!");
      const line = `    ${mark} ${c.label}`;
      console.log(c.hint ? `${line} — ${chalk.gray(c.hint)}` : line);
    }

    const missing = checks.filter((c) => !c.ok);
    if (missing.length === 0) {
      console.log(chalk.gray("\n  Everything looks ready. You're good to go!"));
      return;
    }

    // Inject a prompt so the model actively helps fix the gaps.
    const gapList = missing.map((c) => `- ${c.label}${c.hint ? ` (${c.hint})` : ""}`).join("\n");
    const prompt = [
      `Help the user finish first-use onboarding for this workspace at \`${ctx.workspaceRoot}\`.`,
      ``,
      `These onboarding checks are not yet satisfied:`,
      gapList,
      ``,
      `For each gap:`,
      `1. Briefly explain why it matters.`,
      `2. Take the smallest safe action to fix it (e.g. scaffold a CLAUDE.md from the project layout, point to .env.example).`,
      `3. Do NOT create or overwrite files the user already has; ask first if uncertain.`,
      `End with a one-line "you're ready" summary once the gaps are addressed.`,
    ].join("\n");

    console.log(chalk.gray(`\n  ${missing.length} gap(s) found — handing off to the assistant…`));
    return { handled: true, prompt };
  },
};

export default onboardingCommand;
