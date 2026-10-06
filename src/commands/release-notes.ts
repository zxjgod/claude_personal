// ============================================================
// /release-notes — show what's new in this build
// ============================================================
// The startup banner advertises "/release-notes for more" under "What's new",
// which was a dead link: no such command existed. This implements it against
// the changelog shipped alongside the package (docs/CHANGELOG.md), mirroring
// the official client's behaviour of showing its own release notes rather than
// the current project's.
//
//   /release-notes        installed version only
//   /release-notes all    the whole changelog
// ============================================================

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { validateCurrentRelease } from "../release-notes.js";
import { renderMarkdown } from "../tui/markdown.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import { palette } from "../tui/theme.js";
import { APP_VERSION } from "../version.js";
import type { CommandResult, SlashCommand } from "./types.js";

const require_ = createRequire(import.meta.url);

/**
 * The package root, resolved relative to THIS module so it holds in dev
 * (src/commands/), local dist (dist/), and a global install. Same two-candidate
 * walk as version.ts, and for the same reason: `..` is correct in a flat
 * dist/build layout, `../..` only covers a nested emit — it must stay second,
 * or a stray package.json in the repo's PARENT directory would win.
 */
export function packageRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["..", "../.."]) {
    try {
      require_(`${here}/${rel}/package.json`);
      return resolve(here, rel);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export const releaseNotesCommand: SlashCommand = {
  name: "release-notes",
  description: "Show what's new in this version",
  run: (args): CommandResult | undefined => {
    const argument = args.trim().toLowerCase();
    if (argument && argument !== "all") {
      console.log(chalk.gray("  Usage: /release-notes [all]"));
      return { handled: true };
    }
    const root = packageRoot();
    const file = root ? resolve(root, "docs", "CHANGELOG.md") : null;
    if (!file || !existsSync(file)) {
      console.log(chalk.gray("  No changelog is bundled with this build."));
      return { handled: true };
    }

    let body: string;
    try {
      body = readFileSync(file, "utf-8");
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.log(chalk.red(`  Could not read ${file}: ${detail}`));
      return { handled: true };
    }

    const showAll = argument === "all";
    let text = body;
    if (!showAll) {
      try {
        text = validateCurrentRelease(body, APP_VERSION).markdown;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.log(chalk.yellow(`  ${sanitizeTerminalText(detail)}`));
        console.log(chalk.gray("  /release-notes all to inspect the bundled history."));
        return { handled: true };
      }
    }

    console.log(
      chalk
        .hex(palette.promptAccent)
        .bold(`  What's new · v${APP_VERSION}${showAll ? " (all releases)" : ""}`),
    );
    console.log();
    console.log(renderMarkdown(text));
    if (!showAll) {
      console.log(chalk.gray(`\n  /release-notes all for the full changelog (${file})`));
    }
    return { handled: true };
  },
};

export default releaseNotesCommand;
