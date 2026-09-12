import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli-args.js";

describe("CLI compatibility flags", () => {
  it("parses print, formats, sessions, and directories", () => {
    const a = parseCliArgs([
      "node",
      "ccr",
      "--print",
      "hello",
      "--output-format",
      "json",
      "--input-format=stream-json",
      "--resume",
      "abc",
      "--add-dir",
      "x",
    ]);
    expect(a.print).toBe(true);
    expect(a.prompt).toBe("hello");
    expect(a.outputFormat).toBe("json");
    expect(a.inputFormat).toBe("stream-json");
    expect(a.resume).toBe("abc");
    expect(a.addDirs).toEqual(["x"]);
  });

  it("accepts repeated add-dir and explicit session compatibility flags", () => {
    const a = parseCliArgs([
      "node",
      "ccr",
      "-p",
      "--add-dir",
      "a",
      "--add-dir=b",
      "--session-id",
      "s1",
      "--fork-session",
    ]);
    expect(a.print).toBe(true);
    expect(a.addDirs).toEqual(["a", "b"]);
    expect(a.sessionId).toBe("s1");
    expect(a.forkSession).toBe(true);
  });
});
