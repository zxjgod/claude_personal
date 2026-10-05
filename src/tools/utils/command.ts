// ============================================================
// Command Utilities for Tools
// ============================================================

import { isBlockedPath } from "../../permissions.js";

// Home references that are safe to resolve in a path. Any other `$VAR`/`%VAR%`
// in a path-like argument may expand to a secret location, so it fails closed.
const HOME_ENV_RE = /\$HOME|\$\{HOME\}|\$USERPROFILE|%USERPROFILE%/gi;

/**
 * Detect whether a shell command's arguments reference a blocked path (secrets,
 * credentials, VCS internals, shell startup files). Shell commands carry a raw
 * string rather than a structured `filePath`, so the permission layer's
 * blocked-path floor cannot see their targets. This extracts path-like
 * arguments and delegates to the same `isBlockedPath` rules used by Read/Write/
 * Edit — so a secret reached via `~`, `$HOME`, an absolute path, or a `./`/`../`
 * spelling is caught identically.
 *
 * Fail-closed on variable expansion we cannot resolve: a `$VAR`/`%VAR%` other
 * than the home references above, embedded in a path-like argument, may resolve
 * to a secret location.
 */
export function commandReferencesBlockedPath(command: string): boolean {
  for (const segment of command.replaceAll("\\", "/").split(/&&|\|\||[|;&]/)) {
    const tokens = segment
      .trim()
      .split(/[\s"'`]+/)
      .filter(Boolean);
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (isBlockedPath(token)) return true;
      // Named shell arguments can carry a path after '=' or PowerShell ':'.
      const optionValue = /^--?[\w-]+[=:](.*)$/.exec(token)?.[1];
      if (optionValue && isBlockedPath(optionValue)) return true;
      if (/[$%]/.test(token) && /[/~.]/.test(token)) {
        if (/[$%]/.test(token.replace(HOME_ENV_RE, ""))) return true;
      }
    }
  }
  return false;
}

// Canonical sensitive paths, mirroring BLOCKED_PATTERNS in permissions.ts.
// Used to decide whether a wildcard argument could expand into blocked
// territory — the wildcard form of the same floor that literal arguments get
// via isBlockedPath.
const SECRET_PATH_SAMPLES = [
  ".env",
  ".env.local",
  "credentials.json",
  ".npmrc",
  ".git-credentials",
  ".netrc",
  ".ssh/id_rsa",
  ".ssh/config",
  ".aws/credentials",
  ".kube/config",
  ".docker/config.json",
  ".azure/accessTokens.json",
  ".config/gh/hosts.yml",
  ".config/gcloud/credentials.db",
  "/etc/passwd",
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/ssl/cert.pem",
  "/proc/self/environ",
  ".git/config",
  ".claude/settings.json",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".config/fish/config.fish",
];
const SECRET_DIR_SAMPLES = [
  ".ssh",
  ".aws",
  ".kube",
  ".docker",
  ".azure",
  ".git",
  ".claude",
  ".config",
];

/** Translate a shell/PowerShell wildcard pattern into an anchored RegExp.
 *  `*` crosses separators (the conservative reading — PowerShell's does),
 *  `?` matches one char, `[...]` passes through as a regex class. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: $" is a literal glob metachar, not an interpolation hole
    else if ("+.^${}()|".includes(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`, "i");
}

/**
 * Could this wildcard argument expand to a blocked secret path? Fail-closed:
 * a pattern we cannot translate (e.g. a malformed `[` class) counts as a
 * match, routing the command through approval. Literal (non-wildcard)
 * arguments are handled by the isBlockedPath checks instead.
 */
export function wildcardCouldReachSecretPath(token: string): boolean {
  const normalized = token.replaceAll("\\", "/");
  if (!/[*?[]/.test(normalized)) return false;
  let re: RegExp;
  try {
    re = globToRegExp(normalized);
  } catch {
    return true;
  }
  // Test bare samples (`*` in cwd) and samples under the pattern's literal
  // directory prefix (`src/*` → `src/.env`), because shell `*` and PowerShell
  // wildcards both reach dotfiles in the target directory.
  const slash = normalized.lastIndexOf("/");
  const dirPrefix = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  for (const sample of [...SECRET_PATH_SAMPLES, ...SECRET_DIR_SAMPLES]) {
    if (re.test(sample)) return true;
    if (dirPrefix && re.test(dirPrefix + sample)) return true;
  }
  return false;
}

/**
 * Decide whether a shell command is read-only (M29). Read-only ⇒ auto-approved
 * + safe to run concurrently. This is intentionally CONSERVATIVE: it returns
 * true only when every segment is a known read-only command with no shell
 * features that could hide a write. Anything uncertain ⇒ false (mutating), so
 * the command routes through approval and runs serially.
 *
 * Heuristics:
 *  - Reject command substitution / process substitution / backticks globally
 *    (`$(...)`, `<(...)`, `>(...)`, `` `...` ``) — they hide side effects even
 *    inside an otherwise-read-only segment. Newlines are rejected for the same
 *    reason: they chain commands (e.g. "ls\nrm -rf /") and the per-segment
 *    check below only splits on |, &&, ||, ;.
 *  - Redirects and shell metacharacters are rejected in UNQUOTED tokens only.
 *    Quoted arguments are data: `grep "(a|b)" src` or `grep "->" src` are
 *    ordinary read-only searches and must stay auto-approved.
 *  - Split on `|`, `&&`, `||`, `;`, `&` and require EVERY segment's leading word
 *    to be in the read-only allowlist. A bare `&` is a command separator in
 *    BOTH bash (background + continue) and cmd.exe (unconditional separator,
 *    which is what the Bash tool actually runs under on Windows) — omitting it
 *    let `ls & rm -rf x` pass as read-only on the strength of `ls` alone.
 *  - Wildcards (`ls *.ts`) stay auto-approved for allowlisted leaders UNLESS
 *    the pattern could expand to a blocked secret path (`cat *`, `cat cred*`,
 *    `cat .e*` → approval; see wildcardCouldReachSecretPath). For `git` ANY
 *    unquoted wildcard requires approval — an expanded filename like
 *    `--output=x` would arrive as a FLAG, and git's diff options include
 *    file-writing flags.
 *  - `git` is special-cased: only a fixed set of read-only subcommands count.
 */
export function bashCommandIsReadOnly(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  const cmd = command.trim();
  if (!cmd) return false;

  // Substitution forms hide side effects anywhere in the command, quoted or
  // not (a backtick inside double quotes still substitutes in bash).
  if (/[`]/.test(cmd) || /\$\(|<\(|>\(/.test(cmd) || /\btee\b/.test(cmd)) return false;

  // Shell reads do not carry a structured filePath, so the permission layer
  // cannot apply its blocked-path floor to them. Full environment dumps and any
  // secret/credential/VCS target route through approval instead.
  if (/\bprintenv\b|\b(env|set)\s*$/i.test(cmd)) return false;
  if (commandReferencesBlockedPath(cmd)) return false;

  // Newlines can chain commands (e.g. "ls\nrm -rf /") and bypass the
  // per-segment read-only check below, which only splits on |, &&, ||, ;.
  if (/[\r\n]/.test(cmd)) return false;

  // Read-only command leaders. Kept tight; expand deliberately.
  //
  // Deliberately EXCLUDED despite looking read-only:
  //  - find — `-exec`/`-execdir`/`-delete`/`-ok` run or delete arbitrarily
  //  - env  — `env CMD …` executes CMD; use `printenv` to list the environment
  // rg preprocessors, sort/uniq output files, pagers, and system setters
  // (date/hostname) also require approval even when used for inspection.
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
    "stat",
    "which",
    "type",
    "printenv",
    "whoami",
    "uname",
    "df",
    "du",
    "diff",
    "cmp",
    "cut",
    // NOTE: sed and awk are intentionally omitted from the read-only list.
    // - sed -i (--in-place) modifies files in place
    // - awk can execute arbitrary commands via system(), getline |, etc.
    // These should always go through approval even for seemingly safe usage.
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
  // (create a tag, add a remote, set a value, delete a branch). Positional
  // arguments to the listed subcommands are revisions, paths, or patterns —
  // never operations. `reflog` stays out because its sub-verbs can mutate
  // (`reflog expire`) and a positional-only check cannot tell `reflog show`
  // from `reflog expire`; `cat-file` is useless without its unallowlisted
  // -p/-t flags. Every flag must still match safeFlags below, which excludes
  // output files (--output), external helpers (--ext-diff, -O) and config
  // overrides.
  const GIT_READONLY = new Set([
    "status",
    "log",
    "diff",
    "show",
    "blame",
    "grep",
    "ls-files",
    "rev-parse",
    "describe",
    "ls-tree",
    "shortlog",
  ]);

  const segments = cmd.split(/&&|\|\||[|;&]/g);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    // Only whole quoted arguments are supported. Concatenated/escaped shell
    // words can disguise options; uncertain syntax requires approval.
    const tokens = trimmed.match(/"[^"$]*"|'[^']*'|[^\s"']+/g) ?? [];
    if (tokens.join(" ") !== trimmed.replace(/\s+/g, " ")) return false;
    const words = tokens.map((t) => t.replace(/^(['"])(.*)\1$/, "$2"));
    const isGit = tokens[0] === "git";
    for (const token of tokens) {
      // Single quotes are fully literal in bash and inert in cmd.exe.
      if (token.startsWith("'")) continue;
      if (token.startsWith('"')) {
        // Double quotes are literal except for backslash escapes; `$` is
        // already excluded by the tokenizer above. A backslash here would
        // alter the word boundary the join-check relies on.
        if (token.includes("\\")) return false;
        continue;
      }
      // Unquoted: shell-active characters can redirect (`>`, `<`), escape
      // (`^` in cmd.exe), expand (`%VAR%`, `!VAR!` with delayed expansion),
      // or start a subshell.
      if (/[()<>^!%]/.test(token)) return false;
      // Backslashes are allowed as Windows path separators, but never before
      // a character they would escape into a different token type.
      if (/\\['"`$\\]/.test(token)) return false;
      // Unresolved variable expansion may point at a secret location — only
      // the home references are resolvable enough to trust.
      if (token.includes("$") && !/^\$(?:HOME|USERPROFILE)(?:\/[^$]*)?$/.test(token)) return false;
      // Unquoted wildcards expand to filenames this static check cannot see.
      // For git, ANY expansion is rejected: an expanded `--output=…` filename
      // would arrive as a flag. For allowlisted read-only leaders, expansion
      // can only produce more read targets — auto-approve unless the pattern
      // could reach a blocked secret path (`cat *`, `cat cred*`, `cat .e*`).
      if (/[*?[\]]/.test(token) && (isGit || wildcardCouldReachSecretPath(token))) return false;
    }
    const leader = tokens[0];
    if (!leader) return false;
    if (leader === "git") {
      // No global config, alternate executable, output, or external helper
      // options. More complex Git operations must go through approval.
      const sub = words[1];
      if (!sub || !GIT_READONLY.has(sub)) return false;
      const safeFlags =
        /^(--|--(?:short|branch|porcelain(?:=v?[12])?|oneline|stat|name-only|name-status|all|cached|deleted|modified|others|exclude-standard|show-toplevel|is-inside-work-tree|abbrev-ref|tags|always|long|first-parent|no-merges|reverse|no-pager)|-[bsz]|-n\d+|--max-count=\d+)$/;
      if (words.slice(2).some((t) => t.startsWith("-") && !safeFlags.test(t))) return false;
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
 * Each pipeline stage must be an exact known command; expressions, variable
 * expansion and invocation syntax require approval. Wildcard arguments
 * (`Get-ChildItem *.ts`) stay auto-approved UNLESS the pattern could expand to
 * a blocked secret path (`Get-Content .e*` → approval): with the stage leaders
 * pinned to the exact read-only set, a wildcard can only widen WHAT is read,
 * never turn a stage into a write.
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
  if (/[`$()<>;&\r\n{}]/.test(cmd)) return false;
  if (commandReferencesBlockedPath(cmd) || /\benv:/i.test(cmd)) return false;

  const segments = cmd.split(/\|/g);
  const READONLY_COMMANDS = new Set([
    "get-childitem",
    "get-content",
    "get-item",
    "get-location",
    "get-date",
    "get-process",
    "get-service",
    "test-path",
    "where-object",
    "select-object",
    "sort-object",
    "group-object",
    "measure-object",
    "compare-object",
    "format-table",
    "format-list",
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
  ]);
  const READONLY_ALIASES = new Set(["cat", "gc", "ls", "dir", "pwd", "gl", "gci", "type"]);

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const quotedTokens = trimmed.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g) ?? [];
    if (quotedTokens.join(" ") !== trimmed.replace(/\s+/g, " ")) return false;
    for (const t of quotedTokens) {
      const value = t.replace(/^(['"])(.*)\1$/, "$2");
      if (isBlockedPath(value)) return false;
      // PowerShell expands wildcards even inside quotes, so quoted tokens get
      // the same secret-path floor as the literal check above (`Get-Content
      // .e*` could expand to `.env`).
      if (wildcardCouldReachSecretPath(value)) return false;
    }
    const leader = (tokens[0] ?? "").toLowerCase();
    if (!leader) return false;
    if (READONLY_ALIASES.has(leader)) continue;
    if (!READONLY_COMMANDS.has(leader)) return false;
  }
  return true;
}
