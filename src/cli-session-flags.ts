// ============================================================
// Session-level CLI flags — official Claude Code flag parity
// ------------------------------------------------------------
// KERNEL LAYER. Pure argv → value resolvers, no I/O and no
// process.env access, so every rule below is directly unit
// testable and can be reused by the CLI, the SDK entry and the
// headless runner without re-implementing the parsing.
//
// The official CLI (2.1.202) exposes `--tools`, `--effort`,
// `--name`, `--debug`, `--debug-file`, `--fallback-model` and
// `--disable-slash-commands`. Until now this project only
// resolved a subset of the session-level flags, so a user moving
// an existing command line over silently lost those controls.
//
// Deliberate deviations from the official flag set are documented
// in the `--help` text and in docs/claude-code差距评估-20261002.md;
// nothing here claims a capability the runtime does not have.
// ============================================================

import { EFFORT_LEVELS, type EffortLevel, parseEffort } from "./effort.js";
import { canonicalToolKey } from "./tools/utils/official-names.js";

/**
 * The `--tools` outcome.
 *
 * `all` is "no restriction" and is ALSO what an explicit `default`
 * resolves to, so downstream code only ever has to branch on the
 * two restricted shapes.
 */
export type ToolsSelection =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "allow"; keys: Set<string>; requested: string[] };

/** Collect every occurrence of `flag`, inline (`--flag=v`) and spaced (`--flag v`). */
function occurrences(argv: string[], flag: string): Array<{ inline: boolean; value?: string }> {
  const found: Array<{ inline: boolean; value?: string }> = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag) found.push({ inline: false });
    else if (arg.startsWith(`${flag}=`))
      found.push({ inline: true, value: arg.slice(flag.length + 1) });
  }
  return found;
}

/**
 * The value tokens for one occurrence.
 *
 * A spaced flag consumes following non-flag tokens (commander's
 * variadic behaviour, which the official `--tools <tools...>`
 * declaration relies on), so `--tools Read Grep` and
 * `--tools=Read,Grep` are the same request. An EMPTY token is
 * preserved: `--tools ""` is the documented way to disable every
 * tool, and dropping it here would silently turn it into "no flag".
 */
function valueTokens(argv: string[], index: number): string[] {
  const tokens: string[] = [];
  for (let i = index + 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("-")) break;
    tokens.push(arg);
  }
  return tokens;
}

/**
 * Resolve `--tools`.
 *
 * - no flag → undefined (no restriction)
 * - `default` → all tools
 * - `""` → no tools at all
 * - names → only those tools, compared through the SAME canonical
 *   name mapping used by execution and permission rules, so
 *   `Read`, `read` and `READ` all select this project's `read`.
 *
 * Repeated flags union their names. A bare `--tools` with no value
 * is a user error, not an empty selection: silently running with
 * every tool would be the wrong failure direction.
 */
export function parseToolsSelection(argv: string[]): ToolsSelection | undefined {
  const hits = occurrences(argv, "--tools");
  if (hits.length === 0) return undefined;
  const keys = new Set<string>();
  const requested: string[] = [];
  let sawEmpty = false;
  let sawAll = false;
  for (let h = 0; h < hits.length; h++) {
    const hit = hits[h]!;
    let tokens: string[];
    if (hit.inline) {
      tokens = [hit.value ?? ""];
    } else {
      const index = findFlagIndex(argv, "--tools", h);
      if (index < 0) throw new Error("--tools requires a value");
      const scanned = valueTokens(argv, index);
      if (scanned.length === 0) throw new Error("--tools requires a value");
      tokens = scanned;
    }
    for (const token of tokens) {
      // An ENTIRELY empty value is the documented "disable all tools" request.
      // Empty parts inside a list ("Read,") are just separators and must not
      // be read as that request.
      if (!token.trim()) {
        sawEmpty = true;
        continue;
      }
      for (const part of token.split(/[,\s]+/)) {
        const name = part.trim();
        if (!name) continue;
        if (name.toLowerCase() === "default") {
          sawAll = true;
          continue;
        }
        requested.push(name);
        keys.add(canonicalToolKey(name));
      }
    }
  }
  // Contradictory requests (`--tools Read --tools ""`, `--tools default --tools ""`)
  // resolve toward the RESTRICTIVE reading: an explicit empty value is the user
  // asking for a smaller surface, and silently widening it is the worse error.
  if (sawEmpty) return { kind: "none" };
  if (sawAll || keys.size === 0) return { kind: "all" };
  return { kind: "allow", keys, requested };
}

