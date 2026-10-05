// ============================================================
// Atomic rename that tolerates transient Windows sharing violations
// ============================================================

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";

/**
 * Win32 error codes that mean "the destination is momentarily busy", not
 * "this can never work". EPERM is what Node surfaces for
 * ERROR_ACCESS_DENIED from MoveFileEx.
 */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `fs.rename`, retried briefly on a transient Windows sharing violation.
 *
 * On Windows, MoveFileEx fails with EPERM when the destination file has an open
 * handle that was not opened with FILE_SHARE_DELETE. Our own concurrent readers
 * do exactly that for a few milliseconds — a second instance calling load(), a
 * session-list scan, a file watcher — so an atomic write can fail through no
 * fault of its own.
 *
 * That matters more than it looks: rename IS the durability guarantee here. The
 * tmp→rename pair means a reader always sees either the complete old file or
 * the complete new one, and if rename throws, the save is lost outright (and a
 * stray .tmp is left for the startup sweep to collect). A few tens of
 * milliseconds of backoff turns a silently dropped session save into an
 * ordinary successful one.
 *
 * Genuinely permanent errors (ENOENT, EXDEV, a directory in the way) still
 * throw on the first attempt — only sharing violations are retried.
 */
export async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsPromises.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT.has(code) || attempt >= attempts) throw err;
      // 10, 20, 30, 40, 50ms — ~150ms total, well under any caller's budget.
      await sleep(10 * attempt);
    }
  }
}

/**
 * Block the current thread without spinning. `Atomics.wait` on a
 * SharedArrayBuffer is the only true synchronous sleep in Node — a busy-wait
 * would burn a core for the whole backoff.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The synchronous twin of {@link renameWithRetry}, for the many call sites that
 * are already synchronous (checkpoint blob and mirror writes, session runtime,
 * cron store, trust store).
 *
 * Same contract: only Windows sharing violations are retried; every other error
 * throws on the first attempt. Blocking up to ~150ms on a transient violation is
 * strictly cheaper than the alternative, which is silently losing the write.
 */
export function renameSyncWithRetry(from: string, to: string, attempts = 6): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT.has(code) || attempt >= attempts) throw err;
      sleepSync(10 * attempt);
    }
  }
}
