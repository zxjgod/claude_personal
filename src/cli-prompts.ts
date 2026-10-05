// ============================================================
// CLI interactive prompts — trust y/N, tool-permission prompts,
// and structured AskUserQuestion menus, for both TTY (raw-mode
// menus) and piped (line-based) sessions. Permission and question
// prompts share one mutex chain so concurrent tool calls never
// render two prompts at once.
// ============================================================

import * as readline from "node:readline";
import chalk from "chalk";
import { logPermissionChange } from "./audit-log.js";
import { loadPersistentAlwaysAllow, savePersistentAlwaysAllow } from "./permission-policy.js";
import { promptPermissionMenu, promptSelectMenu } from "./tui/cli-interactive.js";
import { renderPermissionPrompt } from "./tui/cli-renderer.js";
import { sanitizeTerminalText } from "./tui/terminal-width.js";
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
  return `${toolName}::${target}${typeof input.__approvalFingerprint === "string" ? `::${input.__approvalFingerprint}` : ""}`;
};

export interface UserPrompters {
  /** Session-scoped set of tool+target combos the user chose to always allow. */
  alwaysAllow: Set<string>;
  askUser: AskUserFn;
  askUserQuestion: (q: UserQuestion) => Promise<string[] | null>;
  /**
   * M41 race guard: number of permission/question prompts currently awaiting
   * an answer. The scheduler must treat "prompt pending" as busy — otherwise
   * an injected cron line would answer the prompt outright (non-TTY: shared
   * readline queue) or start a competing turn while the permission menu still
   * owns stdin (TTY).
   */
  getPendingPromptCount(): number;
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
  const alwaysAllow = loadPersistentAlwaysAllow();
  let promptChain: Promise<unknown> = Promise.resolve();
  // M41: a prompt can be pending while NO turn is running — a background
  // agent's approver forwards here (run_in_background, team members).
  let pendingPromptCount = 0;

  const askUserImpl: AskUserFn = async (tool, input, riskHint) => {
    const key = permissionKey(tool.name, input);
    // Already approved as "always" for this tool+target this session.
    if (alwaysAllow.has(key)) return true;
    input = { ...input };
    delete input.__approvalFingerprint;

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
        savePersistentAlwaysAllow(alwaysAllow);
        // Top10 follow-up A8: an always-allow grant CHANGES the security
        // posture — it must leave an audit trail (permission_change was a
        // declared-but-never-written operation type).
        void logPermissionChange({
          change: `always-allow: ${key}`,
          workspaceRoot: process.env.WORKSPACE_ROOT || process.cwd(),
        }).catch(() => {});
        // P2-2: Show confirmation feedback for "always allow"
        const target = detail || tool.name;
        // The target is the model-proposed command/path — sanitize the echo.
        console.log(chalk.green(`  ✓ 已记住: ${sanitizeTerminalText(target)} (本会话内不再询问)`));
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
      savePersistentAlwaysAllow(alwaysAllow);
      void logPermissionChange({
        change: `always-allow: ${key}`,
        workspaceRoot: process.env.WORKSPACE_ROOT || process.cwd(),
      }).catch(() => {});
      // P2-2: Show confirmation feedback for "always allow"
      const target =
        (typeof input.command === "string" && input.command) ||
        (typeof input.filePath === "string" && input.filePath) ||
        tool.name;
      console.log(
        chalk.green(`  ✓ 已记住: ${sanitizeTerminalText(target.slice(0, 50))} (本会话内不再询问)`),
      );
      return true;
    }
    return answer === "y" || answer === "yes";
  };

  const askUser: AskUserFn = (tool, input, riskHint) => {
    pendingPromptCount++;
    const run = promptChain.then(() => askUserImpl(tool, input, riskHint));
    promptChain = run.catch(() => {});
    return run.finally(() => {
      pendingPromptCount--;
    });
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
    // Question fields are model input (ask_user_question) — sanitize.
    console.log(
      `\n  ${chalk.bold(sanitizeTerminalText(q.header))}: ${sanitizeTerminalText(q.question)}`,
    );
    q.options.forEach((o, i) => {
      console.log(`    ${i + 1}. ${sanitizeTerminalText(o.label)}`);
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
    pendingPromptCount++;
    const run = promptChain.then(() => askUserQuestionImpl(q));
    promptChain = run.catch(() => {}) as Promise<unknown>;
    return run.finally(() => {
      pendingPromptCount--;
    });
  };

  return {
    alwaysAllow,
    askUser,
    askUserQuestion,
    getPendingPromptCount: () => pendingPromptCount,
  };
}