/** Index of the nth `--tools` occurrence in argv (inline or spaced). */
function findFlagIndex(argv: string[], flag: string, ordinal: number): number {
  let seen = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag || arg.startsWith(`${flag}=`)) {
      if (seen === ordinal) return i;
      seen++;
    }
  }
  return -1;
}

/** Does this tool survive the `--tools` selection? */
export function toolAllowed(selection: ToolsSelection | undefined, toolName: string): boolean {
  if (!selection || selection.kind === "all") return true;
  if (selection.kind === "none") return false;
  return selection.keys.has(canonicalToolKey(toolName));
}

/** `--effort <low|medium|high|xhigh|max|ultracode>`. Invalid values fail loudly. */
export function parseEffortFlag(argv: string[]): EffortLevel | undefined {
  const hits = occurrences(argv, "--effort");
  if (hits.length === 0) return undefined;
  const last = hits[hits.length - 1]!;
  const raw = last.inline
    ? last.value
    : valueTokens(argv, findFlagIndex(argv, "--effort", hits.length - 1)).join(" ");
  const value = (raw ?? "").trim();
  if (!value) throw new Error(`--effort requires a value (${EFFORT_LEVELS.join(", ")})`);
  const level = parseEffort(value);
  if (!level) throw new Error(`Unknown --effort "${value}". Levels: ${EFFORT_LEVELS.join(", ")}`);
  return level;
}

/**
 * `--fallback-model <a,b,c>` — comma separated, repeatable.
 *
 * No space-separated continuation here (unlike `--tools`): the
 * official flag documents a comma-separated list only, and
 * swallowing a following positional prompt would be a silent
 * data-loss bug.
 */
export function parseFallbackModels(argv: string[]): string[] | undefined {
  const hits = occurrences(argv, "--fallback-model");
  if (hits.length === 0) return undefined;
  const models: string[] = [];
  for (let h = 0; h < hits.length; h++) {
    const hit = hits[h]!;
    const raw = hit.inline
      ? (hit.value ?? "")
      : (() => {
          const index = findFlagIndex(argv, "--fallback-model", h);
          if (index < 0) return "";
          return argv[index + 1] && !argv[index + 1]!.startsWith("-") ? argv[index + 1]! : "";
        })();
    for (const part of raw.split(",")) {
      const name = part.trim();
      if (!name) continue;
      if (!models.includes(name)) models.push(name);
    }
  }
  return models;
}

export interface DebugFlags {
  enabled: boolean;
  /** debugLogger category filter; "all" when `--debug` carried no value. */
  filter: string;
  /** Sink path; when set, output goes to the file instead of stderr. */
  file?: string;
}

/** `--debug [filter]` and `--debug-file <path>` (the latter implies enabled). */
export function parseDebugFlags(argv: string[]): DebugFlags | undefined {
  const debug = occurrences(argv, "--debug");
  const file = occurrences(argv, "--debug-file");
  if (debug.length === 0 && file.length === 0) return undefined;
  let filter = "all";
  if (debug.length > 0) {
    const hit = debug[debug.length - 1]!;
    const raw = hit.inline
      ? (hit.value ?? "")
      : (() => {
          const next = argv[findFlagIndex(argv, "--debug", debug.length - 1) + 1];
          return next && !next.startsWith("-") ? next : "";
        })();
    if (raw.trim()) filter = raw.trim();
  }
  const flags: DebugFlags = { enabled: true, filter };
  if (file.length > 0) {
    const hit = file[file.length - 1]!;
    const raw = hit.inline
      ? (hit.value ?? "")
      : (argv[findFlagIndex(argv, "--debug-file", file.length - 1) + 1] ?? "");
    if (!raw.trim()) throw new Error("--debug-file requires a path");
    flags.file = raw.trim();
  }
  return flags;
}

/** `-n, --name <display name>` — a label for the session, not its id. */
export function parseSessionName(argv: string[]): string | undefined {
  for (const flag of ["--name", "-n"]) {
    const hits = occurrences(argv, flag);
    if (hits.length === 0) continue;
    const hit = hits[hits.length - 1]!;
    const raw = hit.inline
      ? (hit.value ?? "")
      : (argv[findFlagIndex(argv, flag, hits.length - 1) + 1] ?? "");
    const value = raw.trim();
    if (value) return value;
  }
  return undefined;
}

/** `--disable-slash-commands` — official spelling is "Disable all skills". */
export function parseDisableSlashCommands(argv: string[]): boolean {
  return argv.includes("--disable-slash-commands");
}

/**
 * Official `-w, --worktree [name]` — run the session in a fresh git worktree.
 *
 * The value is OPTIONAL (commander `[name]`), so a bare `-w` means "generate a
 * name". A bare flag is therefore valid and must not be rejected the way a
 * valueless `--tools` is: the two shapes are genuinely different.
 */
