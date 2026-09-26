// ============================================================
// Child-process environment sanitizer (Top10 follow-up A4)
// ============================================================
// Hook scripts (and any other locally-spawned helper we don't fully control)
// used to inherit the COMPLETE process environment — including LLM_API_KEY
// and every other secret the user exported. A malicious or compromised hook
// in a cloned project could exfiltrate them. User decision 2026-09: strip
// secret-shaped variables (the MCP stdio path already had its own
// SAFE_STDIO_ENV_KEYS allowlist; this is the denylist counterpart for hooks,
// where a full allowlist would break too many legitimate scripts).
//
// Trade-off accepted: a hook that genuinely needs an API key must read it
// from its own config file, not the inherited env.
// ============================================================

/**
 * Key shapes considered secret-bearing. Deliberately broad (over-stripping a
 * rarely-used variable beats leaking a key): anything containing api key /
 * apikey / secret / token / password / passwd / credential, in any casing or
 * separator style. `TOKEN` also catches GITHUB_TOKEN, HF_TOKEN, etc.
 */
const SECRET_KEY_RE = /(api[_-]?key|apikey|secret|token|passw(or)?d|credential)/i;

/**
 * Copy an environment with secret-shaped variables removed. Always keeps
 * PATH/HOME/SHELL-style plumbing intact (they don't match the pattern).
 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_KEY_RE.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** The names that WOULD be stripped from a given env (diagnostics/tests). */
export function strippedSecretNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => SECRET_KEY_RE.test(key));
}
