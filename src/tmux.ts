// ============================================================
// Official `--tmux` — tmux pane backend for `--worktree`
// ------------------------------------------------------------
// KERNEL LAYER. argv → decision, plus the two pure helpers that
// encode official's exact wording. Every rule below was read out
// of the official 2.1.202 win32 binary and then confirmed by
// running it (see docs/更新日志/20261003-tmux-flag.md).
//
// The binary lies about this flag in two separate ways, and both
// matter more than the happy path:
//
// 1. `--tmux` is served by a FAST PATH that runs BEFORE commander.
//    It only triggers when a worktree flag is on the same command
//    line. Without one, `--tmux` falls through to the ordinary
//    parse and dies with "requires --worktree".
// 2. The help text advertises `--tmux=classic`, but the option is
//    declared value-less (`e.option("--tmux", …)`), so commander
//    rejects every `--tmux=<v>` spelling as an unknown option.
//
// On Windows the fast path is a two-line function that ALWAYS ends
// in `Error: --tmux is not supported on Windows`. The tmux session
// creation it would otherwise call (`createTmuxSessionForWorktree`)
// ships in the binary but is unreachable on this platform build.
// ============================================================

import { execFile } from "node:child_process";
import { parseTmuxFlag, type TmuxFlag } from "./cli-session-flags.js";

/**
 * Official's platform tokens.
 *
 * NOT `process.platform`: the binary's platform helper reports
 * `"macos"` (not `"darwin"`) and has a separate `"wsl"` value,
 * because tmux install advice differs between WSL and native
 * Linux even though both land on the apt/dnf instructions.
 */
export type OfficialPlatform = "macos" | "linux" | "wsl" | "windows" | "other";

export function resolveOfficialPlatform(nodePlatform: string = process.platform): OfficialPlatform {
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "linux") return "linux";
  if (nodePlatform === "win32") return "windows";
  return "other";
}

/**
 * Official's tmux install instructions, verbatim.
 *
 * Reproduced word for word including the "agent swarms" framing —
 * official shares one helper between `--tmux` and the swarms
 * feature, so this is the exact text its `--tmux` error prints.
 * The Windows branch is unreachable via `--tmux` (the platform
 * gate rejects first) but is kept so the mapping is complete.
 */
export function tmuxInstallInstructions(platform: OfficialPlatform): string {
  switch (platform) {
    case "macos":
      return `To use agent swarms, install tmux:
  brew install tmux
Then start a tmux session with: tmux new-session -s claude`;
    case "linux":
    case "wsl":
      return `To use agent swarms, install tmux:
  sudo apt install tmux    # Ubuntu/Debian
  sudo dnf install tmux    # Fedora/RHEL
Then start a tmux session with: tmux new-session -s claude`;
    case "windows":
      return `To use agent swarms, you need tmux which requires WSL (Windows Subsystem for Linux).
Install WSL first, then inside WSL run:
  sudo apt install tmux
Then start a tmux session with: tmux new-session -s claude`;
    default:
      return `To use agent swarms, install tmux using your system's package manager.
Then start a tmux session with: tmux new-session -s claude`;
  }
}

/** Injection seam for tests; defaults to running the real `tmux`. */
export type TmuxProbe = (timeoutMs: number) => Promise<boolean>;

const TMUX_PROBE_TIMEOUT_MS = 5_000;

/**
 * `tmux -V` as the availability probe.
 *
 * A non-zero exit is a real "installed but unusable" answer and is
 * reported as unavailable, because the pane commands would fail the
 * same way; only a spawn failure means "not installed".
 */
export const probeTmux: TmuxProbe = (timeoutMs) =>
  new Promise<boolean>((resolve) => {
    execFile("tmux", ["-V"], { timeout: timeoutMs, windowsHide: true }, (error) => {
      if (!error) {
        resolve(true);
        return;
      }
      // Review fix ("超时假肯定"): a TIMEOUT kill carries killed=true with
      // no ENOENT code, and the old `code !== "ENOENT"` mapped it to
      // "installed" — a slow/hung tmux reported as present. A killed probe
      // is not a positive answer.
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      if (e.killed) {
        resolve(false);
        return;
      }
      resolve(e.code !== "ENOENT");
    });
  });

