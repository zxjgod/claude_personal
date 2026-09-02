// ============================================================
// CLI interactive prompts — trust y/N, tool-permission prompts,
// and structured AskUserQuestion menus, for both TTY (raw-mode
// menus) and piped (line-based) sessions. Permission and question
// prompts share one mutex chain so concurrent tool calls never
// render two prompts at once.
// ============================================================

import * as readline from "node:readline";
import chalk from "chalk";

import { promptPermissionMenu, promptSelectMenu } from "./tui/cli-interactive.js";
import { renderPermissionPrompt } from "./tui/cli-renderer.js";
import type { AskUserFn, UserQuestion } from "./types.js";

/**
 * Plain-cooked-mode y/N question used for pre-REPL trust prompts (project
 * hooks). Dedicated short-lived readline so it never tangles with the raw-mode
 * input reader created later; defaults to NO on empty/garbage input.
 */
export function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Tool+target key identifying an "always allow" decision. */
export const permissionKey = (toolName: string, input: Record<string, unknown>): string => {
  const target =
    (typeof input.filePath === "string" && input.filePath) ||
    (typeof input.command === "string" && input.command) ||
    (typeof input.url === "string" && input.url) ||
    "";
  return `${toolName}::${target}`;
};

export interface UserPrompters {
  /** Session-scoped set of tool+target combos the user chose to always allow. */
  alwaysAllow: Set<string>;
  askUser: AskUserFn;
  askUserQuestion: (q: UserQuestion) => Promise<string[] | null>;
}

/**
 * Build the permission + structured-question callbacks. On TTY these draw
 * bordered selectable menus; otherwise they print text prompts read
 * line-by-line. Both are serialized through a single shared promise chain —
 * parallel tool calls must wait for the previous prompt to resolve.
 */
export function createUserPrompters(deps: {
  isInteractive: boolean;
  askQuestion: (prompt: string) => Promise<string | null>;
}): UserPrompters {
  const { isInteractive, askQuestion } = deps;
  const alwaysAllow = new Set<string>();
  let promptChain: Promise<unknown> = Promise.resolve();

  const askUserImpl: AskUserFn = async (tool, input, riskHint) => {
    const key = permissionKey(tool.name, input);
    // Already approved as "always" for this tool+target this session.
    if (alwaysAllow.has(key)) return true;

    if (isInteractive) {
      const detail =
        (typeof input.command === "string" && input.command) ||
        (typeof input.filePath === "string" && input.filePath) ||
        (typeof input.url === "string" && input.url) ||
        undefined;
      const choice = await promptPermissionMenu({
        header: `${tool.name[0]!.toUpperCase()}${tool.name.slice(1)} request`,
        detail,
        riskHint,
      });
      if (choice === "always") {
        alwaysAllow.add(key);
        // P2-2: Show confirmation feedback for "always allow"
        const target = detail || tool.name;
        console.log(chalk.green(`  ✓ 已记住: ${target} (本会话内不再询问)`));
        return true;
      }
      return choice === "yes";
    }

    renderPermissionPrompt(tool.name, input, riskHint);
    const raw = await askQuestion("     > ");
    // EOF while awaiting a permission decision → treat as deny (safe default).
    if (raw === null) return false;
    const answer = raw.trim().toLowerCase();

    if (answer === "a" || answer === "always") {
      alwaysAllow.add(key);
      // P2-2: Show confirmation feedback for "always allow"
      const target =
        (typeof input.command === "string" && input.command) ||
        (typeof input.filePath === "string" && input.filePath) ||
        tool.name;
      console.log(chalk.green(`  ✓ 已记住: ${target.slice(0, 50)} (本会话内不再询问)`));
      return true;
    }
    return answer === "y" || answer === "yes";
  };

  const askUser: AskUserFn = (tool, input, riskHint) => {
    const run = promptChain.then(() => askUserImpl(tool, input, riskHint));
    promptChain = run.catch(() => {});
    return run;
  };

  const askUserQuestionImpl = async (q: UserQuestion): Promise<string[] | null> => {
    if (isInteractive) {
      return promptSelectMenu({
        header: q.header,
        question: q.question,
        options: q.options,
        multiSelect: q.multiSelect,
      });
    }
    // Non-TTY: print the question + numbered options, read one line.
    console.log(`\n  ${chalk.bold(q.header)}: ${q.question}`);
    q.options.forEach((o, i) => {
      console.log(`    ${i + 1}. ${o.label}`);
    });
    const hint = q.multiSelect ? "numbers separated by commas" : "a number";
    const raw = await askQuestion(`  Choose ${hint}: `);
    if (raw === null) return null;
    const picks = raw
      .split(/[\s,]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => n >= 1 && n <= q.options.length)
      .map((n) => q.options[n - 1]!.label);
    return picks;
  };

  const askUserQuestion = (q: UserQuestion): Promise<string[] | null> => {
    const run = promptChain.then(() => askUserQuestionImpl(q));
    promptChain = run.catch(() => {}) as Promise<unknown>;
    return run;
  };

  return { alwaysAllow, askUser, askUserQuestion };
}
