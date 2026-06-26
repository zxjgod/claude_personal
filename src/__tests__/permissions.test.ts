// ============================================================
// Tests: Permission System
// ============================================================

import { describe, it, expect, vi } from "vitest";
import {
  checkPermission,
  classifyPermissionRisk,
  parseClassifierVerdict,
} from "../permissions.js";
import { createTool } from "../tool-registry.js";
import type {
  Message,
  ModelCaller,
  ModelConfig,
  StreamEvent,
  Tool,
  ToolContext,
} from "../types.js";

const WORKSPACE = "/home/user/project";

function makeContext(
  mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" = "default",
): ToolContext {
  return {
    workspaceRoot: WORKSPACE,
    sessionId: "test",
    permissionMode: mode,
  };
}

async function alwaysAllow(): Promise<boolean> {
  return true;
}
async function alwaysDeny(): Promise<boolean> {
  return false;
}

describe("checkPermission", () => {
  it("should allow read-only tools", async () => {
    const tool = createTool({
      name: "read",
      description: "Read",
      promptDescription: "Read files",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: true,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      {},
      makeContext(),
      { askUser: alwaysDeny },
    );
    expect(result.allowed).toBe(true);
  });

  it("should deny destructive tools in plan mode", async () => {
    const tool = createTool({
      name: "write",
      description: "Write",
      promptDescription: "Write files",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: false,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      {},
      makeContext("plan"),
      { askUser: alwaysAllow },
    );
    expect(result.allowed).toBe(false);
  });

  it("should allow everything in bypass mode", async () => {
    const tool = createTool({
      name: "bash",
      description: "Bash",
      promptDescription: "Run commands",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      { command: "rm -rf /" },
      makeContext("bypassPermissions"),
      { askUser: alwaysDeny },
    );
    expect(result.allowed).toBe(true);
  });

  it("should block .env files", async () => {
    const tool = createTool({
      name: "read",
      description: "Read",
      promptDescription: "Read",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      { filePath: "/home/user/project/.env" },
      makeContext(),
      { askUser: alwaysAllow },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked");
  });

  it("should block .ssh paths", async () => {
    const tool = createTool({
      name: "read",
      description: "Read",
      promptDescription: "Read",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      { filePath: "/home/user/.ssh/id_rsa" },
      makeContext(),
      { askUser: alwaysAllow },
    );
    expect(result.allowed).toBe(false);
  });

  it("should auto-approve edits in acceptEdits mode", async () => {
    const tool = createTool({
      name: "edit",
      description: "Edit",
      promptDescription: "Edit files",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: false,
      call: async () => ({ content: "" }),
    });

    const result = await checkPermission(
      tool,
      { filePath: "/home/user/project/src/file.ts", old_string: "a", new_string: "b" },
      makeContext("acceptEdits"),
      { askUser: alwaysDeny },
    );
    expect(result.allowed).toBe(true);
  });

  it("should ask user for dangerous bash command", async () => {
    const tool = createTool({
      name: "bash",
      description: "Bash",
      promptDescription: "Run commands",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const askUser = vi.fn().mockResolvedValue(false);
    const result = await checkPermission(
      tool,
      { command: "rm -rf /tmp/build" },
      makeContext(),
      { askUser },
    );
    expect(askUser).toHaveBeenCalled();
    expect(result.allowed).toBe(false);
  });

  it("should allow tools that explicitly do not require approval", async () => {
    const tool = createTool({
      name: "task",
      description: "Task",
      promptDescription: "Run a sub-agent",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      requiresApproval: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });

    const askUser = vi.fn().mockResolvedValue(false);
    const result = await checkPermission(tool, {}, makeContext(), { askUser });
    expect(result.allowed).toBe(true);
    expect(askUser).not.toHaveBeenCalled();
  });

  it("should still prompt for ordinary destructive tools", async () => {
    const tool = createTool({
      name: "write",
      description: "Write",
      promptDescription: "Write files",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: false,
      call: async () => ({ content: "" }),
    });

    const askUser = vi.fn().mockResolvedValue(false);
    const result = await checkPermission(tool, {}, makeContext(), { askUser });
    expect(result.allowed).toBe(false);
    expect(askUser).toHaveBeenCalled();
  });
});

// ============================================================
// M15.3: LLM-assisted permission classifier
// ============================================================

const classifierConfig: ModelConfig = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: "test-key",
};

/** Build a ModelCaller that streams a fixed text response (one delta). */
function makeTextCaller(text: string): ModelCaller {
  return async function* (
    _messages: Message[],
    _tools: Tool[],
    _systemPrompt: string,
    _config: ModelConfig,
  ): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", delta: text };
    yield {
      type: "done",
      usage: { input_tokens: 1, output_tokens: 1 },
      finish_reason: "stop",
    };
  };
}

describe("parseClassifierVerdict", () => {
  it("parses BLOCK with a reason", () => {
    expect(parseClassifierVerdict("BLOCK|wipes the workspace root")).toEqual({
      block: true,
      reason: "wipes the workspace root",
    });
  });

  it("parses CONFIRM and keeps the reason as a hint", () => {
    expect(parseClassifierVerdict("CONFIRM|deletes ./build recursively")).toEqual({
      block: false,
      reason: "deletes ./build recursively",
    });
  });

  it("ALLOW drops the annotation (regex reason stands)", () => {
    expect(parseClassifierVerdict("ALLOW|routine node_modules clean")).toEqual({
      block: false,
      reason: undefined,
    });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseClassifierVerdict("  block | danger  ")).toEqual({
      block: true,
      reason: "danger",
    });
  });

  it("defers (unavailable) on unparseable output", () => {
    expect(parseClassifierVerdict("I think this is fine")).toEqual({
      block: false,
      unavailable: true,
    });
  });

  it("takes the last VERDICT|reason line when the model adds preamble", () => {
    expect(
      parseClassifierVerdict("Looking at the command...\nBLOCK|rm -rf /"),
    ).toEqual({ block: true, reason: "rm -rf /" });
  });
});

describe("classifyPermissionRisk", () => {
  it("defers when there is no API key (fail-safe)", async () => {
    const caller = makeTextCaller("BLOCK|should not happen");
    const res = await classifyPermissionRisk("bash", { command: "rm -rf /" }, {
      callModel: caller,
      modelConfig: { ...classifierConfig, apiKey: "" },
    });
    expect(res).toEqual({ block: false, unavailable: true });
  });

  it("defers when the caller throws (fail-safe)", async () => {
    const caller: ModelCaller = async function* () {
      throw new Error("network down");
    };
    const res = await classifyPermissionRisk("bash", { command: "rm -rf /" }, {
      callModel: caller,
      modelConfig: classifierConfig,
    });
    expect(res).toEqual({ block: false, unavailable: true });
  });

  it("returns the model verdict for a flagged command", async () => {
    const caller = makeTextCaller("BLOCK|recursively deletes everything");
    const res = await classifyPermissionRisk(
      "bash",
      { command: "rm -rf /" },
      { callModel: caller, modelConfig: classifierConfig },
    );
    expect(res.block).toBe(true);
    expect(res.reason).toBe("recursively deletes everything");
  });
});

describe("checkPermission + classifier integration", () => {
  // Reuse the dangerous-bash tool shape from the suite above.
  function bashTool(): Tool {
    return createTool({
      name: "bash",
      description: "Bash",
      promptDescription: "Run commands",
      inputSchema: { type: "object", properties: {}, required: [] },
      isReadOnly: false,
      isConcurrencySafe: true,
      call: async () => ({ content: "" }),
    });
  }

  it("classifier BLOCK refuses before prompting the user", async () => {
    const tool = bashTool();
    const askUser = vi.fn().mockResolvedValue(true);
    const result = await checkPermission(
      tool,
      { command: "rm -rf /" },
      makeContext(),
      {
        askUser,
        classifier: {
          callModel: makeTextCaller("BLOCK|rm -rf / is catastrophic"),
          modelConfig: classifierConfig,
        },
      },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("rm -rf / is catastrophic");
    // BLOCK short-circuits — the user is never prompted.
    expect(askUser).not.toHaveBeenCalled();
  });

  it("classifier CONFIRM enriches the prompt reason but still asks", async () => {
    const tool = bashTool();
    const askUser = vi.fn().mockResolvedValue(false);
    const result = await checkPermission(
      tool,
      { command: "rm -rf ./build" },
      makeContext(),
      {
        askUser,
        classifier: {
          callModel: makeTextCaller("CONFIRM|deletes the build dir recursively"),
          modelConfig: classifierConfig,
        },
      },
    );
    expect(askUser).toHaveBeenCalledTimes(1);
    // The enriched model reason is what was shown to the user.
    expect(askUser.mock.calls[0]![2]).toBe("deletes the build dir recursively");
    expect(result.allowed).toBe(false);
  });

  it("classifier ALLOW defers to the regex reason and still prompts", async () => {
    const tool = bashTool();
    const askUser = vi.fn().mockResolvedValue(true);
    await checkPermission(
      tool,
      { command: "rm -rf node_modules" },
      makeContext(),
      {
        askUser,
        classifier: {
          callModel: makeTextCaller("ALLOW|routine clean"),
          modelConfig: classifierConfig,
        },
      },
    );
    expect(askUser).toHaveBeenCalledTimes(1);
    // ALLOW → no model annotation; the original regex reason is shown.
    expect(askUser.mock.calls[0]![2]).toBe(
      "Command includes recursive deletion (rm -r)",
    );
  });

  it("classifier unavailable (unparseable) falls back to the regex reason", async () => {
    const tool = bashTool();
    const askUser = vi.fn().mockResolvedValue(false);
    await checkPermission(
      tool,
      { command: "rm -rf /tmp/x" },
      makeContext(),
      {
        askUser,
        classifier: {
          callModel: makeTextCaller("hmm not sure"),
          modelConfig: classifierConfig,
        },
      },
    );
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(askUser.mock.calls[0]![2]).toBe(
      "Command includes recursive deletion (rm -r)",
    );
  });

  it("without a classifier, the dangerous-bash path is unchanged", async () => {
    const tool = bashTool();
    const askUser = vi.fn().mockResolvedValue(false);
    const result = await checkPermission(
      tool,
      { command: "rm -rf /tmp/x" },
      makeContext(),
      { askUser },
    );
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(askUser.mock.calls[0]![2]).toBe(
      "Command includes recursive deletion (rm -r)",
    );
    expect(result.allowed).toBe(false);
  });
});