export function parseWorktreeFlag(argv: string[]): { name?: string } | undefined {
  for (const flag of ["--worktree", "-w"]) {
    const hits = occurrences(argv, flag);
    if (hits.length === 0) continue;
    const last = hits[hits.length - 1]!;
    if (!last.inline) {
      const next = argv[findFlagIndex(argv, flag, hits.length - 1) + 1];
      return next && !next.startsWith("-") && next.trim() ? { name: next.trim() } : {};
    }
    const name = (last.value ?? "").trim();
    return name ? { name } : {};
  }
  return undefined;
}

/**
 * Official `--include-hook-events` — hook lifecycle events in the stream.
 *
 * Boolean with no value, like `--include-partial-messages`.
 */
export function parseIncludeHookEvents(argv: string[]): boolean {
  return argv.includes("--include-hook-events");
}

/** Literal values the official `--prompt-suggestions [value]` accepts. */
const TRUTHY_FLAG_VALUES = ["1", "true", "yes", "on"];
const FALSY_FLAG_VALUES = ["0", "false", "no", "off"];

/**
 * Official `--prompt-suggestions [value]`.
 *
 * The value is OPTIONAL (commander `[value]`) and the official help documents
 * exactly eight literals: `true false 1 0 yes no on off`. The next token is
 * therefore consumed ONLY when it is one of them — `--prompt-suggestions
 * review the diff` must not swallow the positional prompt the way a naive
 * "take whatever follows" parser would.
 *
 * An unrecognized literal resolves to ENABLED: the user did ask for
 * suggestions, and reading an unknown token as "off" would silently drop a
 * feature they asked for.
 */
export function parsePromptSuggestions(argv: string[]): boolean {
  const hits = occurrences(argv, "--prompt-suggestions");
  if (hits.length === 0) return false;
  const last = hits[hits.length - 1]!;
  const raw = last.inline
    ? last.value
    : argv[findFlagIndex(argv, "--prompt-suggestions", hits.length - 1) + 1];
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (!value) return true;
  if (TRUTHY_FLAG_VALUES.includes(value)) return true;
  return !FALSY_FLAG_VALUES.includes(value);
}

export interface TmuxFlag {
  /** Any `--tmux` spelling on the line. */
  present: boolean;
  /** The inline value after `--tmux=`; undefined for the bare flag. */
  value?: string;
  /** `-w`, `--worktree` or `--worktree=<name>` is also on the line. */
  worktreeRequested: boolean;
}

/**
 * Official `--tmux`.
 *
 * Takes the FULL `process.argv` like `parseWorktreeFlag`, and drops
 * the first two entries before matching — official's fast path tests
 * `process.argv.slice(2)`, and the difference is observable: a prompt
 * passed as `-p "claude --tmux"` is one argv element in both, but
 * the leading node/script paths are only in ours.
 *
 * Matching is by exact element, not substring, and `value` records
 * the literal `=classic` official compares against. Official's help
 * advertises `--tmux=classic` while declaring the option value-less;
 * commander therefore rejects EVERY `--tmux=<v>` as an unknown
 * option, and the fast path only fires for the exact literal
 * `classic`. Both shapes are preserved here because both are
 * observable (`--tmux=classic -w x` and `--tmux=other -w x` take
 * different official code paths).
 */
export function parseTmuxFlag(argv: string[]): TmuxFlag {
  const args = argv.slice(2);
  const inline = args.find((arg) => arg.startsWith("--tmux="));
  const bare = args.includes("--tmux");
  const value = inline?.slice("--tmux=".length);
  return {
    present: bare || inline !== undefined,
    ...(value === undefined ? {} : { value }),
    worktreeRequested:
      args.includes("-w") ||
      args.includes("--worktree") ||
      args.some((arg) => arg.startsWith("--worktree=")),
  };
}

/**
 * Official `--brief` — "Enable SendUserMessage tool for agent-to-user
 * communication".
 *
 * Boolean with no value: the official help prints no `<value>` placeholder, so
 * there is nothing to consume and a bare `--brief` is the only valid shape.
 */
export function parseBriefFlag(argv: string[]): boolean {
  return argv.includes("--brief");
}

/**
 * Official `--file <specs...>` — "File resources to download at startup.
 * Format: file_id:relative_path".
 *
 * Variadic and repeatable, so this returns the RAW tokens and leaves the
 * `file_id:path` grammar (and the warnings it produces) to
 * startup-files.ts — argv parsing and domain rules stay in separate layers.
 *
 * A bare `--file` throws: commander declares `<specs...>` as required, and
 * treating it as "no files" would look exactly like the flag having worked.
 */
