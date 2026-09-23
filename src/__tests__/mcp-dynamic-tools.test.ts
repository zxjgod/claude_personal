// ============================================================
// Tests: MCP dynamic tool refresh (S2)
// ============================================================
// refreshServerTools() re-lists a connected server's tools, swaps them in,
// and fires the change listeners — the engine behind both the
// toolsListChanged notification and /mcp refresh.
// ============================================================

import { describe, expect, it, vi } from "vitest";
import { MCPManager } from "../mcp/index.js";

function remoteTool(name: string, description = `tool ${name}`) {
  return {
    name,
    description,
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  };
}

function managerWithServer(listTools: () => Promise<{ tools: ReturnType<typeof remoteTool>[] }>) {
  const manager = new MCPManager();
  (manager as unknown as { servers: Map<string, unknown> }).servers.set("srv", {
    config: { type: "http", url: "http://example.test" },
    client: { listTools },
    transport: { close: () => undefined },
    tools: [],
  });
  return manager;
}

describe("MCPManager.refreshServerTools (S2)", () => {
  it("re-lists tools, swaps them in, and fires change listeners", async () => {
    let call = 0;
    const manager = managerWithServer(async () => {
      call++;
      return call === 1
        ? { tools: [remoteTool("alpha")] }
        : { tools: [remoteTool("alpha"), remoteTool("beta")] };
    });
    // Pre-populate the entry with the first listing (as connectServer would).
    await manager.refreshServerTools("srv");
    const seen: string[] = [];
    const unsubscribe = manager.onToolsChanged((server) => seen.push(server));

    const count = await manager.refreshServerTools("srv");
    expect(count).toBe(2);
    const tools = manager.getAllTools().filter((t) => t.name.startsWith("mcp__srv__"));
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp__srv__alpha", "mcp__srv__beta"]);
    expect(seen).toEqual(["srv"]);

    unsubscribe();
    await manager.refreshServerTools("srv");
    expect(seen).toEqual(["srv"]); // no more events after unsubscribe
  });

  it("a broken listener does not break the refresh for the others", async () => {
    const manager = managerWithServer(async () => ({ tools: [remoteTool("only")] }));
    const good = vi.fn();
    manager.onToolsChanged(() => {
      throw new Error("listener bug");
    });
    manager.onToolsChanged(good);
    const count = await manager.refreshServerTools("srv");
    expect(count).toBe(1);
    expect(good).toHaveBeenCalledWith("srv");
  });

  it("throws for a server that is not connected", async () => {
    const manager = new MCPManager();
    await expect(manager.refreshServerTools("ghost")).rejects.toThrow("not connected");
  });

  it("wrapped tools keep the mcp__<server>__<tool> naming and call routing", async () => {
    let listCalls = 0;
    let routedArgs: unknown = null;
    const manager = new MCPManager();
    (manager as unknown as { servers: Map<string, unknown> }).servers.set("echo", {
      config: { type: "http", url: "http://example.test" },
      client: {
        listTools: async () => {
          listCalls++;
          return { tools: [remoteTool("say")] };
        },
        callTool: async (req: unknown) => {
          routedArgs = req;
          return { content: [{ type: "text", text: "echoed" }] };
        },
      },
      transport: { close: () => undefined },
      tools: [],
    });
    await manager.refreshServerTools("echo");
    expect(listCalls).toBe(1);
    const tool = manager.getAllTools().find((t) => t.name === "mcp__echo__say");
    expect(tool).toBeTruthy();
    const result = await tool!.call({ word: "hi" }, {
      workspaceRoot: process.cwd(),
      sessionId: "s",
      permissionMode: "default",
    } as never);
    expect(result.content).toBe("echoed");
    expect(routedArgs).toMatchObject({ name: "say", arguments: { word: "hi" } });
  });
});
