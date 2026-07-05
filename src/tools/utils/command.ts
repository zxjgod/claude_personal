// ============================================================
// Command Utilities for Tools
// ============================================================

/**
 * Decide whether a shell command is read-only (M29). Read-only ⇒ auto-approved
 * + safe to run concurrently. This is intentionally CONSERVATIVE: it returns
 * true only when every segment is a known read-only command with no shell
 * features that could hide a write. Anything uncertain ⇒ false (mutating), so
 * the command routes through approval and runs serially.
 *
 * Heuristics:
 *  - Reject command substitution / process substitution / backticks / redirects
 *    (`$(...)`, `<(...)`, `` `...` ``, `>`, `>>`) — they can write or smuggle
 *    side effects.
 *  - Split on `|`, `&&`, `||`, `;` and require EVERY segment's leading word to
 *    be in the read-only allowlist.
 *  - `git` is special-cased: only a fixed set of read-only subcommands count.
 */
export function bashCommandIsReadOnly(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  const cmd = command.trim();
  if (!cmd) return false;

  // Any of these shell features can write or hide side effects — bail out.
  if (/[`]|\$\(|<\(|>>|>|\btee\b/.test(cmd)) return false;

  // Read-only command leaders. Kept tight; expand deliberately.
  const READONLY = new Set([
    "cat",
    "ls",
    "pwd",
    "echo",
    "head",
    "tail",
    "wc",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "find",
    "stat",
    "file",
    "which",
    "type",
    "env",
    "printenv",
    "date",
    "whoami",
    "hostname",
    "uname",
    "df",
    "du",
    "ps",
    "tree",
    "diff",
    "cmp",
    "sort",
    "uniq",
    "cut",
    "awk",
    "sed",
    "less",
    "more",
    "realpath",
    "dirname",
    "basename",
    "readlink",
    "true",
    "false",
    "test",
  ]);
  // git subcommands that never mutate the repo or working tree. Kept strict:
  // `tag`/`remote`/`config`/`branch` are omitted because they can write
  // (create a tag, add a remote, set a value, delete a branch).
  const GIT_READONLY = new Set([
    "status",
    "log",
    "diff",
    "show",
    "ls-files",
    "rev-parse",
    "blame",
    "describe",
    "ls-tree",
    "cat-file",
    "shortlog",
    "grep",
    "reflog",
    "whatchanged",
  ]);

  const segments = cmd.split(/\||&&|\|\||;/g);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const leader = tokens[0];
    if (!leader) return false;
    if (leader === "git") {
      // First non-flag token after `git` is the subcommand.
      const sub = tokens.slice(1).find((t) => !t.startsWith("-"));
      if (!sub || !GIT_READONLY.has(sub)) return false;
      continue;
    }
    if (!READONLY.has(leader)) return false;
  }
  return true;
}
