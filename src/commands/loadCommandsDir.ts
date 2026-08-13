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
// Commands are authored by the user on their own machine, so shell expansion
// runs (same trust model as disk skills). See loadSkillsDir.ts.
// ============================================================

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { SlashCommand } from "./types.js";

const execFileAsync = promisify(execFile);

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

function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v)
    ? v
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Split args on whitespace into positional tokens (for `$1`..`$9`). */
function positionalArgs(args: string): string[] {
  return args.split(/\s+/).filter(Boolean);
}

/**
 * Expand a trusted disk-command body. `$ARGUMENTS` / `${ARGUMENTS}` / `${ARGS}`
 * and `$1`..`$9` always substitute; `` !`cmd` `` shell expansion runs (commands
 * are trusted, authored locally). A failed shell command degrades to an inline
 * note rather than aborting the expansion.
 */
export async function expandCommandBody(
  body: string,
  opts: { args?: string; workspaceRoot?: string },
): Promise<string> {
  const args = opts.args ?? "";
  const positional = positionalArgs(args);

  let out = body.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    if (name === "ARGUMENTS" || name === "ARGS") return args;
    const env = process.env[name];
    return env ?? "";
  });
  // Bare `$ARGUMENTS` / `$ARGS`, then positional `$1`..`$9`.
  out = out.replace(/\$(ARGUMENTS|ARGS)\b/g, (_m, name: string) => {
    return name === "ARGUMENTS" || name === "ARGS" ? args : "";
  });
  out = out.replace(/\$([1-9])\b/g, (_m, idx: string) => positional[Number(idx) - 1] ?? "");

  // !`cmd` — run each, splice stdout in.
  const matches = [...out.matchAll(/!`([^`]+)`/g)];
  for (const match of matches) {
    const cmd = match[1]!.trim();
    let replacement: string;
    try {
      const { stdout } = await execFileAsync(
        process.platform === "win32" ? "cmd" : "sh",
        process.platform === "win32" ? ["/c", cmd] : ["-c", cmd],
        { cwd: opts.workspaceRoot ?? process.cwd(), timeout: 10_000, windowsHide: true },
      );
      replacement = stdout.trimEnd();
    } catch (error: any) {
      replacement = `[shell expansion failed: ${error?.message ?? String(error)}]`;
    }
    out = out.replace(match[0], replacement);
  }
  return out;
}

/** Build a prompt-injection SlashCommand from one parsed `.md` file. */
function commandFromFile(
  name: string,
  body: string,
  frontmatter: Record<string, string | string[]>,
): SlashCommand {
  const description = asString(frontmatter.description) || `Custom command "${name}"`;
  return {
    name,
    description,
    run: async (args, ctx) => ({
      prompt: await expandCommandBody(body, { args, workspaceRoot: ctx.workspaceRoot }),
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
  for (const root of commandDirRoots(workspaceRoot)) {
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
      registerCustomCommand(commandFromFile(name, body, frontmatter));
      loaded.push(name);
    }
  }
  return loaded;
}
