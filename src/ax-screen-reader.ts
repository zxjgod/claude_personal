// ============================================================
// Official `--ax-screen-reader` / `screenReader.axScreenReader`
// ------------------------------------------------------------
// KERNEL LAYER. argv + env + settings → one boolean, resolved
// with official's exact precedence and its exact (surprising)
// truthiness rules.
//
// The flag is a PURE TUI SETTING. Every one of official's nine
// consumers sits behind the Ink renderer, the alternate-screen
// predicates or the TUI command surface — none of which exist on
// the `--print` path. Verified live: `claude --ax-screen-reader -p
// … --output-format json|stream-json|text` produces no observable
// change beyond model nondeterminism. See
// docs/更新日志/20261003-ax-screen-reader-flag.md.
//
// What it DOES change, in official (offset 231323680 onward):
//   - Ink's `isScreenReaderEnabled` render option  → flat text tree,
//     no borders, no colors, no frame throttling
//   - the alternate-screen / DECSTBM predicates   → no fullscreen
//   - forces color + native-cursor predicates on
//   - blocks the `/tui` renderer switch, suppresses the fullscreen
//     upsell, and injects the env var into child processes
// ============================================================

/** The env var official injects into children when the mode is on. */
export const AX_ENV_VAR = "CLAUDE_AX_SCREEN_READER";

export const AX_FLAG = "--ax-screen-reader";

/**
 * Flags official skips past when hunting for a value-less flag.
 *
 * Without this, `claude --model --ax-screen-reader` would read
 * `--ax-screen-reader` as `--model`'s value and miss it. Verbatim
 * from official's `X9s` set (offset 231323400).
 */
export const VALUE_TAKING_FLAGS: ReadonlySet<string> = new Set([
  "--prefill",
  "--prefill-b64",
  "--deep-link-repo",
  "--deep-link-last-fetch",
  "--deep-link-cwd-b64",
  "--handle-uri",
  "--settings",
  "--managed-settings",
  "--setting-sources",
  "--team-name",
  "--agent-id",
  "--agent-name",
  "--agent-color",
  "--parent-session-id",
  "--agent-type",
  "--model",
  "--agent",
  "--routine",
  "--effort",
  "--permission-mode",
  "--session-id",
]);

/**
 * Official's argv scan for the flag.
 *
 * Exact element match (so `-p "claude --ax-screen-reader"` is a
 * prompt, not a flag), `--` terminates the scan, and a value-taking
 * flag consumes its next element. Takes the FULL `process.argv`;
 * official's `J9s` defaults to `process.argv` too and does not skip
 * the node/script prefix.
 */
export function argvHasAxScreenReader(argv: readonly string[] = process.argv): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") return false;
    if (arg === AX_FLAG) return true;
    if (arg !== undefined && VALUE_TAKING_FLAGS.has(arg)) i++;
  }
  return false;
}

/** Where the decision came from — used for the startup notice. */
export type AxSource = "flag" | "env" | "settings";

export interface AxResolution {
  enabled: boolean;
  source?: AxSource;
}

/**
 * Official's four-level cascade, in its own order.
 *
 * The env var is used **verbatim**, not boolean-coerced: official
 * writes `e = t !== void 0 ? t : …` and then tests `!e`. So
 * `CLAUDE_AX_SCREEN_READER=0` and `=false` both ENABLE the mode
 * (non-empty strings are truthy) and only `=""` disables it. That
 * is almost certainly not what a user setting `=0` expects, but it
 * is what official does, and reinterpreting it would make this
 * project's flag diverge where official's is already shipped.
 *
 * The settings read is strict `=== true`, which is why the flat
 * `axScreenReader` key alone does nothing — it has to be nested
 * under `screenReader`.
 */
export function resolveAxScreenReader(input: {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
  settings?: { screenReader?: { axScreenReader?: unknown } };
}): AxResolution {
  if (argvHasAxScreenReader(input.argv ?? process.argv)) return { enabled: true, source: "flag" };

  const env = input.env ?? process.env;
  const raw = env[AX_ENV_VAR];
  if (raw !== undefined) return raw ? { enabled: true, source: "env" } : { enabled: false };

  if (input.settings?.screenReader?.axScreenReader === true)
    return { enabled: true, source: "settings" };

  return { enabled: false };
}

let cached: boolean | undefined;

/**
 * The process-wide answer, resolved once.
 *
 * Official caches in a private field with a `reset()` for tests, and
 * every consumer reads that one value — so this does the same rather
 * than letting the TUI and the CLI disagree about the mode.
 */
export function isAxScreenReaderEnabled(settings?: {
  screenReader?: { axScreenReader?: unknown };
}): boolean {
  if (cached !== undefined) return cached;
  cached = resolveAxScreenReader({ settings }).enabled;
  return cached;
}

export function resetAxScreenReader(): void {
  cached = undefined;
}