export type TmuxStartupDecision =
  /** `--tmux` not on the command line. */
  | { kind: "absent" }
  /** Official would exit 1 with exactly this text. */
  | { kind: "reject"; message: string }
  /** tmux is present but this build cannot create panes. */
  | { kind: "not-implemented"; message: string };

/**
 * Reproduce official's `--tmux` decision for the CURRENT platform.
 *
 * The order is the one the binary executes, which is not the order
 * the help text suggests:
 *
 *   1. no fast path (no worktree flag) → "requires --worktree", or
 *      commander's unknown-option error for any `--tmux=<v>`
 *   2. platform is Windows → "is not supported on Windows"
 *   3. tmux missing → "is not installed" + platform instructions
 *   4. otherwise → create the pane session (not implemented here)
 *
 * The one gate deliberately NOT reproduced is official's workspace
 * trust dialog, which runs between (1) and (2). This project's trust
 * model is different in kind — it fingerprints a project's ALLOW
 * rules (`confirmProjectAllowRules`), not a whole-workspace
 * "hasTrustDialogAccepted" flag — so borrowing official's wording
 * would announce a dialog that does not exist here. The project's
 * own gate still runs, unchanged, a few lines later.
 */
export function decideTmuxStartup(
  flag: TmuxFlag,
  platform: OfficialPlatform,
  tmuxInstalled: boolean,
): TmuxStartupDecision {
  if (!flag.present) return { kind: "absent" };

  const unknownValue = (): TmuxStartupDecision => ({
    kind: "reject",
    message: `error: unknown option '--tmux=${flag.value}'`,
  });

  if (!flag.worktreeRequested) {
    // No worktree flag, so official's fast path never runs and the
    // flag is judged by the ordinary parse: a bare `--tmux` trips
    // the worktree requirement, any `--tmux=<v>` never parses at all.
    return flag.value === undefined
      ? { kind: "reject", message: "Error: --tmux requires --worktree" }
      : unknownValue();
  }

  // With a worktree flag the fast path runs — but it only matches the
  // literal string "--tmux=classic", so `--tmux=other` slips past it
  // and hits commander's unknown-option error instead of the platform
  // gate. Quirk preserved: it is observable and cheap to keep.
  if (flag.value !== undefined && flag.value !== "classic") return unknownValue();

  if (platform === "windows")
    return { kind: "reject", message: "Error: --tmux is not supported on Windows" };

  if (!tmuxInstalled)
    return {
      kind: "reject",
      message: `Error: tmux is not installed.\n${tmuxInstallInstructions(platform)}`,
    };

  return {
    kind: "not-implemented",
    message:
      "--tmux needs official's tmux pane backend (createTmuxSessionForWorktree), which this build does not implement. tmux IS installed, so nothing is missing from your system — creating the pane session is the gap. Drop --tmux to run in the worktree directly.",
  };
}

/** argv → decision, with the tmux availability probe applied. */
export async function resolveTmuxStartup(
  argv: string[],
  options: {
    platform?: OfficialPlatform;
    probe?: TmuxProbe;
    timeoutMs?: number;
  } = {},
): Promise<TmuxStartupDecision> {
  const flag = parseTmuxFlag(argv);
  if (!flag.present) return { kind: "absent" };
  const platform = options.platform ?? resolveOfficialPlatform();
  // The platform gate precedes the probe in official, so a Windows
  // machine never spawns `tmux -V` only to be told tmux is irrelevant
  // here. The probe is consulted exactly when the decision needs it.
  if (platform === "windows") return decideTmuxStartup(flag, platform, false);
  const installed = await (options.probe ?? probeTmux)(options.timeoutMs ?? TMUX_PROBE_TIMEOUT_MS);
  return decideTmuxStartup(flag, platform, installed);
}
