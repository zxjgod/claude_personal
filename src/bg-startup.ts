// ============================================================
// Official `--bg` / `--background` + the background-agent surface
// ------------------------------------------------------------
// KERNEL LAYER. argv → decision, plus the pure helpers that encode
// official's exact wording. Read out of the official 2.1.202 win32
// binary and then confirmed by running it (see
// docs/更新日志/20261003-bg-flag.md).
//
// THIS PROJECT IMPLEMENTS THE DECISION LAYER ONLY. There is no
// daemon, no PTY roster, no job store, no attach multiplexer, so
// every path that would touch a process or the filesystem ends in a
// NAMED refusal. What is reproduced faithfully is the part that can
// be observed from outside: the feature gate, the preflight conflict
// checks, the six hidden subcommands, and the exact messages.
//
// The help text is wrong about this feature in three separate ways:
//
// 1. `claude --help` lists exactly ONE of the seven entry points.
//    `logs`, `attach`, `stop`, `kill`, `respawn` and `rm` are all
//    dispatched by a fast path that runs BEFORE commander, and none
//    of them appear in the Commands section — even though the
//    banner that `--bg` prints tells the user to run three of them.
// 2. `--bg` and `--print` is a hard conflict with a dedicated
//    message, and `--print` is not even a legal argument here. The
//    option registration says nothing about this.
// 3. `claude rm --help` promises it "works on already-exited
//    sessions". It does not: it tries to STOP the session first, so
//    on a `done` job it fails with "couldn't confirm <id> was
//    stopped" and the job can never be removed. Verified live.
// ============================================================

/** The six subcommands the fast path dispatches but `--help` omits. */
export const BG_SUBCOMMANDS = ["logs", "attach", "stop", "kill", "respawn", "rm"] as const;

export type BgSubcommand = (typeof BG_SUBCOMMANDS)[number];

/**
 * Usage line + one-line description, per subcommand.
 *
 * `kill` is absent on purpose: the dispatcher has no `kill` branch,
 * so it falls through to the same `stopHandler` as `stop` — it is a
 * pure alias and inherits `claude stop <id>`. That is also why
 * searching the binary for "claude kill <id>" finds nothing.
 */
export const BG_SUBCOMMAND_USAGE: Record<BgSubcommand, { usage: string; summary: string }> = {
  logs: {
    usage: "claude logs <id>",
    summary: "Print the background session's recent terminal output.",
  },
  attach: {
    usage: "claude attach <id>",
    summary:
      "Open the background session in this terminal. ← returns to agent view, Ctrl+Z drops back to your shell. The session keeps running either way.",
  },
  stop: {
    usage: "claude stop <id>",
    summary:
      "Stop a background session. Its conversation is kept; resume it later with `claude attach <id>`.",
  },
  kill: {
    usage: "claude stop <id>",
    summary:
      "Stop a background session. Its conversation is kept; resume it later with `claude attach <id>`.",
  },
  respawn: {
    usage: "claude respawn <id>|--all",
    summary:
      "Restart a background session (or all of them) so it picks up the current Claude binary.",
  },
  rm: {
    usage: "claude rm <id>",
    summary:
      "Delete a background session and its worktree. Unlike `stop`, works on already-exited sessions.",
  },
};

/** What the daemon subsystem is called — `isDaemonServiceInstallEnabled()` picks the noun. */
export const BG_SUPERVISOR_NOUN = "background service";

// ============================================================
// Feature gate
// ============================================================

export interface BgGateInput {
  env?: Record<string, string | undefined>;
  settings?: { disableAgentView?: unknown };
}

/**
 * Why the whole background-agent surface is off, or `null` when on.
 *
 * Verbatim from `Hno()` (offset 231337500). The default is ENABLED —
 * there is no account flag, only these two opt-outs.
 */
export function fleetDisabledReason(input: BgGateInput = {}): string | null {
  const env = input.env ?? process.env;
  if (isNonEmpty(env.CLAUDE_CODE_DISABLE_AGENT_VIEW))
    return "is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW";
  if (input.settings?.disableAgentView === true)
    return "is disabled by the 'disableAgentView' setting";
  return null;
}

