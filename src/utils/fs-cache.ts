// ============================================================
// FS Listing Cache — short-TTL memoization for tool file scans (M3)
// ============================================================
// Grep re-spawns `rg --files` on every call and Glob re-walks the tree via
// fast-glob; within a turn or two the tree rarely changes, so a brief TTL
// cache removes the coldest part of those calls. The search itself is NEVER
// cached (content changes invalidate silently) — only the FILE LISTING.
//
// Correctness contract:
//   - TTL is short (default 10s; CCR_FS_CACHE_TTL_MS overrides, 0 disables).
//   - Every tool-mediated write invalidates proactively
//     (invalidateWorkspaceFiles), so the dangerous window is only writes we
//     did not perform (Bash) — covered by invalidating after every shell
//     command too, plus the TTL backstop.
//   - Concurrent callers share one in-flight producer (the Promise is
//     cached, not just the value); a rejected producer is never cached.
// ============================================================

export class TTLCache<T> {
  private map = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0) return; // disabled
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  /** Delete every key starting with the prefix (a workspace root). */
  deletePrefix(prefix: string): number {
    const normalized = CASE_INSENSITIVE_FS ? prefix.toLowerCase() : prefix;
    let removed = 0;
    for (const key of this.map.keys()) {
      if (key.startsWith(normalized)) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

function currentTtlMs(): number {
  const raw = Number(process.env.CCR_FS_CACHE_TTL_MS);
  return Number.isFinite(raw) ? raw : 10_000;
}

// Re-created whenever the TTL env changes value so tests can flip it.
let cacheHolder: TTLCache<Promise<string[]>> | null = null;
let cacheTtlMs = Number.NaN;

function cache(): TTLCache<Promise<string[]>> {
  const ttl = currentTtlMs();
  if (!cacheHolder || cacheTtlMs !== ttl) {
    cacheHolder = new TTLCache<Promise<string[]>>(ttl);
    cacheTtlMs = ttl;
  }
  return cacheHolder;
}

const KEY_SEP = "\u0000";

// Windows/macOS filesystems are case-insensitive: the same directory reaches
// us under different spellings (config value vs realpathSync vs user input),
// and a case-sensitive prefix match would let invalidation miss entries.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/** Normalize a scope path for key/prefix use (see CASE_INSENSITIVE_FS). */
function normalizeScope(scope: string): string {
  return CASE_INSENSITIVE_FS ? scope.toLowerCase() : scope;
}

/**
 * Memoized async file-listing producer. `scopeRoot` prefixes the cache key so
 * invalidateWorkspaceFiles(root) can drop everything under one workspace; it
 * should be the validated search directory (or the workspace root itself).
 */
export function cachedFileListing(
  scopeRoot: string,
  detail: string,
  produce: () => Promise<string[]>,
): Promise<string[]> {
  const key = `${normalizeScope(scopeRoot)}${KEY_SEP}${detail}`;
  const c = cache();
  const hit = c.get(key);
  if (hit) return hit;
  const pending = produce().catch((error) => {
    // Never cache a failure — a transient rg spawn error must not pin an
    // empty/broken listing for the TTL window.
    c.delete(key);
    throw error;
  });
  c.set(key, pending);
  return pending;
}

/**
 * Drop every cached listing scoped under `root`. Called by tools that change
 * the filesystem (write/edit/bash/...) so their own follow-up searches see
 * the new tree immediately.
 */
export function invalidateWorkspaceFiles(root: string): void {
  cache().deletePrefix(root);
}

/**
 * Drop cached listings for EVERY scope a tool call could have written to:
 * the workspace root plus the additional allowed directories. Glob/Grep key
 * listings by searchDir, which may live outside workspaceRoot (an
 * allowedDirectory) — invalidating only the root would leave those stale
 * until the TTL.
 */
export function invalidateToolWritableScopes(context: {
  workspaceRoot: string;
  allowedDirectories?: string[];
}): void {
  const c = cache();
  c.deletePrefix(context.workspaceRoot);
  for (const dir of context.allowedDirectories ?? []) c.deletePrefix(dir);
}

/** Test hook: force-clear everything. */
export function clearFileListingCache(): void {
  cache().clear();
}
