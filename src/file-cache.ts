// ============================================================
// File Cache — LRU cache for file contents to reduce I/O
// ============================================================
// Caches file contents with TTL and size limits to reduce redundant
// file reads. Especially useful for files that are read multiple times
// during a session (e.g., configuration files, imports).
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

export interface CacheEntry<T> {
  value: T;
  size: number;
  accessedAt: number;
  createdAt: number;
  mtimeMs: number; // File modification time for invalidation
}

export interface FileCacheOptions {
  maxSize?: number; // Max total bytes in cache (default: 10MB)
  maxEntries?: number; // Max number of entries (default: 500)
  ttlMs?: number; // Time-to-live in ms (default: 5 minutes)
  checkMtime?: boolean; // Invalidate on file change (default: true)
}

const DEFAULT_OPTIONS: Required<FileCacheOptions> = {
  maxSize: 10 * 1024 * 1024, // 10MB
  maxEntries: 500,
  ttlMs: 5 * 60 * 1000, // 5 minutes
  checkMtime: true,
};

export class FileCache {
  private cache = new Map<string, CacheEntry<Buffer>>();
  private options: Required<FileCacheOptions>;
  private totalSize = 0;
  private hits = 0;
  private misses = 0;

  constructor(options: FileCacheOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Get a file from cache. Returns undefined if not found or invalidated.
   */
  async get(filePath: string): Promise<string | undefined> {
    const absPath = path.resolve(filePath);
    const entry = this.cache.get(absPath);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL
    if (Date.now() - entry.createdAt > this.options.ttlMs) {
      this.invalidate(absPath);
      this.misses++;
      return undefined;
    }

    // Check mtime if enabled
    if (this.options.checkMtime) {
      try {
        const stat = fs.statSync(absPath);
        if (stat.mtimeMs !== entry.mtimeMs) {
          this.invalidate(absPath);
          this.misses++;
          return undefined;
        }
      } catch {
        // File doesn't exist anymore
        this.invalidate(absPath);
        this.misses++;
        return undefined;
      }
    }

    // Update access time
    entry.accessedAt = Date.now();
    this.hits++;

    return entry.value.toString("utf-8");
  }

  /**
   * Get a file from cache, reading from disk if not cached.
   */
  async getOrRead(filePath: string): Promise<string> {
    const cached = await this.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    // Read from disk
    const content = await fs.promises.readFile(filePath, "utf-8");
    await this.set(filePath, content);
    return content;
  }

  /**
   * Set a file in cache.
   */
  async set(filePath: string, content: string): Promise<void> {
    const absPath = path.resolve(filePath);
    const size = Buffer.byteLength(content, "utf-8");

    // Evict if necessary
    while (
      (this.cache.size >= this.options.maxEntries ||
        this.totalSize + size > this.options.maxSize) &&
      this.cache.size > 0
    ) {
      this.evictLRU();
    }

    // Get mtime
    let mtimeMs = 0;
    try {
      const stat = fs.statSync(absPath);
      mtimeMs = stat.mtimeMs;
    } catch {
      // File may not exist
    }

    const entry: CacheEntry<Buffer> = {
      value: Buffer.from(content, "utf-8"),
      size,
      accessedAt: Date.now(),
      createdAt: Date.now(),
      mtimeMs,
    };

    // Remove old entry if exists
    const oldEntry = this.cache.get(absPath);
    if (oldEntry) {
      this.totalSize -= oldEntry.size;
    }

    this.cache.set(absPath, entry);
    this.totalSize += size;
  }

  /**
   * Invalidate a specific file from cache.
   */
  invalidate(filePath: string): void {
    const absPath = path.resolve(filePath);
    const entry = this.cache.get(absPath);
    if (entry) {
      this.totalSize -= entry.size;
      this.cache.delete(absPath);
    }
  }

  /**
   * Invalidate all entries matching a pattern.
   */
  invalidatePattern(pattern: RegExp): number {
    let count = 0;
    for (const filePath of this.cache.keys()) {
      if (pattern.test(filePath)) {
        this.invalidate(filePath);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
    this.totalSize = 0;
  }

  /**
   * Get cache statistics.
   */
  getStats(): {
    size: number;
    entries: number;
    hits: number;
    misses: number;
    hitRate: number;
  } {
    const total = this.hits + this.misses;
    return {
      size: this.totalSize,
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLRU(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;

    for (const [filePath, entry] of this.cache) {
      if (entry.accessedAt < oldestTime) {
        oldestTime = entry.accessedAt;
        oldest = filePath;
      }
    }

    if (oldest) {
      this.invalidate(oldest);
    }
  }
}

// Singleton instance for session-wide caching
let fileCache: FileCache | null = null;

export function getFileCache(options?: FileCacheOptions): FileCache {
  if (!fileCache) {
    fileCache = new FileCache(options);
  }
  return fileCache;
}

// Convenience: read with caching
export async function readFileCached(filePath: string): Promise<string> {
  const cache = getFileCache();
  return cache.getOrRead(filePath);
}

// Convenience: invalidate cache for a specific file
export function invalidateFileCache(filePath: string): void {
  getFileCache().invalidate(filePath);
}
