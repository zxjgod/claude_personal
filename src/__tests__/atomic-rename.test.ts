// Tests: renameWithRetry — tolerating transient Windows sharing violations.
//
// The bug it guards: on Windows, MoveFileEx fails with EPERM when the
// destination has an open handle lacking FILE_SHARE_DELETE. Our own concurrent
// readers do that for a few ms, and since rename IS the durability guarantee of
// every atomic write here, an unretried EPERM silently loses the save.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: actual, rename: vi.fn(actual.rename) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: actual, renameSync: vi.fn(actual.renameSync) };
});

const { rename: renameMock } = await import("node:fs/promises");
const { renameSync: renameSyncMock } = await import("node:fs");
const { renameSyncWithRetry, renameWithRetry } = await import("../utils/atomic-rename.js");

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`mock ${code}`), { code });

describe("renameWithRetry", () => {
  let dir: string;
  let from: string;
  let to: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-rename-"));
    from = path.join(dir, "a.json.tmp");
    to = path.join(dir, "a.json");
    fs.writeFileSync(from, "new", "utf-8");
    fs.writeFileSync(to, "old", "utf-8");
    (renameMock as unknown as Mock).mockClear();
  });

  afterEach(() => {
    (renameMock as unknown as Mock).mockReset();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renames normally when nothing interferes", async () => {
    await renameWithRetry(from, to);
    expect(fs.readFileSync(to, "utf-8")).toBe("new");
    expect(fs.existsSync(from)).toBe(false);
  });

  it.each(["EPERM", "EBUSY", "EACCES"])("retries past a transient %s", async (code) => {
    let calls = 0;
    (renameMock as unknown as Mock).mockImplementation(async () => {
      calls++;
      if (calls <= 2) throw errno(code);
      return undefined;
    });
    await renameWithRetry(from, to);
    expect(calls).toBe(3);
  });

  it("gives up after the retry budget and surfaces the original code", async () => {
    (renameMock as unknown as Mock).mockRejectedValue(errno("EPERM"));
    await expect(renameWithRetry(from, to, 3)).rejects.toMatchObject({ code: "EPERM" });
    expect(renameMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a permanent error", async () => {
    (renameMock as unknown as Mock).mockRejectedValue(errno("ENOENT"));
    await expect(renameWithRetry(from, to)).rejects.toMatchObject({ code: "ENOENT" });
    // One attempt only — retrying ENOENT would just burn the budget.
    expect(renameMock).toHaveBeenCalledTimes(1);
  });
});

describe("renameSyncWithRetry", () => {
  let dir: string;
  let from: string;
  let to: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-renamesync-"));
    from = path.join(dir, "a.json.tmp");
    to = path.join(dir, "a.json");
    fs.writeFileSync(from, "new", "utf-8");
    fs.writeFileSync(to, "old", "utf-8");
    (renameSyncMock as unknown as Mock).mockClear();
  });

  afterEach(() => {
    (renameSyncMock as unknown as Mock).mockReset();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renames normally when nothing interferes", () => {
    renameSyncWithRetry(from, to);
    expect(fs.readFileSync(to, "utf-8")).toBe("new");
    expect(fs.existsSync(from)).toBe(false);
  });

  it.each(["EPERM", "EBUSY", "EACCES"])("retries past a transient %s", (code) => {
    let calls = 0;
    (renameSyncMock as unknown as Mock).mockImplementation(() => {
      calls++;
      if (calls <= 2) throw errno(code);
      return undefined;
    });
    renameSyncWithRetry(from, to);
    expect(calls).toBe(3);
  });

  it("gives up after the retry budget and surfaces the original code", () => {
    (renameSyncMock as unknown as Mock).mockImplementation(() => {
      throw errno("EPERM");
    });
    expect(() => renameSyncWithRetry(from, to, 2)).toThrow(
      expect.objectContaining({ code: "EPERM" }),
    );
    expect(renameSyncMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent error", () => {
    (renameSyncMock as unknown as Mock).mockImplementation(() => {
      throw errno("ENOENT");
    });
    expect(() => renameSyncWithRetry(from, to)).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(renameSyncMock).toHaveBeenCalledTimes(1);
  });
});

type Mock = {
  mockClear: () => void;
  mockReset: () => void;
  mockImplementation: (fn: (...args: unknown[]) => unknown) => void;
  mockRejectedValue: (e: unknown) => void;
};
