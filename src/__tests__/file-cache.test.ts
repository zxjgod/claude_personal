// ============================================================
// File Cache Tests
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FileCache } from "../file-cache.js";

describe("FileCache", () => {
  const testDir = path.join(os.tmpdir(), `file-cache-test-${Date.now()}`);
  let cache: FileCache;

  const testFile = (name: string) => path.join(testDir, name);

  beforeEach(async () => {
    await fs.promises.mkdir(testDir, { recursive: true });
    cache = new FileCache({ maxSize: 1024 * 1024, ttlMs: 60000 });
  });

  it("should cache file contents", async () => {
    const file = testFile("test.txt");
    await fs.promises.writeFile(file, "Hello, World!");

    const content1 = await cache.getOrRead(file);
    expect(content1).toBe("Hello, World!");

    // Modify file
    await fs.promises.writeFile(file, "Modified!");

    // Should detect mtime change and return undefined
    const content2 = await cache.get(file);
    expect(content2).toBeUndefined();
  });

  it("should invalidate on mtime change", async () => {
    const file = testFile("mtime-test.txt");
    await fs.promises.writeFile(file, "Original");

    // First read
    const content1 = await cache.getOrRead(file);
    expect(content1).toBe("Original");

    // Touch the file to update mtime
    const stat = await fs.promises.stat(file);
    await fs.promises.utimes(file, stat.atime, new Date(stat.mtimeMs + 1000));

    // Should detect change
    const content2 = await cache.get(file);
    expect(content2).toBeUndefined();
  });

  it("should respect TTL", async () => {
    const shortTtlCache = new FileCache({ ttlMs: 50 });
    const file = testFile("ttl-test.txt");
    await fs.promises.writeFile(file, "Test content");

    await shortTtlCache.set(file, "Test content");
    expect(await shortTtlCache.get(file)).toBe("Test content");

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(await shortTtlCache.get(file)).toBeUndefined();
  });

  it("should evict LRU entries", async () => {
    // Use larger maxSize so eviction is triggered by maxEntries (not size)
    const smallCache = new FileCache({ maxSize: 10000, maxEntries: 3 });

    const file1 = testFile("file1.txt");
    const file2 = testFile("file2.txt");
    const file3 = testFile("file3.txt");
    const file4 = testFile("file4.txt");

    // Create files first so set() can capture mtime
    await fs.promises.writeFile(file1, "Content1");
    await fs.promises.writeFile(file2, "Content2");
    await fs.promises.writeFile(file3, "Content3");

    await smallCache.set(file1, "Content1");
    await smallCache.set(file2, "Content2");
    await smallCache.set(file3, "Content3");

    // Access file1 to make it recently used (file1 is now MRU)
    await smallCache.get(file1);

    // Add another file to trigger eviction (maxEntries=3)
    await fs.promises.writeFile(file4, "Content4");
    await smallCache.set(file4, "Content4");

    // file2 should be evicted (LRU - least recently used before file4)
    expect(await smallCache.get(file2)).toBeUndefined();
    // file1 and file3 should remain (file1 was accessed, file3 was second)
    expect(await smallCache.get(file1)).toBe("Content1");
    expect(await smallCache.get(file3)).toBe("Content3");
    expect(await smallCache.get(file4)).toBe("Content4");
  });

  it("should track statistics", async () => {
    const file = testFile("stats-test.txt");
    await fs.promises.writeFile(file, "Test");

    await cache.get(file); // miss
    await cache.set(file, "Test");
    await cache.get(file); // hit

    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it("should clear all entries", async () => {
    const file1 = testFile("clear1.txt");
    const file2 = testFile("clear2.txt");

    await cache.set(file1, "Content 1");
    await cache.set(file2, "Content 2");

    expect(cache.getStats().entries).toBe(2);

    cache.clear();

    expect(cache.getStats().entries).toBe(0);
    expect(cache.getStats().size).toBe(0);
  });

  it("should invalidate specific files", async () => {
    const file1 = testFile("inv1.txt");
    const file2 = testFile("inv2.txt");

    // Create files first
    await fs.promises.writeFile(file1, "Content 1");
    await fs.promises.writeFile(file2, "Content 2");

    await cache.set(file1, "Content 1");
    await cache.set(file2, "Content 2");

    cache.invalidate(file1);

    expect(await cache.get(file1)).toBeUndefined();
    expect(await cache.get(file2)).toBe("Content 2");
  });

  it("should invalidate by pattern", async () => {
    const srcDir = testFile("src");
    const distDir = testFile("dist");

    // Create directories first
    await fs.promises.mkdir(srcDir, { recursive: true });
    await fs.promises.mkdir(distDir, { recursive: true });

    const file1 = path.join(srcDir, "file.ts");
    const file2 = path.join(srcDir, "file.js");
    const file3 = path.join(distDir, "file.js");

    await fs.promises.writeFile(file1, "TypeScript");
    await fs.promises.writeFile(file2, "JavaScript");
    await fs.promises.writeFile(file3, "Compiled");

    await cache.set(file1, "TypeScript");
    await cache.set(file2, "JavaScript");
    await cache.set(file3, "Compiled");

    const count = cache.invalidatePattern(/\.ts$/);
    expect(count).toBe(1);

    expect(await cache.get(file1)).toBeUndefined();
    expect(await cache.get(file2)).toBe("JavaScript");
    expect(await cache.get(file3)).toBe("Compiled");
  });
});