export function parseFileSpecTokens(argv: string[]): string[] {
  const hits = occurrences(argv, "--file");
  if (hits.length === 0) return [];
  const tokens: string[] = [];
  for (const [h, hit] of hits.entries()) {
    if (hit.inline) {
      if (hit.value !== undefined) tokens.push(hit.value);
      continue;
    }
    const index = findFlagIndex(argv, "--file", h);
    if (index < 0) throw new Error("--file requires at least one file_id:path spec");
    const scanned = valueTokens(argv, index);
    if (scanned.length === 0) throw new Error("--file requires at least one file_id:path spec");
    tokens.push(...scanned);
  }
  return tokens;
}

/**
 * Official `--betas <betas...>` — "Beta headers to include in API requests
 * (API key users only)".
 *
 * Variadic and repeatable, so this returns the RAW tokens and leaves the
 * allowlist rules to api-betas.ts (argv parsing and domain rules stay in
 * separate layers). A bare `--betas` throws: official declares `<betas...>` as
 * required, and swallowing it would look exactly like the flag having worked.
 */
export function parseBetaTokens(argv: string[]): string[] {
  const hits = occurrences(argv, "--betas");
  if (hits.length === 0) return [];
  const tokens: string[] = [];
  for (const [h, hit] of hits.entries()) {
    if (hit.inline) {
      if (hit.value !== undefined) tokens.push(hit.value);
      continue;
    }
    const index = findFlagIndex(argv, "--betas", h);
    if (index < 0) throw new Error("--betas requires at least one beta header value");
    const scanned = valueTokens(argv, index);
    if (scanned.length === 0) throw new Error("--betas requires at least one beta header value");
    tokens.push(...scanned);
  }
  return tokens;
}

/**
 * Official `--from-pr [value]` — "Resume a session linked to a PR by PR
 * number/URL, or open interactive picker with optional search term".
 *
 * The value is OPTIONAL (commander `[value]`, argParser `(s) => s || !0`),
 * so the two shapes are genuinely different: a bare `--from-pr` asks for the
 * interactive picker, and anything else is a PR number or URL. Emitting
 * `picker: true` for a bare flag — rather than rejecting it the way a
 * valueless `--tools` is rejected — is what the official declaration
 * actually does; the picker itself is unimplemented here and cli.ts says so.
 *
 * An EMPTY value (`--from-pr ""`) is the picker request too, because
 * commander's `s || !0` maps "" to `true`.
 */
export function parseFromPrFlag(
  argv: string[],
): { picker: true } | { picker: false; raw: string } | undefined {
  const hits = occurrences(argv, "--from-pr");
  const last = hits[hits.length - 1];
  if (!last) return undefined;
  const raw = last.inline
    ? last.value
    : (() => {
        const next = argv[findFlagIndex(argv, "--from-pr", hits.length - 1) + 1];
        return next && !next.startsWith("-") ? next : undefined;
      })();
  const value = (raw ?? "").trim();
  return value ? { picker: false, raw: value } : { picker: true };
}

/**
 * Official `--agents <json>` — agent definitions for THIS session only.
 *
 * Returns the raw JSON text; shape validation lives in agents/inlineAgents.ts
 * so this module stays free of agent-domain rules.
 */
export function parseInlineAgentsJson(argv: string[]): string | undefined {
  const hits = occurrences(argv, "--agents");
  if (hits.length === 0) return undefined;
  const last = hits[hits.length - 1]!;
  if (last.inline) {
    if (last.value === undefined) throw new Error("--agents requires a JSON object");
    return last.value;
  }
  const value = argv[findFlagIndex(argv, "--agents", hits.length - 1) + 1];
  if (value === undefined || value.startsWith("-"))
    throw new Error("--agents requires a JSON object");
  return value;
}

/**
 * Official `--agent <name>` — the agent for the current session.
 *
 * Unlike `--worktree` the value is REQUIRED: a bare `--agent` would otherwise
 * silently run with the default persona, which is indistinguishable from the
 * flag having worked.
 */
export function parseSessionAgent(argv: string[]): string | undefined {
  const hits = occurrences(argv, "--agent");
  if (hits.length === 0) return undefined;
  const last = hits[hits.length - 1]!;
  const raw = last.inline ? last.value : argv[findFlagIndex(argv, "--agent", hits.length - 1) + 1];
  // A value starting with "-" is the next flag, not an agent name. Accepting it
  // would make `--agent --print` select an agent literally named "--print" and
  // silently drop the print mode instead of reporting the mistake.
  if (raw === undefined || raw.startsWith("-")) throw new Error("--agent requires an agent name");
  const name = raw.trim();
  if (!name) throw new Error("--agent requires an agent name");
  return name;
}
