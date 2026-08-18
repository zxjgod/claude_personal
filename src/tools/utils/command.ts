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
 *  - Split on `|`, `&&`, `||`, `;`, `&` and require EVERY segment's leading word
 *    to be in the read-only allowlist. A bare `&` is a command separator in
 *    BOTH bash (background + continue) and cmd.exe (unconditional separator,
 *    which is what the Bash tool actually runs under on Windows) — omitting it
 *    let `ls & rm -rf x` pass as read-only on the strength of `ls` alone.
 *  - `git` is special-cased: only a fixed set of read-only subcommands count.
 */
export function bashCommandIsReadOnly(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  const cmd = command.trim();
  if (!cmd) return false;

  // Any of these shell features can write or hide side effects — bail out.
  if (/[`]|\$\(|<\(|>>|>|\btee\b/.test(cmd)) return false;

  // Newlines can chain commands (e.g. "ls\nrm -rf /") and bypass the
  // per-segment read-only check below, which only splits on |, &&, ||, ;.
  if (/[\r\n]/.test(cmd)) return false;

  // Read-only command leaders. Kept tight; expand deliberately.
  //
  // Deliberately EXCLUDED despite looking read-only:
  //  - find — `-exec`/`-execdir`/`-delete`/`-ok` run or delete arbitrarily
  //  - env  — `env CMD …` executes CMD; use `printenv` to list the environment
  // Anything that can hide a write must route through approval.
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
    "stat",
    "file",
    "which",
    "type",
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
    // NOTE: sed and awk are intentionally omitted from the read-only list.
    // - sed -i (--in-place) modifies files in place
    // - awk can execute arbitrary commands via system(), getline |, etc.
    // These should always go through approval even for seemingly safe usage.
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

  const segments = cmd.split(/&&|\|\||[|;&]/g);
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

/**
 * Decide whether a PowerShell command is read-only. FAR more conservative than
 * the bash heuristic — PowerShell's aliases, `&` call operator, `.` dot-sourcing,
 * and object pipelines make static analysis treacherous, so only a small set of
 * clearly-read-only `Get-*`/`Test-*` cmdlets (plus safe aliases) is trusted.
 * Anything with `|` (pipeline could run a mutating cmdlet), redirection, `$(...)`,
 * backticks, or `&`/`.` invocation is treated as mutating.
 */
export function powershellCommandIsReadOnly(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  const cmd = command.trim();
  if (!cmd) return false;

  // Shell features that can write or hide side effects → not read-only.
  // `{`/`}` reject script blocks (`Where-Object { Remove-Item … }`, calculated
  // properties `@{e={…}}`), which run arbitrary statements even under an
  // otherwise-read-only cmdlet prefix.
  //
  // `&` (call operator) and `;` (statement separator) are matched as BARE
  // characters — not `\b`-anchored. A word boundary never exists between `;`
  // and a following space/quote (both non-word chars), so `&\b`/`;\b` let
  // `Get-Date ; Remove-Item …` slip through as "read-only".
  if (/[`]|\$\(|>>|>|<\(|&|;|\n|\r|\{|\}/.test(cmd)) return false;

  const segments = cmd.split(/\|/g);
  const READONLY_PREFIXES = [
    "get-",
    "test-",
    "where-object",
    "select-object",
    "sort-object",
    "group-object",
    "measure-object",
    "compare-object",
    "format-",
    "convertto-json",
    "convertfrom-json",
    "out-string",
    "resolve-path",
    "split-path",
    "join-path",
    "write-output",
    "write-host",
    "write-verbose",
    "echo",
  ];
  const READONLY_ALIASES = new Set(["cat", "gc", "ls", "dir", "pwd", "gl", "gci", "type"]);

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const leader = (tokens[0] ?? "").toLowerCase();
    if (!leader) return false;
    if (READONLY_ALIASES.has(leader)) continue;
    if (!READONLY_PREFIXES.some((p) => leader.startsWith(p))) return false;
  }
  return true;
}