export function isAgentsFleetEnabled(input: BgGateInput = {}): boolean {
  return fleetDisabledReason(input) === null;
}

/**
 * The gate's refusal, exactly as `A1e()` writes it to stderr.
 *
 * `target` is the literal string official echoes back: the subcommand
 * name for a subcommand, the flag as the user spelled it for `--bg`
 * (so `--background` reports `'--background'`, not `'--bg'`), and
 * the whole `"claude agents --json"` for the documented subcommand.
 */
export function fleetGateMessage(target: string, input: BgGateInput = {}): string {
  return `'${target}' ${fleetDisabledReason(input) ?? "is not available in this environment"}.`;
}

// ============================================================
// Preflight conflict checks
// ============================================================

export interface BgConflictInput {
  /** `--print` / `-p` present. */
  hasPrint?: boolean;
  /** `--permission-mode <mode>` value. */
  permissionMode?: string;
  /** `bypassPermissions` disclaimer already accepted interactively. */
  bypassAccepted?: boolean;
  /** auto mode already opted into interactively. */
  autoOptedIn?: boolean;
}

/** Truthy-string test, matching official's env helper. */
function isNonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * Does this token select `--print`?
 *
 * Covers official's three unambiguous forms: `--print`, `--print=<x>`,
 * and `-p` (bare or with an attached value, e.g. `-pHi`).
 *
 * NOT reconstructed: short-cluster peeling. Official runs each token
 * through a splitter and tests whether `-p` appears among the peeled
 * flags, so `-xp` also trips its check. That splitter's exact rule
 * was not recoverable from the binary, and guessing it would risk
 * false positives on an innocent token. Missing it costs a different
 * refusal message on an already-refused path, never a wrong spawn.
 */
export function selectsPrint(token: string): boolean {
  if (token === "--print" || token.startsWith("--print=")) return true;
  if (!token.startsWith("-") || token.startsWith("--")) return false;
  return token[1] === "p";
}

function isCloudToken(token: string): boolean {
  return (
    token === "--cloud" ||
    token.startsWith("--cloud=") ||
    token === "--remote" ||
    token.startsWith("--remote=")
  );
}

/**
 * The preflight `ZEm()` runs before spawning, in official's order.
 *
 * Returns the refusal string, or `null` when nothing conflicts. The
 * cloud check comes FIRST because `--cloud` and `--bg` are different
 * backends and no combination of them is meaningful.
 */
export function checkBgConflicts(
  argv: readonly string[],
  input: BgConflictInput = {},
): string | null {
  if (argv.some(isCloudToken))
    return "--bg and --cloud are different backends. Use `claude --cloud '<task>'` directly to start a cloud session.";

  if (input.hasPrint ?? argv.some(selectsPrint))
    return "--bg and --print conflict: --print never starts the interactive session that `claude agents` attaches to, so the job would be unattachable. The prompt is the positional — drop --print: `claude --bg '<task>'`.";

  const mode = input.permissionMode;
  const wantsBypass =
    mode === "bypassPermissions" ||
    argv.includes("--dangerously-skip-permissions") ||
    argv.includes("--allow-dangerously-skip-permissions");
  if (wantsBypass && input.bypassAccepted !== true)
    return "--bg with bypassPermissions requires accepting the disclaimer first. Run `claude --dangerously-skip-permissions` once interactively.";

  if (mode === "auto" && input.autoOptedIn !== true)
    return "--bg with auto mode requires opting in first. Run `claude --permission-mode auto` once interactively.";

  return null;
}

// ============================================================
// The decision
// ============================================================

export type BgDecision =
  | { kind: "absent" }
  | { kind: "subcommand"; name: BgSubcommand; arg: string | undefined }
  | { kind: "reject"; message: string };

/** True when the argv mentions the flag under either spelling. */
export function hasBgFlag(argv: readonly string[]): boolean {
  return argv.includes("--bg") || argv.includes("--background");
}

function asSubcommand(token: string | undefined): BgSubcommand | undefined {
  return BG_SUBCOMMANDS.find((c) => c === token);
}

