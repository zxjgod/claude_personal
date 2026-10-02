import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";

/** Serialize synchronous read-modify-write transactions across processes. */
export function withFileLock<T>(file: string, operation: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let release: (() => void) | undefined;
  const deadline = Date.now() + 2000;
  while (!release) {
    try {
      release = lockfile.lockSync(file, { realpath: false, stale: 60000 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline)
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
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
  fs.renameSync(temp, file);
}
