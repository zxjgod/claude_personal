// ============================================================
// Official top-level subcommands (commander dispatch)
// ------------------------------------------------------------
// KERNEL LAYER. argv -> decision, plus official per-command wording.
// The 12 subcommands official 2.1.202 registers under commander were
// read out of `claude --help` and each confirmed live via
// `claude <sub> --help` (commander only prints subcommand help for a
// command that is actually registered). `agents` is here too: bg-startup.ts
// handles the `--bg` flag and the six hidden job subcommands, but the bare
// `agents` fleet-view command is not among them, so it is recognised here.
//
// This project runs a single interactive/print session and has none of
// the backends these commands drive (no OAuth account, no auto-updater,
// no native-build installer, no enterprise gateway, no cloud review, no
// mcp/plugin/project management CLI). So every one is a NAMED refusal:
// recognized, explained, and never silently dropped or fed to the model
// as a prompt - which is what an unrecognized first positional would
// otherwise do.
//
// Matched on the FIRST token only. Official commander also routes
// `claude --debug doctor` to `doctor`, but variadic value flags such as
// `--add-dir` legitimately consume a following word, so positional
// extraction cannot tell "subcommand" from "flag value" without full
// commander-grade parsing. First-token matching is exact (zero false
// positives) and covers the dominant `claude <sub>` form; the rarer
// flag-first forms fall through to current prompt handling.
// ============================================================

export interface OfficialSubcommand {
  /** Every spelling official accepts, e.g. plugin|plugins, update|upgrade. */
  aliases: readonly string[];
  /** Official one-line --help summary. */
  summary: string;
  /** This project named-gap refusal. */
  refusal: string;
}

export const OFFICIAL_SUBCOMMANDS: readonly OfficialSubcommand[] = [
  {
    aliases: ["agents"],
    summary: "Manage background agents",
    refusal:
      "agents opens the interactive background-agents view (the fleet manager for sessions started with --bg). This project has no background service, so there is no agents view; --bg and its logs / attach / stop / kill / respawn / rm subcommands are refused for the same reason.",
  },
  {
    aliases: ["auth"],
    summary: "Manage authentication (login / logout / status)",
    refusal:
      "auth manages Anthropic account sign-in (login / logout / status) with OAuth. This project authenticates with provider API keys (.env / --settings), not claude.ai accounts, so there is no auth command. Configure credentials in .env instead.",
  },
  {
    aliases: ["auto-mode"],
    summary: "Inspect auto mode classifier configuration",
    refusal:
      "auto-mode inspects the auto-mode classifier configuration (config / critique / defaults). This project runs its permission classifier in-session but has no auto-mode command. Nothing was printed.",
  },
  {
    aliases: ["doctor"],
    summary: "Check the health of the Claude Code auto-updater",
    refusal:
      "doctor checks the Claude Code auto-updater and spawns stdio MCP servers for health checks. This project has no auto-updater, so there is no doctor command.",
  },
  {
    aliases: ["gateway"],
    summary: "Run the enterprise auth/telemetry gateway",
    refusal:
      "gateway runs the enterprise auth/telemetry gateway server. This project does not run an enterprise gateway, so there is no gateway command.",
  },
  {
    aliases: ["install"],
    summary: "Install the Claude Code native build",
    refusal:
      "install installs the Claude Code native build. This project runs from source via node/npm and has no native-build installer. Update with your package manager instead.",
  },
  {
    aliases: ["mcp"],
    summary: "Configure and manage MCP servers",
    refusal:
      "mcp manages MCP servers (add / list / get / remove / serve / ...). This project loads MCP servers from .claude/mcp.json but has no mcp command; edit the config file instead.",
  },
  {
    aliases: ["plugin", "plugins"],
    summary: "Manage Claude Code plugins",
    refusal:
      "plugin manages plugins (install / list / enable / marketplace / ...). This project supports plugins through config and the in-session /plugin command but has no top-level plugin command.",
  },
  {
    aliases: ["project"],
    summary: "Manage Claude Code project state",
    refusal:
      "project manages per-project state (project purge deletes it). This project has no project command; session state lives under the user config root.",
  },
  {
    aliases: ["setup-token"],
    summary: "Set up a long-lived authentication token",
    refusal:
      "setup-token sets up a long-lived authentication token (requires a Claude subscription). This project authenticates with provider API keys, so there is no setup-token command.",
  },
  {
    aliases: ["ultrareview"],
    summary: "Run a cloud-hosted multi-agent code review",
    refusal:
      "ultrareview runs a cloud-hosted multi-agent code review. This project has no cloud backend, so there is no ultrareview command.",
  },
  {
    aliases: ["update", "upgrade"],
    summary: "Check for updates and install if available",
    refusal:
      "update checks for and installs Claude Code updates. This project has no self-updater; update with your package manager (npm) instead.",
  },
];

const BY_ALIAS: Record<string, OfficialSubcommand> = (() => {
  const map: Record<string, OfficialSubcommand> = {};
  for (const sub of OFFICIAL_SUBCOMMANDS) {
    for (const alias of sub.aliases) map[alias] = sub;
  }
  return map;
})();

export type CliCommandDecision = { kind: "absent" } | { kind: "reject"; message: string };

/**
 * First token -> decision. Pure; nothing here spawns, reads config, or
 * touches the network. Returns the subcommand refusal, or absent when the
 * first token is a flag or not a registered official subcommand.
 */
export function resolveCliCommand(
  argv: readonly string[] = process.argv.slice(2),
): CliCommandDecision {
  const token = argv[0];
  if (token === undefined || token.startsWith("-")) return { kind: "absent" };
  const sub = BY_ALIAS[token];
  if (!sub) return { kind: "absent" };
  return { kind: "reject", message: `${sub.refusal} It was not sent to the model as a prompt.` };
}
