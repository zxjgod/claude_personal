// ============================================================
// Tests: MemorySave tool + auto-extraction (F1) — memory write path
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAgentMemory } from "../agent-memory.js";
import { setMemoryApproval } from "../memory-approval.js";
import { autoExtractMemoriesOnExit, MemoryStore } from "../memory-extract.js";
import { MemorySaveTool } from "../tools/extended/memory-save.js";
import type { Message, ModelCaller, ToolContext } from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-memsave-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({
  workspaceRoot: tmpDir,
  sessionId: "memsave-test",
  permissionMode: "default",
  // Tests simulate an approving user; production without an approval channel
  // must block (see the "requires explicit approval" test below).
  askUser: async () => true,
});

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("MemorySaveTool", () => {
  it("writes a durable memory to the retrieval store", async () => {
    const result = await MemorySaveTool.call(
      { content: "Always run pnpm test before committing in this repo" },
      ctx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.metadata?.summary).toBe("Memory saved");
    const stored = new MemoryStore(tmpDir).list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.text).toContain("pnpm test");
    expect(stored[0]!.source).toBe("manual");
  });

  it("dedupes an identical repeat save", async () => {
    await MemorySaveTool.call({ content: "Prefer tabs over spaces here" }, ctx());
    const second = await MemorySaveTool.call({ content: "Prefer tabs over spaces here" }, ctx());
    expect(second.metadata?.summary).toBe("Memory already present (deduped)");
    expect(new MemoryStore(tmpDir).list()).toHaveLength(1);
  });

  it("also appends to the agent-type MEMORY.md when agent_type is given", async () => {
    const result = await MemorySaveTool.call(
      { content: "Run tests from the repo root only", agent_type: "code-reviewer" },
      ctx(),
    );
    expect(result.content).toContain("code-reviewer");
    const md = path.join(tmpDir, ".claude", "agent-memory", "code-reviewer", "MEMORY.md");
    const content = fs.readFileSync(md, "utf-8");
    expect(content).toContain("## Auto-saved");
    expect(content).toContain("- Run tests from the repo root only");
  });

  // The approval gate defaults OFF (user decision 2026-10-04); the next two
  // tests cover the ON posture, so enable it explicitly.
  it("gate ON: blocks project-scope writes without an approval channel", async () => {
    setMemoryApproval(true);
    try {
      const bare: ToolContext = {
        workspaceRoot: tmpDir,
        sessionId: "memsave-test",
        permissionMode: "default",
      };
      const result = await MemorySaveTool.call({ content: "unapproved lesson" }, bare);
      expect(result.error).toContain("approval");
      expect(new MemoryStore(tmpDir).list()).toHaveLength(0);
    } finally {
      setMemoryApproval(false);
    }
  });

  it("gate ON: blocks when the user declines the approval prompt", async () => {
    setMemoryApproval(true);
    try {
      const declining: ToolContext = { ...ctx(), askUser: async () => false };
      const result = await MemorySaveTool.call({ content: "declined lesson" }, declining);
      expect(result.error).toContain("approval");
      expect(new MemoryStore(tmpDir).list()).toHaveLength(0);
    } finally {
      setMemoryApproval(false);
    }
  });
});

describe("appendAgentMemory", () => {
  it("merges under one Auto-saved heading and dedupes identical lines", () => {
    expect(appendAgentMemory("project", "general", tmpDir, "lesson one")).toBe(true);
    expect(appendAgentMemory("project", "general", tmpDir, "lesson two")).toBe(true);
    expect(appendAgentMemory("project", "general", tmpDir, "lesson one")).toBe(true); // dedupe
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "agent-memory", "general", "MEMORY.md"),
      "utf-8",
    );
    expect(content.match(/## Auto-saved/g)).toHaveLength(1);
    expect(content.match(/- lesson one/g)).toHaveLength(1);
    expect(content.match(/- lesson two/g)).toHaveLength(1);
  });

  it("returns false for empty input without creating anything", () => {
    expect(appendAgentMemory("project", "general", tmpDir, "   ")).toBe(false);
  });
});

describe("autoExtractMemoriesOnExit", () => {
  it("persists preference lines but skips the session file-changes summary", async () => {
    const written = await autoExtractMemoriesOnExit({
      workspaceRoot: tmpDir,
      messages: [userMsg("Remember that deploys happen on Fridays"), userMsg("fix the bug")],
      changes: [{ path: "src/a.ts", kind: "modified", edits: 1, updatedAt: 1 }],
    });
    expect(written).toHaveLength(1);
    expect(written[0]!.text).toContain("Fridays");
    const stored = new MemoryStore(tmpDir).list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tags).toContain("preference");
  });

  it("merges the model-assisted pass when enabled", async () => {
    const caller: ModelCaller = async function* () {
      yield { type: "text_delta", delta: '["User prefers concise answers"]' };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    const written = await autoExtractMemoriesOnExit({
      workspaceRoot: tmpDir,
      messages: [userMsg("hello")],
      useModel: true,
      callModel: caller,
      modelConfig: { provider: "openai", model: "t", apiKey: "k" },
    });
    expect(written).toHaveLength(1);
    expect(written[0]!.text).toBe("User prefers concise answers");
    expect(written[0]!.source).toBe("model");
  });

  it("never throws when the model pass fails", async () => {
    // biome-ignore lint/correctness/useYield: deliberate mock — throws before yielding
    const caller: ModelCaller = async function* () {
      throw new Error("API down");
    };
    const written = await autoExtractMemoriesOnExit({
      workspaceRoot: tmpDir,
      messages: [userMsg("Always use strict mode")],
      useModel: true,
      callModel: caller,
      modelConfig: { provider: "openai", model: "t", apiKey: "k" },
    });
    // The heuristic preference line still lands; the model pass contributed 0.
    expect(written).toHaveLength(1);
    expect(written[0]!.text).toContain("strict mode");
  });

  it("returns [] when nothing durable is found", async () => {
    const written = await autoExtractMemoriesOnExit({
      workspaceRoot: tmpDir,
      messages: [userMsg("what is 2+2")],
    });
    expect(written).toEqual([]);
  });
});