/**
 * argv → decision. Pure; nothing here spawns, reads, or writes.
 *
 * Takes the SLICED argument list — official's fast path runs on
 * `process.argv.slice(2)`, so the first element is already the
 * subcommand name or the first flag, not the node/script prefix.
 *
 * Order matches official's fast path exactly: the subcommand/flag
 * test first, then the feature gate, then the preflight conflicts.
 * Getting the gate second matters — with the fleet off, official
 * reports the gate and never mentions `--print`, so a `--bg --print`
 * invocation prints the gate message, not the conflict message.
 */
export function resolveBgStartup(
  argv: readonly string[] = process.argv.slice(2),
  input: BgConflictInput & BgGateInput = {},
): BgDecision {
  const sub = asSubcommand(argv[0]);
  if (!sub && !hasBgFlag(argv)) return { kind: "absent" };

  const gateTarget = sub ?? argv.find((a) => a === "--bg" || a === "--background") ?? "--bg";
  const reason = fleetDisabledReason(input);
  if (reason !== null) return { kind: "reject", message: fleetGateMessage(gateTarget, input) };

  if (sub) return { kind: "subcommand", name: sub, arg: argv[1] };

  const conflict = checkBgConflicts(argv, input);
  if (conflict !== null) return { kind: "reject", message: conflict };

  return {
    kind: "reject",
    message: notImplementedBanner(argv.find((a) => a === "--bg" || a === "--background") ?? "--bg"),
  };
}

/**
 * The one refusal that is OURS rather than official's.
 *
 * It has to name what is missing, because by this point every check
 * official performs has passed and the only thing left is the runtime.
 */
export function notImplementedBanner(flag: string): string {
  return `'${flag}' is recognised but not implemented in this project: background sessions need a ${BG_SUPERVISOR_NOUN} that this CLI does not run. Nothing was started. This project has no \`claude agents\` view, and \`logs\`, \`attach\`, \`stop\`, \`kill\`, \`respawn\` and \`rm\` are all unavailable with it.`;
}

// ============================================================
// The banner official prints after a successful spawn
// ============================================================

/**
 * `Xwt()` verbatim: the `backgrounded · <id>` line, then four hints
 * whose command column is padded to 26 and prefixed with two spaces.
 *
 * The padding is why the banner looks aligned in a real terminal; a
 * long id pushes the description right without wrapping. Kept
 * because this is the exact text a user would otherwise have to
 * reverse-engineer from a screen.
 */
export function formatBackgroundedBanner(id: string, detail?: string, trailer?: string): string {
  const hint = (command: string, text: string) => `  ${command.padEnd(26)}${text}`;
  return [
    `backgrounded · ${id}${detail ? ` · ${detail}` : ""}${trailer ? ` ${trailer}` : ""}`,
    hint("claude agents", "list sessions"),
    hint(`claude attach ${id}`, "open in this terminal"),
    hint(`claude logs ${id}`, "show recent output"),
    hint(`claude stop ${id}`, "stop this session"),
  ].join("\n");
}

/**
 * The pure error branches of official's shared id resolver `CJo()`.
 *
 * `jobs` is the set of ids this project knows about — always empty
 * here, which is why every branch below that needs a live job is a
 * refusal instead. Kept because the first three branches are
 * reachable and correct without any job store.
 */
export function resolveJobIdArg(
  arg: string | undefined,
  usage: string,
  jobs: readonly string[] = [],
  options: { agentsHint?: boolean } = {},
):
  | { kind: "usage"; message: string }
  | { kind: "error"; message: string }
  | { kind: "id"; id: string } {
  if (arg === undefined) return { kind: "usage", message: `Usage: ${usage}` };
  if (arg.startsWith("-"))
    return { kind: "error", message: `unknown option '${arg}'\nUsage: ${usage}` };
  const matches = jobs.filter((j) => j.startsWith(arg));
  if (matches.length === 1) return { kind: "id", id: matches[0] };
  if (matches.length === 0)
    return {
      kind: "error",
      // `rm` uses its own inline resolver that drops the agents hint — verified
      // live: `claude rm <dead>` prints the bare form. Everything else keeps it.
      message:
        options.agentsHint === false
          ? `No job matching '${arg}'`
          : `No job matching '${arg}'. Run 'claude agents' to list running sessions.`,
    };
  return { kind: "error", message: `Ambiguous prefix '${arg}', matches: ${matches.join(", ")}` };
}
