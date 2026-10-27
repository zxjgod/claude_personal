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
    refreshGeneration: 0,
  });
  return manager;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
      refreshGeneration: 0,
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

  it("ignores an older refresh that resolves after a newer refresh", async () => {
    const older = deferred<{ tools: ReturnType<typeof remoteTool>[] }>();
    const newer = deferred<{ tools: ReturnType<typeof remoteTool>[] }>();
    let call = 0;
    const manager = managerWithServer(() => {
      call += 1;
      return call === 1 ? older.promise : newer.promise;
    });
    const changed = vi.fn();
    manager.onToolsChanged(changed);

    const olderRefresh = manager.refreshServerTools("srv");
    const newerRefresh = manager.refreshServerTools("srv");
    newer.resolve({ tools: [remoteTool("current")] });
    await expect(newerRefresh).resolves.toBe(1);
    older.resolve({ tools: [remoteTool("stale"), remoteTool("outdated")] });
    await expect(olderRefresh).resolves.toBe(1);

    expect(manager.getAllTools().map((tool) => tool.name)).toEqual(["mcp__srv__current"]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("ignores an older refresh failure after a newer refresh succeeds", async () => {
    const older = deferred<{ tools: ReturnType<typeof remoteTool>[] }>();
    const newer = deferred<{ tools: ReturnType<typeof remoteTool>[] }>();
    let call = 0;
    const manager = managerWithServer(() => {
      call += 1;
      return call === 1 ? older.promise : newer.promise;
    });

    const olderRefresh = manager.refreshServerTools("srv");
    const newerRefresh = manager.refreshServerTools("srv");
    newer.resolve({ tools: [remoteTool("current")] });
    await expect(newerRefresh).resolves.toBe(1);
    older.reject(new Error("stale refresh failure"));
    await expect(olderRefresh).resolves.toBe(1);

    expect(manager.getAllTools().map((tool) => tool.name)).toEqual(["mcp__srv__current"]);
  });

  it("ignores a response from a replaced server instance", async () => {
    const staleResponse = deferred<{ tools: ReturnType<typeof remoteTool>[] }>();
    const manager = managerWithServer(() => staleResponse.promise);
    const staleRefresh = manager.refreshServerTools("srv");
    const servers = (manager as unknown as { servers: Map<string, unknown> }).servers;
    servers.set("srv", {
      config: { type: "http", url: "http://example.test" },
      client: {
        listTools: async () => ({ tools: [remoteTool("shared", "current definition")] }),
      },
      transport: { close: () => undefined },
      tools: [],
      refreshGeneration: 0,
    });
    const changed = vi.fn();
    manager.onToolsChanged(changed);
    await manager.refreshServerTools("srv");
    changed.mockClear();

    staleResponse.resolve({
      tools: [remoteTool("shared", "stale definition"), remoteTool("outdated")],
    });
    await expect(staleRefresh).resolves.toBe(1);

    const tools = manager.getAllTools();
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__srv__shared"]);
    expect(tools[0].promptDescription).toBe("current definition");
    expect(changed).not.toHaveBeenCalled();
    const approve = vi.fn(async () => true);
    const checkPermissions = tools[0].checkPermissions;
    if (!checkPermissions) throw new Error("current tool lost its permission hook");
    const decision = await checkPermissions({}, {
      workspaceRoot: process.cwd(),
      sessionId: "s",
      permissionMode: "default",
      askUser: approve,
    } as never);
    expect(decision.allowed).toBe(true);
  });
});

describe("MCPManager.disconnectServer", () => {
  it("does not let an old connection remove its same-name replacement", async () => {
    const closing = deferred<void>();
    const manager = new MCPManager();
    const servers = (manager as unknown as { servers: Map<string, unknown> }).servers;
    const original = {
      config: { type: "http", url: "http://old.example.test" },
      client: { close: () => closing.promise },
      transport: undefined,
      tools: [],
      refreshGeneration: 0,
    };
    servers.set("srv", original);

    const disconnect = manager.disconnectServer("srv");
    const replacement = {
      config: { type: "http", url: "http://new.example.test" },
      client: { close: async () => {} },
      transport: undefined,
      tools: [],
      refreshGeneration: 0,
    };
    servers.set("srv", replacement);
    closing.resolve();
    await disconnect;

    expect(servers.get("srv")).toBe(replacement);
  });
});
