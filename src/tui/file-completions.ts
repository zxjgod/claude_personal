// ============================================================
// File completions — "@" path autocomplete source (P2-10)
// ============================================================
// Feeds the InputBox's "@" dropdown: typing "@src/tu" surfaces matching
// workspace paths, Tab inserts the full path. The submit side already
// expands @path refs (tools/utils/file-refs.ts); this is the input side.
//
// Listing strategy: fast-glob walk of the workspace with the usual vendored
// directories ignored, cached with a short TTL — the glob is the expensive
// part (10–100ms on big repos) and re-running it per keystroke would jank
// the input loop. Files written by the agent appear at most TTL later.
// ============================================================

import fg from "fast-glob";

/** Max rows the dropdown shows. */
export const MAX_FILE_SUGGESTIONS = 8;

/** How long a directory listing stays fresh (ms). Agent-written files appear
 *  at most this late in the completion list. */
const LIST_TTL_MS = 3000;

/** Never suggested: vendored / build / VCS noise no user means to attach. */
const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.cache/**",
];

interface Listing {
  at: number;
  root: string;
  files: string[];
}

// One cached listing. Not per-root: the TUI has a single workspace root at a
// time (and a root switch simply invalidates by comparison).
let cache: Listing | null = null;

/** #37: background refresh state. The in-flight flag IS the debounce — a
 *  burst of keystrokes on a stale listing triggers at most one glob. */
let refreshInFlight = false;

/** Bumped on every clear so an in-flight background refresh can't commit a
 *  stale listing over a deliberate invalidation. */
let cacheGeneration = 0;

const GLOB_OPTS = {
  dot: false,
  onlyFiles: true,
  ignore: IGNORE,
  suppressErrors: true,
  deep: 8,
  followSymbolicLinks: false,
} as const;

/**
 * Normalized, forward-slash paths of the workspace (cached, TTL-bounded).
 * #37: a STALE listing is served as-is while an async background glob
 * refreshes the cache — the input loop never blocks on the 10–100ms walk
 * again (the old fg.sync re-ran it inline on the first keystroke after every
 * TTL expiry). Only the cold start (no listing at all for this root) still
 * globs synchronously, once, so the very first "@" query returns real
 * matches instead of an empty dropdown.
 */
function listFiles(root: string): string[] {
  const now = Date.now();
  if (cache && cache.root === root && now - cache.at < LIST_TTL_MS) return cache.files;
  if (cache && cache.root === root) {
    if (!refreshInFlight) {
      refreshInFlight = true;
      const gen = cacheGeneration;
      void fg("**/*", { ...GLOB_OPTS, cwd: root })
        .then((files) => {
          // Drop the result if the cache was cleared mid-flight (test
          // isolation / deliberate invalidation).
          if (gen === cacheGeneration) cache = { at: Date.now(), root, files };
        })
        .catch(() => {
          /* keep serving the stale listing */
        })
        .finally(() => {
          refreshInFlight = false;
        });
    }
    return cache.files;
  }
  let files: string[] = [];
  try {
    files = fg.sync("**/*", { ...GLOB_OPTS, cwd: root });
  } catch {
    files = [];
  }
  cache = { at: now, root, files };
  return files;
}

/** Invalidate the cached listing (e.g. tests, or after known bulk writes). */
export function clearFileCompletionCache(): void {
  cache = null;
  cacheGeneration++;
}

/**
 * Match workspace paths against a typed "@" query (case-insensitive).
 * Prefers prefix matches on the full path; when fewer than the cap match,
 * backfills substring matches (so "@app" still finds "src/App.tsx").
 * Returns forward-slash relative paths, capped at MAX_FILE_SUGGESTIONS.
 */
export function completeFiles(workspaceRoot: string, query: string): string[] {
  const q = query.trim().toLowerCase().replace(/\\/g, "/");
  if (q.length === 0) return [];
  const files = listFiles(workspaceRoot);
  const prefix: string[] = [];
  const substr: string[] = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    if (lf.startsWith(q)) prefix.push(f);
    else if (lf.includes(q)) substr.push(f);
    if (prefix.length >= MAX_FILE_SUGGESTIONS) break;
  }
  const merged = [...prefix, ...substr];
  if (merged.length === 0) return [];
  // Cheap stability: prefer shorter paths (shallower = likelier intended).
  merged.sort((a, b) => a.length - b.length);
  return merged.slice(0, MAX_FILE_SUGGESTIONS);
}
