// ============================================================
// Disk Slash-Command Source — load <name>.md from .claude/commands/
// ============================================================
// Real Claude Code lets users define their own slash commands as Markdown
// files under `<root>/.claude/commands/` (and `~/.claude/commands/`). This
// module scans those directories and registers each file as a prompt-injection
// command: invoking `/<name> <args>` expands the file body (a prompt template)
// and hands it back through the normal `{ prompt }` result channel, so it runs
// through the agent loop exactly like a user-typed message.
//
// File shape:
//
//   ---
//   description: Draft a commit message from the diff
//   argument-hint: [scope]
//   allowed-tools: [read, bash]
//   model: sonnet
//   ---
//   Write a concise commit message for these changes. Focus: $ARGUMENTS
//
// Body substitution (at invocation, never at discovery):
//   $ARGUMENTS / ${ARGUMENTS} / ${ARGS} → the caller's argument string
//   $1 .. $9                            → positional args (whitespace-split)
//   !`shell command`                    → command stdout — TRUSTED SOURCES ONLY.
//
// User-scope commands may execute literal shell directives. Project commands
// are prompt-only and cannot expand environment values (see loadSkillsDir.ts).
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandDiskTemplate } from "../utils/disk-template.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { SlashCommand } from "./types.js";

/** User-scope commands root can be redirected for tests / sandboxes. */
const USER_COMMANDS_ENV = "CCR_USER_COMMANDS_DIR";

/** Roots scanned for disk commands, lowest → highest precedence (project wins). */
export function commandDirRoots(workspaceRoot: string): string[] {
  const userRoot = process.env[USER_COMMANDS_ENV] || path.join(os.homedir(), ".claude", "commands");
  return [userRoot, path.join(workspaceRoot, ".claude", "commands")];
}

/** Reject a command filename that would escape the commands root. */
function isSafeCommandName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name !== "." && name !== "..";
}

function asString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(", ") : v;
}

/** Project templates are prompt-only; user-scope templates may run literal commands. */
export async function expandCommandBody(
  body: string,
  opts: { args?: string; workspaceRoot?: string; trustedShell?: boolean },
): Promise<string> {
  return expandDiskTemplate(body, {
    ...opts,
    trustedShell: opts.trustedShell === true,
    positional: true,
  });
}

/** Build a prompt-injection SlashCommand from one parsed `.md` file. */
function commandFromFile(
  name: string,
  body: string,
  frontmatter: Record<string, string | string[]>,
  trustedShell: boolean,
): SlashCommand {
  const description = asString(frontmatter.description) || `Custom command "${name}"`;
  return {
    name,
    description,
    run: async (args, ctx) => ({
      prompt: await expandCommandBody(body, {
        args,
        workspaceRoot: ctx.workspaceRoot,
        trustedShell,
      }),
    }),
  };
}

// --- Registry ---
// Custom commands are registered at startup (loadCommandsDir) and consulted by
// handleSlashCommand alongside the built-in COMMANDS. Kept in this module (not
// commands.ts / registry.ts) so both the dispatch path and /help can reach it
// without an import cycle.

const CUSTOM_COMMANDS = new Map<string, SlashCommand>();

/** Register or override a custom command (used by loadCommandsDir and tests). */
export function registerCustomCommand(cmd: SlashCommand): void {
  CUSTOM_COMMANDS.set(cmd.name, cmd);
}

/** The custom commands registered so far, keyed by name. */
export function getCustomCommands(): Map<string, SlashCommand> {
  return CUSTOM_COMMANDS;
}

/** Test/util: clear all custom commands. */
export function resetCustomCommands(): void {
  CUSTOM_COMMANDS.clear();
}

/**
 * Scan the disk command roots and register every valid `<name>.md`. Returns the
 * names registered (project entries override same-named user entries). Missing
 * roots are skipped silently — disk commands are optional.
 */
export function loadCommandsDir(workspaceRoot: string): string[] {
  const loaded: string[] = [];
  for (const [index, root] of commandDirRoots(workspaceRoot).entries()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root doesn't exist — fine
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -".md".length);
      if (!isSafeCommandName(name)) continue;
      const file = path.join(root, entry.name);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const { frontmatter, body } = parseFrontmatter(raw);
      if (!body) continue; // a command with no prompt body is useless
      registerCustomCommand(commandFromFile(name, body, frontmatter, index === 0));
      loaded.push(name);
    }
  }
  return loaded;
}
