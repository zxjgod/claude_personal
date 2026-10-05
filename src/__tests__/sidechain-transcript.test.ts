// ============================================================
// Tests: Sidechain transcript recorder (拍板 #22) — audit/report modes
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordSidechainReport,
  recordSidechainToolResult,
  recordSidechainToolUse,
  resetSidechainTranscripts,
} from "../sidechain-transcript.js";
import { setSubagentSettings } from "../subagent-settings.js";
import { SessionTranscript } from "../tui/session-transcript.js";

let ws = "";
const SID = "sess-sidechain";

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sidechain-"));
  resetSidechainTranscripts();
  setSubagentSettings({ sidechainMode: "audit", thinking: false });
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  setSubagentSettings({ sidechainMode: "audit" });
  resetSidechainTranscripts();
});

function entries() {
  return new SessionTranscript(ws).read(SID);
}

describe("sidechain transcript (#22)", () => {
  it("audit mode records tool calls AND the final report, sidechain-marked", async () => {
    await recordSidechainToolUse(ws, SID, "general", "t1", "bash", { command: "ls" });
    await recordSidechainToolResult(ws, SID, "general", "bash", "file-a\nfile-b");
    await recordSidechainReport(ws, SID, "general", "all done", 1200, 1);
    const es = entries();
    expect(es.map((e) => e.type)).toEqual(["tool_use", "tool_result", "subagent_report"]);
    for (const e of es) {
      expect(e.isSidechain).toBe(true);
      expect(e.agentName).toBe("general");
    }
    expect(es[2]).toMatchObject({ report: "all done", durationMs: 1200, toolCalls: 1 });
  });

  it("report mode records ONLY the final report (仅最终报告回流)", async () => {
    setSubagentSettings({ sidechainMode: "report" });
    await recordSidechainToolUse(ws, SID, "general", "t1", "bash", { command: "ls" });
    await recordSidechainToolResult(ws, SID, "general", "bash", "out");
    await recordSidechainReport(ws, SID, "general", "final report only", 500, 1);
    const es = entries();
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({
      type: "subagent_report",
      report: "final report only",
      isSidechain: true,
      agentName: "general",
    });
  });

  it("replay() folds skip sidechain entries (official /resume filter parity)", async () => {
    const t = SessionTranscript.forWorkspace(ws);
    await t.append(SID, { type: "user_prompt", text: "main line prompt" });
    await recordSidechainToolUse(ws, SID, "general", "t1", "bash", { command: "ls" });
    const summary = t.replay(SID);
    expect(summary.prompts).toBe(1);
    expect(summary.toolCalls).toBe(0); // the sidechain bash call is invisible
  });

  it("oversized tool inputs are truncated, never dropped silently", async () => {
    await recordSidechainToolUse(ws, SID, "general", "t1", "write", {
      file_path: "x",
      content: "y".repeat(10_000),
    });
    const [e] = entries();
    if (e?.type !== "tool_use") throw new Error("expected tool_use");
    const raw = JSON.stringify(e.input);
    expect(raw.length).toBeLessThan(3000);
    expect(raw).toContain("_truncated");
  });

  it("coexists with main-line entries in one file with monotonic seq", async () => {
    const t = SessionTranscript.forWorkspace(ws);
    await t.append(SID, { type: "user_prompt", text: "p1" });
    await recordSidechainReport(ws, SID, "general", "r1");
    await t.append(SID, { type: "done", finishReason: "end_turn", turns: 1 });
    const es = new SessionTranscript(ws).read(SID);
    expect(es.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(es[1]?.isSidechain).toBe(true);
    expect(es[0]?.isSidechain).toBeUndefined();
  });

  it("a rejected append never escapes as an unhandled rejection (round 4)", async () => {
    // The Task tool calls these fire-and-forget. An unusable id (or a full /
    // read-only disk) used to reject with nobody listening, which terminates
    // the CLI on an unhandled rejection — over a best-effort audit line.
    await expect(
      recordSidechainToolUse(ws, "../escape", "general", "t1", "bash", { command: "ls" }),
    ).resolves.toBeUndefined();
    // And the path must not have been written outside .claude/sessions.
    expect(fs.existsSync(path.join(ws, ".claude", "escape.transcript.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".claude", "sessions", "escape.transcript.jsonl"))).toBe(
      false,
    );
  });
});
