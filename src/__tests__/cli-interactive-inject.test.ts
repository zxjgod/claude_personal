// ============================================================
// Tests: raw input reader — scheduler injection order (round 4)
// ============================================================

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createRawInputReader } from "../tui/cli-interactive.js";

/** A throwaway stdin so the reader never touches the real one. */
function fakeStdin() {
  return new PassThrough() as unknown as NodeJS.ReadStream;
}

describe("createRawInputReader.inject", () => {
  it("replays injected lines in delivery order (FIFO)", async () => {
    const reader = createRawInputReader({ commands: [], input: fakeStdin() });
    try {
      // readInput drains with shift(), so inject() must push at the tail.
      // unshift() used to answer a burst of scheduler prompts in reverse.
      reader.inject("first");
      reader.inject("second");
      reader.inject("third");
      expect(await reader.readInput()).toBe("first");
      expect(await reader.readInput()).toBe("second");
      expect(await reader.readInput()).toBe("third");
    } finally {
      reader.close();
    }
  });

  it("ignores empty injections", async () => {
    const reader = createRawInputReader({ commands: [], input: fakeStdin() });
    try {
      reader.inject("");
      reader.inject("real");
      expect(await reader.readInput()).toBe("real");
    } finally {
      reader.close();
    }
  });
});
