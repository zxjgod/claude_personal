import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { renameSyncWithRetry } from "./atomic-rename.js";

/** Serialize synchronous read-modify-write transactions across processes. */
export function withFileLock<T>(file: string, operation: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let release: (() => void) | undefined;
  // Parameter contract (review fix): the acquire deadline must EXCEED the
  // stale timeout — otherwise a crashed holder's lock (reclaimable only after
  // `stale` ms) can never be waited out, and waiters throw for the whole
  // remainder of the stale window. The previous 2s deadline vs 60s stale
  // guaranteed exactly that. 10s stale is ample for these small JSON
  // read-modify-writes (a sync critical section that long means a hang, not
  // a slow disk), and 12s lets a waiter actually reclaim a dead lock.
  const STALE_MS = 10_000;
  const deadline = Date.now() + 12_000;
  while (!release) {
    try {
      release = lockfile.lockSync(file, { realpath: false, stale: STALE_MS });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline)
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return operation();
  } finally {
    release();
  }
}
export function atomicWriteFile(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  renameSyncWithRetry(temp, file);
}
