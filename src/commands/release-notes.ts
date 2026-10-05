// ============================================================
// /release-notes — show what's new in this build
// ============================================================
// The startup banner advertises "/release-notes for more" under "What's new",
// which was a dead link: no such command existed. This implements it against
// the changelog shipped alongside the package (docs/CHANGELOG.md), mirroring
// the official client's behaviour of showing its own release notes rather than
// the current project's.
//
//   /release-notes        most recent entry only
//   /release-notes all    the whole changelog
// ============================================================

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
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

/** Default line cap — enough for one entry, short of flooding the transcript. */
const MAX_LINES = 60;

/**
 * Trim the changelog to its most recent entry. The file separates releases
 * with `---` rules, so the first block after the document header is the newest.
 * Exported for unit testing.
 */
export function latestEntry(changelog: string): string {
  const lines = changelog.split("\n");
  // Find the second "## " heading — everything before it is the newest release.
  const headings: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) headings.push(i);
  }
  const end = headings.length > 1 ? headings[1]! : lines.length;
  // Drop a trailing "---" separator so the entry doesn't end on a rule.
  let stop = end;
  while (stop > 0 && (lines[stop - 1]!.trim() === "" || lines[stop - 1]!.trim() === "---")) stop--;
  return lines.slice(0, stop).join("\n");
}

export const releaseNotesCommand: SlashCommand = {
  name: "release-notes",
  description: "Show what's new in this version",
  run: (args): CommandResult | undefined => {
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

    const showAll = args.trim().toLowerCase() === "all";
    const text = showAll ? body.trim() : latestEntry(body).trim();
    const lines = text.split("\n");
    const shown = showAll ? lines : lines.slice(0, MAX_LINES);

    console.log(chalk.hex("#d77757").bold("  What's new"));
    console.log();
    // Changelog body is a file read from the package root (repo file in a
    // source checkout) — sanitize the lines before printing them verbatim.
    console.log(sanitizeTerminalText(shown.join("\n")));

    const hidden = lines.length - shown.length;
    if (hidden > 0) {
      console.log(chalk.gray(`\n  … ${hidden} more lines — /release-notes all, or read ${file}`));
    } else if (!showAll) {
      console.log(chalk.gray(`\n  /release-notes all for the full changelog (${file})`));
    }
    return { handled: true };
  },
};

export default releaseNotesCommand;
