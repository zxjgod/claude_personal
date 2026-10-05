// ============================================================
// Tests: MCPManager tool wrapping — wrapped-name collisions and
// protocol-level tool failures (round 3 code review).
// ============================================================

import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "../mcp/index.js";
import { MCPManager } from "../mcp/index.js";
import type { ToolContext } from "../types.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/mock-mcp-envtool-stdio-server.mjs", import.meta.url),
);

/** A stdio server whose single tool is named/described by the env. */
function config(env: Record<string, string>): MCPServerConfig {
  return { type: "stdio", command: process.execPath, args: [FIXTURE], env };
}

function ctx(askUser?: (tool: unknown, input: unknown, reason: string) => Promise<boolean>) {
  return {
    workspaceRoot: process.cwd(),
    sessionId: "mcp-collide",
    permissionMode: "default",
    askUser,
  } as unknown as ToolContext;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("MCP wrapped-name collisions", () => {
  it("keeps the first server's tool usable when two servers collide on the wrapped name", async () => {
    const mgr = new MCPManager();
    try {
      // "a" + tool "b__c" and "a__b" + tool "c" both wrap to mcp__a__b__c.
      // The descriptions differ, so their definition hashes differ too.
      await mgr.connectServer(
        "a",
        config({ MOCK_MCP_TOOL: "b__c", MOCK_MCP_DESCRIPTION: "from a", MOCK_MCP_TAG: "A" }),
      );
      await mgr.connectServer(
        "a__b",
        config({ MOCK_MCP_TOOL: "c", MOCK_MCP_DESCRIPTION: "from a__b", MOCK_MCP_TAG: "B" }),
      );

      const tools = mgr.getAllTools();
      expect(tools.map((t) => t.name)).toEqual(["mcp__a__b__c"]);

      // Regression: with one flat fingerprint map, server B's connect overwrote
      // server A's hash, so A's (only surviving) tool was refused with
      // "definition changed" on every call — permanently unusable, and the user
      // was never even asked.
      const approve = vi.fn(async () => true);
      const decision = await tools[0].checkPermissions({ message: "hi" }, ctx(approve));
      expect(decision.allowed).toBe(true);
      expect(approve).toHaveBeenCalledTimes(1);

      // …and the winner really is server A (first server wins, like getAllTools).
      const result = await tools[0].call({ message: "hi" }, ctx());
      expect(result.content).toBe("A:hi");
    } finally {
      await mgr.disconnectAll();
    }
  }, 60_000);

  it("disconnecting one colliding server leaves the survivor's tools working", async () => {
    const mgr = new MCPManager();
    try {
      await mgr.connectServer(
        "a",
        config({ MOCK_MCP_TOOL: "b__c", MOCK_MCP_DESCRIPTION: "from a", MOCK_MCP_TAG: "A" }),
      );
      await mgr.connectServer(
        "a__b",
        config({ MOCK_MCP_TOOL: "c", MOCK_MCP_DESCRIPTION: "from a__b", MOCK_MCP_TAG: "B" }),
      );
      await mgr.disconnectServer("a");
      // "a__b" is the only server left, so its tool becomes the exposed one.
      const exposed = mgr.getAllTools();
      expect(exposed.map((t) => t.name)).toEqual(["mcp__a__b__c"]);
      const decision = await exposed[0].checkPermissions(
        { message: "hi" },
        ctx(async () => true),
      );
      expect(decision.allowed).toBe(true);
    } finally {
      await mgr.disconnectAll();
    }
  }, 60_000);

  it("still refuses a tool whose definition changed under it (fingerprint check intact)", async () => {
    const mgr = new MCPManager();
    try {
      await mgr.connectServer(
        "srv",
        config({ MOCK_MCP_TOOL: "probe", MOCK_MCP_DESCRIPTION: "v1", MOCK_MCP_TAG: "S" }),
      );
      const stale = mgr.getAllTools()[0];
      // The server edits its tool description and notifies a list change.
      await mgr.disconnectServer("srv");
      await mgr.connectServer(
        "srv",
        config({ MOCK_MCP_TOOL: "probe", MOCK_MCP_DESCRIPTION: "v2", MOCK_MCP_TAG: "S" }),
      );
      const decision = await stale.checkPermissions(
        { message: "hi" },
        ctx(async () => true),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.allowed ? "" : decision.reason).toMatch(/definition changed/i);
    } finally {
      await mgr.disconnectAll();
    }
  }, 60_000);
});

describe("MCP tool result handling", () => {
  it("surfaces isError as an error result instead of a success", async () => {
    const mgr = new MCPManager();
    try {
      await mgr.connectServer("failing", config({ MOCK_MCP_TOOL: "probe", MOCK_MCP_TAG: "F" }));
      const tool = mgr.getAllTools()[0];
      const result = await tool.call({ message: "x", fail: true }, ctx());
      expect(result.error).toMatch(/tool refused/);
      expect(result.content).toBe("F:tool refused");
      // The TUI renders whatever formatResult returns; it must read as an error.
      expect(tool.formatResult?.(result)).toMatch(/^Error:/);
    } finally {
      await mgr.disconnectAll();
    }
  }, 60_000);

  it("reports a malformed result (no content array) as an error, not a TypeError", async () => {
    const mgr = new MCPManager();
    try {
      await mgr.connectServer("weird", config({ MOCK_MCP_TOOL: "probe", MOCK_MCP_TAG: "W" }));
      const tool = mgr.getAllTools()[0];
      // Bypass call() and drive checkPermissions-free path: the manager calls
      // client.callTool itself, so stub the client to return `{}`.
      const entry = (
        mgr as unknown as { servers: Map<string, { client: { callTool: unknown } }> }
      ).servers.get("weird");
      if (!entry) throw new Error("server not connected");
      entry.client.callTool = async () => ({});
      const result = await tool.call({ message: "x" }, ctx());
      expect(result.error).toMatch(/malformed tool result/);
    } finally {
      await mgr.disconnectAll();
    }
  }, 60_000);
});
