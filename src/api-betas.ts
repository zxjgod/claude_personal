// ============================================================
// Official `--betas <betas...>` — user-supplied API beta headers.
//
// "Beta headers to include in API requests (API key users only)"
//
// The help text is one sentence, and reading the binary's option registration
// (`--betas` is a PLAIN variadic, no argParser — unlike `--effort`, which
// validates and warns) suggests a pure passthrough. **That reading is wrong.**
// The binary gates the list at startup, and a live probe against official
// 2.1.202 settled every open question:
//
//   $ claude -p "hi" --betas made-up-beta-xyz --output-format json
//   Warning: Beta header 'made-up-beta-xyz' is not allowed. Only the
//   following betas are supported: context-1m-2025-08-07
//
//   $ claude -p "hi" --betas long_context context-1m-2025-08-07 ...
//   Warning: Beta header 'long_context' is not allowed. Only the following
//   betas are supported: context-1m-2025-08-07
//
// So: the allowlist is a HARD-CODED single entry, values are matched as
// HEADERS (the short registry NAME `long_context` is rejected), each rejected
// value gets its own warning naming it, and rejection DROPS the value rather
// than failing the run. The binary source confirms the rest:
//
//   f9s = new Set([WX])                       // WX = long_context
//   pJd(e) { for n of e: Xxr(n) && f9s.has(Xxr(n)) ? keep : reject }
//          // Xxr looks up M_s, which is keyed by `header`, not by `name`
//   m9s(e) { if (Eo()) { warn "API key users" once; return }
//            for n of rejected: warn "Beta header '<n>' is not allowed. …"
//            return allowed.length ? allowed : undefined }
//
// The 28-entry `PDd` registry beside it (effort, tool_search, files_api, …)
// is the CLI's OWN internal beta derivation — those are added automatically
// per model/config and are NOT user-selectable. Only `context-1m-2025-08-07`
// is.
// ============================================================

/** The wire carrier. The Anthropic SDK models betas as a header param. */
export const BETA_HEADER = "anthropic-beta";

/**
 * Official's user-selectable allowlist (`f9s`). Exactly one entry, pinned from
 * the binary and confirmed by a live probe on 2.1.202.
 */
export const SUPPORTED_BETAS: readonly string[] = ["context-1m-2025-08-07"];

export interface BetaResolution {
  /** Headers to actually send, in request order. */
  allowed: string[];
  /** Values that were dropped, in request order. */
  rejected: string[];
  /** Set when the API-key gate fired; every value was dropped. */
  apiKeyRequired: boolean;
}

export interface ResolveBetasOptions {
  /**
   * Official's `Eo()` — "this session is NOT an API-key user" (OAuth /
   * subscription). Defaults to false: this CLI has no OAuth flow, every
   * provider is configured with an API key, so the gate never trips in
   * practice. It exists so the branch is testable and stays honest if an
   * OAuth path is ever added.
   */
  notApiKeyUser?: boolean;
}

/**
 * Partition requested betas against the allowlist — official's `pJd` + `m9s`
 * without the I/O, so callers can report however they like.
 *
 * Order is preserved on both sides: official iterates the request array once,
 * warning per rejected value in the order given.
 */
export function resolveBetas(
  requested: readonly string[],
  options: ResolveBetasOptions = {},
): BetaResolution {
  const allowed: string[] = [];
  const rejected: string[] = [];
  if (options.notApiKeyUser) {
    // Official warns ONCE, not per value, and drops everything.
    return { allowed, rejected: [...requested], apiKeyRequired: true };
  }
  for (const value of requested) {
    if (SUPPORTED_BETAS.includes(value)) allowed.push(value);
    else rejected.push(value);
  }
  return { allowed, rejected, apiKeyRequired: false };
}

/** Official's two warning strings, verbatim. */
export function betaWarnings(resolution: BetaResolution): string[] {
  if (resolution.apiKeyRequired) {
    return ["Warning: Custom betas are only available for API key users. Ignoring provided betas."];
  }
  return resolution.rejected.map(
    (value) =>
      `Warning: Beta header '${value}' is not allowed. Only the following betas are supported: ${SUPPORTED_BETAS.join(", ")}`,
  );
}

/** The `anthropic-beta` header value, or undefined when nothing survives. */
export function betaHeaderValue(allowed: readonly string[]): string | undefined {
  return allowed.length > 0 ? allowed.join(",") : undefined;
}
