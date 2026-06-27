// ============================================================
// Tests: SessionTranscript (M19.2)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionTranscript } from "../session-transcript.js";

let tmpDir: string;
let t: SessionTranscript;
const SID = "sess-1";

function transcriptPath(): string {
  return path.join(tmpDir, ".claude", "sessions", `${SID}.transcript.jsonl`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-transcript-"));
  t = new SessionTranscript(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionTranscript", () => {
  it("returns [] when no transcript exists", () => {
    expect(t.read(SID)).toEqual([]);
  });

  it("append→read preserves order and stamps seq", async () => {
    await t.append(SID, { type: "user_prompt", text: "do a thing" });
    await t.append(SID, { type: "tool_use", id: "1", name: "edit", input: { file: "a.ts" } });
    await t.append(SID, {
      type: "tool_result",
      name: "edit",
      durationMs: 5,
      preview: "ok",
    });
    await t.append(SID, { type: "usage", input: 100, output: 20, cacheRead: 10 });
    await t.append(SID, { type: "done", finishReason: "end_turn", turns: 1 });

    const entries = t.read(SID);
    expect(entries.map((e) => e.type)).toEqual([
      "user_prompt",
      "tool_use",
      "tool_result",
      "usage",
      "done",
    ]);
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    entries.forEach((e) => {
      expect(typeof e.ts).toBe("string");
    });
  });

  it("skips a malformed trailing line", async () => {
    await t.append(SID, { type: "user_prompt", text: "hi" });
    // Simulate a crash mid-write: append a partial JSON line.
    fs.appendFileSync(transcriptPath(), '{"type":"tool_use","id":"x"', "utf-8");
    const entries = t.read(SID);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("user_prompt");
  });

  it("replay folds usage, tool calls, and turns", async () => {
    await t.append(SID, { type: "user_prompt", text: "p1" });
    await t.append(SID, { type: "tool_use", id: "1", name: "bash", input: {} });
    await t.append(SID, { type: "tool_use", id: "2", name: "edit", input: {} });
    await t.append(SID, { type: "tool_use", id: "3", name: "edit", input: {} });
    await t.append(SID, { type: "usage", input: 50, output: 10, cacheRead: 5, cacheCreation: 2 });
    await t.append(SID, { type: "usage", input: 30, output: 6 });
    await t.append(SID, { type: "done", finishReason: "end_turn", turns: 2 });

    const r = t.replay(SID);
    expect(r.prompts).toBe(1);
    expect(r.toolCalls).toBe(3);
    expect(r.toolCounts).toEqual({ bash: 1, edit: 2 });
    expect(r.totalUsage).toEqual({ input: 80, output: 16, cacheRead: 5, cacheCreation: 2 });
    expect(r.turns).toBe(2);
  });

  it("preview() truncates long output past the cap", () => {
    const short = "small";
    expect(SessionTranscript.preview(short)).toBe(short);
    const long = "x".repeat(5000);
    const out = SessionTranscript.preview(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("more chars");
  });
});
