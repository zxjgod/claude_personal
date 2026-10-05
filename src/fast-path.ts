// ============================================================
// Official hidden fast-path / internal-worker entry points
// ------------------------------------------------------------
// KERNEL LAYER. argv -> decision, plus the pure helpers that encode
// official's exact wording. Read out of the official 2.1.202 win32
// binary and then confirmed by running it (see
// docs/更新日志/20261003-fast-path.md).
//
// BEFORE commander runs, official dispatches a set of internal
// worker/spawn entry points by first positional (offset ~249994200).
// These are how claude launches its OWN child processes - chrome MCP
// servers, daemon workers, a PTY host, a spare/preload pool, and the
// Remote-Control bridge. They are NOT user commands: most fail on a
// missing internal argument, some daemonize, and one opens a named
// IPC pipe. A user who types one has almost certainly made a mistake,
// and this CLI must not feed the token to the model as a prompt.
//
// THIS PROJECT IMPLEMENTS THE DECISION LAYER ONLY. There is no
// background service, no chrome native host, no PTY host, no bridge,
// and no cloud backend, so every reachable outcome is a NAMED refusal.
// Where official has wording for the situation, that wording is
// reproduced verbatim; where official would do real work, the refusal
// names the gap instead.
//
// The --bg / --background family and the six background subcommands
// are handled separately in bg-startup.ts; this module deliberately
// runs BEFORE it, matching official's order (internal workers and
// bridge aliases dispatch ahead of the background path).
// ============================================================

import { hasBgFlag } from "./bg-startup.js";

// ============================================================
// Internal worker / spawn entry points
// ============================================================

export interface InternalWorker {
  /** What the worker is for, in one line. */
  why: string;
  /** Official's error when invoked bare (no internal argument), or null. */
  bareError: string | null;
  /** Official's exit code for that bare error. */
  bareExit: number | null;
}

/**
 * The seven internal entry points, in official's dispatch order.
 *
 * Each is matched by FIRST positional only - that is how official
 * dispatches them, and it is what keeps `claude rc` (bridge) distinct
 * from `claude --rc` (not a thing) and from a prompt that merely
 * contains the word.
 */
export const INTERNAL_WORKERS: Record<string, InternalWorker> = {
  "--claude-in-chrome-mcp": {
    why: "spawns the Claude-in-Chrome MCP server",
    bareError: null, // exits 0 silently, verified live
    bareExit: 0,
  },
  "--chrome-native-host": {
    why: "spawns the Chrome native-messaging host and opens a named IPC pipe",
    bareError: null, // opens the pipe and waits, verified live
    bareExit: null,
  },
  "--computer-use-mcp": {
    why: "spawns the computer-use MCP server",
    bareError: null, // crashes with a stack trace on this build, verified live
    bareExit: 1,
  },
  "--daemon-worker": {
    why: "runs a daemon worker of a named kind, reading a JSON payload from stdin",
    bareError: "unknown worker kind: undefined",
    bareExit: 2,
  },
  "--bg-pty-host": {
    why: "hosts the background-service pseudo-terminals",
    bareError: null, // exits 1 with no output, verified live
    bareExit: 1,
  },
  "--bg-spare": {
    why: "claims a spare background worker over a socket, reading it from stdin",
    bareError: "[bg-spare] missing claim sock path",
    bareExit: 2,
  },
  "--preload": {
    why: "pre-warms a worker, claiming it over a socket read from stdin",
    bareError: null, // blocks on stdin awaiting a claim, verified live
    bareExit: null,
  },
};

/**
 * The Remote-Control bridge aliases. All five route to the same
 * `bridgeMain` via `cli_bridge_path`, and all five hit the same gate.
 *
 * Official's gate is an ACCOUNT check, not the fleet feature gate -
 * `CLAUDE_CODE_DISABLE_AGENT_VIEW` does not change it (verified live).
 * Remote Control needs a claude.ai subscription, so on a machine with
 * no claude.ai login this is the message official prints.
 */
export const BRIDGE_ALIASES = ["remote-control", "rc", "remote", "sync", "bridge"] as const;

/** Official's bridge gate, verbatim (cli_bridge_path -> BRIDGE_LOGIN_ERROR). */
export const BRIDGE_LOGIN_MESSAGE =
  "Error: You must be logged in to use Remote Control.\n" +
  "Remote Control is only available with claude.ai subscriptions. Please use `/login` to sign in with your claude.ai account.";

// ============================================================
// The --cloud / --remote backend flags
// ============================================================

/** Official's non-TTY refusal for the cloud backend, verbatim (the O_c validator). */
export const CLOUD_TTY_MESSAGE =
  "Error: --cloud requires an interactive terminal.\n" +
  "Non-interactive invocations (piped stdout, --init-only, --sdk-url) run locally and would silently ignore --cloud. Drop --cloud, or run from a TTY.";

function isCloudFlagToken(token: string): boolean {
  return (
    token === "--cloud" ||
    token.startsWith("--cloud=") ||
    token === "--remote" ||
    token.startsWith("--remote=")
  );
}

// ============================================================
// The decision
// ============================================================

export type FastPathDecision = { kind: "absent" } | { kind: "reject"; message: string };

export interface FastPathInput {
  /** Whether stdout is an interactive terminal; decides the cloud message. */
  isTTY?: boolean;
}

function asInternalWorker(token: string | undefined): InternalWorker | undefined {
  return token === undefined ? undefined : INTERNAL_WORKERS[token];
}

function isBridgeAlias(token: string | undefined): boolean {
  return token !== undefined && (BRIDGE_ALIASES as readonly string[]).includes(token);
}

/**
 * argv (sliced - official's process.argv.slice(2)) -> decision. Pure;
 * nothing here spawns, reads stdin, or opens a pipe.
 *
 * Order matches official's fast path: internal workers first, then the
 * bridge aliases, then the cloud flag - and the cloud flag defers to
 * the background resolver when --bg is present, because official
 * reports the "--bg and --cloud are different backends" conflict there.
 */
export function resolveFastPath(
  argv: readonly string[] = process.argv.slice(2),
  input: FastPathInput = {},
): FastPathDecision {
  const worker = asInternalWorker(argv[0]);
  if (worker) return { kind: "reject", message: internalWorkerMessage(argv[0], worker) };

  if (isBridgeAlias(argv[0])) return { kind: "reject", message: BRIDGE_LOGIN_MESSAGE };

  // --cloud / --remote is a commander flag, not a positional entry, so it
  // can appear anywhere. Defer to the background resolver when --bg is
  // present (official reports the backend conflict from the bg path instead).
  if (!hasBgFlag(argv) && argv.some(isCloudFlagToken)) {
    const flag = argv.find(isCloudFlagToken) ?? "--cloud";
    return {
      kind: "reject",
      message:
        input.isTTY === false
          ? CLOUD_TTY_MESSAGE
          : `'${flag}' selects claude's cloud backend, which this project does not run: there is no cloud session service and no way to attach one. Nothing was started. (Official also requires an interactive terminal and, for a real session, a claude.ai login.)`,
    };
  }

  return { kind: "absent" };
}

/**
 * The refusal for an internal worker entry point. Names the gap, and
 * quotes official's bare-invocation error where official has one, so the
 * user sees both what they typed and what official would have done.
 */
function internalWorkerMessage(flag: string, worker: InternalWorker): string {
  const gap = `'${flag}' is an internal claude worker entry point, not a user command: it ${worker.why}. This project has no such worker to run, so nothing was started.`;
  if (worker.bareError === null) return gap;
  return `${gap} (Invoked bare, official prints \`${worker.bareError}\` and exits ${worker.bareExit}.)`;
}
