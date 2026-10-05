// ============================================================
// Regression tests: Medium fixes (2026-10 review, round 7)
//  - "--flag=value" form honored by resolveMaxTurns / getPermissionMode
//  - corrupt settings file warns loudly instead of silently dropping deny rules
//  - session id format validation (directory traversal floor)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPermissionMode, resolveMaxTurns } from "../cli-config.js";
import { applyToolResultBudget } from "../context-pipeline.js";
import { isContextLengthError } from "../error-recovery.js";
import { PersistenceManager } from "../persistence.js";
import { isValidSessionId } from "../session-memory.js";
import { readSettingsFile } from "../settings.js";
import { StreamingToolExecutor } from "../streaming-tool-executor.js";
import { executeSingleTool } from "../tool-executor.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Message, Tool, ToolContext } from "../types.js";

let root: string;
const originalArgv = process.argv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-medium-"));
  vi.stubEnv("CCR_MANAGED_SETTINGS", "");
  vi.stubEnv("CCR_SETTING_SOURCES", "user"); // no project/local bleed-through
});
afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('"--flag=value" form (fail-open regression)', () => {
  it("resolveMaxTurns honors --max-turns=5", () => {
    process.argv = ["node", "cli", "--max-turns=5"];
    expect(resolveMaxTurns()).toBe(5);
  });

  it("resolveMaxTurns still honors the spaced form", () => {
    process.argv = ["node", "cli", "--max-turns", "7"];
    expect(resolveMaxTurns()).toBe(7);
  });

  it("getPermissionMode honors --permission-mode=plan", () => {
    process.argv = ["node", "cli", "--permission-mode=plan"];
    expect(getPermissionMode(root)).toBe("plan");
  });

  it("getPermissionMode still honors the spaced form", () => {
    process.argv = ["node", "cli", "--permission-mode", "plan"];
    expect(getPermissionMode(root)).toBe("plan");
  });
});

describe("corrupt settings file", () => {
  it("warns loudly instead of silently dropping deny rules", () => {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(file, "{ not valid json");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readSettingsFile(file)).toEqual({});
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toContain("deny rules");
  });

  it("a missing file stays silent", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readSettingsFile(path.join(root, "nope.json"))).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("session id validation", () => {
  it("accepts generated id shapes", () => {
    expect(isValidSessionId(crypto.randomUUID())).toBe(true);
    expect(isValidSessionId("abc123-skill-1791039399059")).toBe(true);
  });

  it("rejects traversal and separators", () => {
    for (const bad of ["../evil", "..", "a/b", "a\\b", ".hidden", "x y", "x.y"]) {
      expect(isValidSessionId(bad)).toBe(false);
    }
  });

  it("sessionPath refuses an invalid id even when called directly", async () => {
    const pm = new PersistenceManager(root);
    await expect(pm.load("../../evil")).rejects.toThrow("Invalid session id");
  });
});

// ============================================================
// Round 8 (Medium: 工具/注册表 + 代理循环/hooks)
// ============================================================

function fakeTool(name: string, call?: Tool["call"]): Tool {
  return {
    name,
    description: name,
    promptDescription: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: call ?? (async () => ({ content: "ok" })),
    formatResult: (r) => r.content,
    checkPermissions: async () => ({ allowed: true }),
  };
}

describe("StreamingToolExecutor canAutoApprove veto", () => {
  it("does not early-start a read-only call that would PROMPT (ask rule)", async () => {
    let ran = 0;
    const ex = new StreamingToolExecutor(
      true,
      [fakeTool("read")],
      async (n) => {
        ran++;
        return { toolName: n, formatted: "ok", isError: false };
      },
      undefined,
      () => false, // everything needs a prompt → nothing early-starts
    );
    ex.add("c1", "read", { filePath: "a.ts" });
    expect(ex.started).toBe(0);
    expect(ran).toBe(0);
    expect(await ex.take("c1")).toBeNull(); // STEP 5 runs it normally
  });

  it("early-starts when the predicate approves", async () => {
    const ex = new StreamingToolExecutor(
      true,
      [fakeTool("read")],
      async (n) => ({ toolName: n, formatted: "ok", isError: false }),
      undefined,
      () => true,
    );
    ex.add("c1", "read", {});
    expect(ex.started).toBe(1);
  });
});

describe("ToolRegistry canonical collision", () => {
  it("warns on a canonical collision instead of silently shadowing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reg = new ToolRegistry();
    reg.register(fakeTool("read"));
    reg.register(fakeTool("Read")); // collides canonically — must warn
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toContain("canonically collides");
    // Exact-name duplicates still throw.
    expect(() => reg.register(fakeTool("read"))).toThrow(/already registered/);
    // Both stay registered and resolve distinctly by exact name.
    expect(reg.getTool("Read")).toBeDefined();
    expect(reg.getTool("read")).toBeDefined();
  });

  it("does NOT warn for deliberate coexisting pairs (task_list/TaskList)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reg = new ToolRegistry();
    reg.register(fakeTool("task_list"));
    reg.register(fakeTool("TaskList")); // intentional pair — no startup noise
    reg.register(fakeTool("task_get"));
    reg.register(fakeTool("TaskGet"));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("applyToolResultBudget no-amplify", () => {
  it("leaves a result untouched when the marker would be longer than the trim", () => {
    const content = "x".repeat(25); // removable middle: 25-8-8=9 chars ≪ marker
    const messages: Message[] = [{ role: "tool", tool_call_id: "t1", name: "read", content }];
    const out = applyToolResultBudget(messages, {
      maxTotalChars: 5,
      keepRecent: 0,
      headChars: 8,
      tailChars: 8,
    });
    expect(out.changed).toBe(0);
    expect(out.messages[0]!.content).toBe(content);
  });

  it("trims when the saving is real", () => {
    const content = "x".repeat(5000);
    const messages: Message[] = [{ role: "tool", tool_call_id: "t1", name: "read", content }];
    const out = applyToolResultBudget(messages, {
      maxTotalChars: 100,
      keepRecent: 0,
      headChars: 100,
      tailChars: 100,
    });
    expect(out.changed).toBe(1);
    expect((out.messages[0]!.content as string).length).toBeLessThan(content.length);
  });
});

describe("isContextLengthError widened gate", () => {
  it("accepts 413 and missing-status wordings", () => {
    expect(isContextLengthError({ status: 413, message: "prompt is too long" })).toBe(true);
    expect(isContextLengthError({ message: "maximum context length exceeded" })).toBe(true);
    expect(isContextLengthError({ status: 400, message: "context_length_exceeded" })).toBe(true);
  });

  it("still rejects unrelated statuses and messages", () => {
    expect(isContextLengthError({ status: 500, message: "prompt is too long" })).toBe(false);
    expect(isContextLengthError({ status: 400, message: "invalid api key" })).toBe(false);
  });
});

describe("zero-argument tool calls", () => {
  it("executes with {} instead of 'Invalid JSON arguments' when arguments is empty", async () => {
    let seen: Record<string, unknown> | null = null;
    const tool = fakeTool("noop", async (input) => {
      seen = input as Record<string, unknown>;
      return { content: "ok" };
    });
    const context: ToolContext = {
      workspaceRoot: root,
      sessionId: "s1",
      permissionMode: "bypassPermissions",
    };
    const result = await executeSingleTool(
      { id: "c1", type: "function", function: { name: "noop", arguments: "" } },
      [tool],
      context,
      async () => true,
    );
    expect(result.isError).toBe(false);
    expect(seen).toEqual({});
  });
});
