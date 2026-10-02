// ============================================================
// Tests: Agent Memory (M35, kernel §5)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentMemoryDir,
  agentMemoryFile,
  assertSafeAgentType,
  loadAgentMemoryPrompt,
  saveAgentMemory,
} from "../agent-memory.js";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-agent-mem-"));
  process.env.CCR_AGENT_MEMORY_USER_DIR = path.join(workspace, "user-memory");
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  delete process.env.CCR_AGENT_MEMORY_LOCAL_DIR;
  delete process.env.CCR_AGENT_MEMORY_USER_DIR;
});

describe("assertSafeAgentType", () => {
  it("accepts a normal slug", () => {
    expect(assertSafeAgentType("code-explorer")).toBe("code-explorer");
  });

  it("rejects path traversal and separators", () => {
    expect(() => assertSafeAgentType("../../etc")).toThrow();
    expect(() => assertSafeAgentType("a/b")).toThrow();
    expect(() => assertSafeAgentType("")).toThrow();
    expect(() => assertSafeAgentType("..")).toThrow();
  });
});

describe("agentMemoryDir scopes", () => {
  it("project scope lives under workspace/.claude/agent-memory", () => {
    const dir = agentMemoryDir("project", "general", workspace);
    expect(dir).toBe(path.join(workspace, ".claude", "agent-memory", "general"));
  });

  it("user scope is independent of workspace and can be redirected", () => {
    const dir = agentMemoryDir("user", "general", workspace);
    expect(dir).toBe(path.join(workspace, "user-memory", "general"));
    expect(agentMemoryDir("user", "general", path.join(workspace, "other"))).toBe(dir);
    expect(dir).not.toBe(path.join(os.homedir(), ".claude", "agent-memory", "general"));
  });

  it("local scope can be redirected by env", () => {
    const redirect = path.join(workspace, "redir");
    process.env.CCR_AGENT_MEMORY_LOCAL_DIR = redirect;
    expect(agentMemoryDir("local", "general", workspace)).toBe(path.join(redirect, "general"));
  });
});

describe("loadAgentMemoryPrompt / saveAgentMemory", () => {
  it("returns null when no memory file exists yet (but creates the dir)", () => {
    const out = loadAgentMemoryPrompt("project", "general", workspace);
    expect(out).toBeNull();
    expect(fs.existsSync(agentMemoryDir("project", "general", workspace))).toBe(true);
  });

  it("round-trips saved memory into a scope-tagged prompt block", () => {
    expect(saveAgentMemory("project", "general", workspace, "Prefer Vitest.")).toBe(true);
    const out = loadAgentMemoryPrompt("project", "general", workspace);
    expect(out).toContain("AGENT MEMORY · project");
    expect(out).toContain("Prefer Vitest.");
    expect(fs.existsSync(agentMemoryFile("project", "general", workspace))).toBe(true);
  });

  it("returns null for an empty memory file", () => {
    saveAgentMemory("local", "general", workspace, "   ");
    expect(loadAgentMemoryPrompt("local", "general", workspace)).toBeNull();
  });

  it("refuses to load memory for an unsafe agent type", () => {
    expect(() => loadAgentMemoryPrompt("project", "../escape", workspace)).toThrow();
  });
});
