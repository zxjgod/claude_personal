// ============================================================
// Integration tests: MCP multi-transport connection (M21.4)
// ============================================================
// Drives the real @modelcontextprotocol/sdk end-to-end against mock servers:
//   - stdio: a child-process server (fixtures/mock-mcp-stdio-server.mjs). Full
//     lifecycle — connect → discover tools/resources → wrap as native Tools →
//     round-trip a call → first-call approval gating → disconnect.
//   - http: an in-process StreamableHTTP MCP server on an ephemeral localhost
//     port (stateless + JSON responses), proving the http transport path.
//   - routing / failure: sse/ws/http config branches and graceful degradation
//     when a server is unreachable, disabled, or misconfigured (MCP is optional;
//     a bad server must never crash the agent).
//
// No network beyond loopback; the http server binds 127.0.0.1:0.
// ============================================================

import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "../mcp.js";
import { MCPManager } from "../mcp.js";
import type { ToolContext } from "../types.js";

const STDIO_FIXTURE = fileURLToPath(
  new URL("./fixtures/mock-mcp-stdio-server.mjs", import.meta.url),
);

const STDIO_CONFIG: MCPServerConfig = {
  type: "stdio",
  command: process.execPath, // node
  args: [STDIO_FIXTURE],
};

function ctx(mode: ToolContext["permissionMode"], askUser?: any): ToolContext {
  return { workspaceRoot: process.cwd(), sessionId: "mcp-int", permissionMode: mode, askUser };
}

// Silence the manager's connect/disconnect chatter (and intentional error logs
// in the failure suite) so the test output stays readable.
let logSpy: any;
let errSpy: any;
let warnSpy: any;
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

// ============================================================
// stdio transport — real child-process round-trip
// ============================================================

describe("MCP stdio transport (real child server)", () => {
  let mgr: MCPManager;

  beforeAll(async () => {
    mgr = new MCPManager();
    await mgr.connectServer("mock", STDIO_CONFIG);
  }, 30_000);

  afterAll(async () => {
    await mgr.disconnectAll();
  });

  it("connects and counts the server", () => {
    expect(mgr.serverCount).toBe(1);
  });

  it("discovers and namespaces the remote tools", () => {
    const names = mgr
      .getAllTools()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["mcp__mock__add", "mcp__mock__echo"]);
  });

  it("wraps tools with conservative, prompt-on-first-use semantics", () => {
    const echo = mgr.getAllTools().find((t) => t.name === "mcp__mock__echo")!;
    expect(echo.isReadOnly()).toBe(false); // assume destructive
    expect(echo.isConcurrencySafe()).toBe(true); // separate process
    expect(echo.requiresApproval?.()).toBe(true);
    expect(echo.isEnabled()).toBe(true);
    // The remote description survives onto the prompt-facing field.
    expect(echo.promptDescription).toContain("Echo back");
    expect(echo.inputSchema.properties).toHaveProperty("message");
  });

  it("round-trips a tool call through the SDK and returns text content", async () => {
    const echo = mgr.getAllTools().find((t) => t.name === "mcp__mock__echo")!;
    const r = await echo.call({ message: "hi there" }, ctx("bypassPermissions"));
    expect(r.error).toBeUndefined();
    expect(r.content).toBe("echo: hi there");
  });

  it("passes typed arguments through to the server", async () => {
    const add = mgr.getAllTools().find((t) => t.name === "mcp__mock__add")!;
    const r = await add.call({ a: 2, b: 5 }, ctx("bypassPermissions"));
    expect(r.content).toBe("7");
  });

  it("prompts on first call then is sticky for the session", async () => {
    const echo = mgr.getAllTools().find((t) => t.name === "mcp__mock__echo")!;
    let asks = 0;
    const askUser = async () => {
      asks++;
      return true;
    };
    const first = await echo.checkPermissions!({ message: "x" }, ctx("default", askUser));
    expect(first.allowed).toBe(true);
    expect(asks).toBe(1);
    // Second call to the same tool does not prompt again.
    const second = await echo.checkPermissions!({ message: "y" }, ctx("default", askUser));
    expect(second.allowed).toBe(true);
    expect(asks).toBe(1);
  });

  it("denies when the user rejects the first call (add, not yet confirmed)", async () => {
    const add = mgr.getAllTools().find((t) => t.name === "mcp__mock__add")!;
    const r = await add.checkPermissions!(
      { a: 1, b: 1 },
      ctx("default", async () => false),
    );
    expect(r.allowed).toBe(false);
  });

  it("lists resources tagged by server name", async () => {
    const resources = await mgr.listResources();
    const greeting = resources.find((r) => r.uri === "mock://greeting");
    expect(greeting).toBeDefined();
    expect(greeting!.server).toBe("mock");
    expect(greeting!.name).toBe("greeting");
  });

  it("reads a resource's text content by URI", async () => {
    const text = await mgr.readResource("mock://greeting");
    expect(text).toBe("hello from mock resource");
  });

  it("returns null for an unknown resource URI", async () => {
    expect(await mgr.readResource("mock://does-not-exist")).toBeNull();
  });

  it("warns and does not double-connect the same server name", async () => {
    await mgr.connectServer("mock", STDIO_CONFIG);
    expect(mgr.serverCount).toBe(1); // unchanged
  });

  it("disconnects a single server by name", async () => {
    const solo = new MCPManager();
    await solo.connectServer("mock2", STDIO_CONFIG);
    expect(solo.serverCount).toBe(1);
    await solo.disconnectServer("mock2");
    expect(solo.serverCount).toBe(0);
  }, 30_000);
});

// ============================================================
// http transport — in-process StreamableHTTP mock server
// ============================================================

/** Build a fresh low-level MCP server exposing one `ping` tool. */
function buildHttpMcpServer(): Server {
  const server = new Server(
    { name: "mock-http", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ping",
        description: "Return pong",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  return server;
}

/** Start a stateless StreamableHTTP MCP server on an ephemeral loopback port. */
async function startHttpMcp(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer(async (req, res) => {
    // Stateless pattern: a fresh server + transport per request.
    const server = buildHttpMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}

describe("MCP http transport (in-process mock server)", () => {
  let srv: { url: string; close: () => Promise<void> };
  let mgr: MCPManager;

  beforeAll(async () => {
    srv = await startHttpMcp();
    mgr = new MCPManager();
    await mgr.connectServer("web", { type: "http", url: srv.url });
  }, 30_000);

  afterAll(async () => {
    await mgr.disconnectAll();
    await srv.close();
  });

  it("connects over http and discovers the tool", () => {
    expect(mgr.serverCount).toBe(1);
    expect(mgr.getAllTools().map((t) => t.name)).toEqual(["mcp__web__ping"]);
  });

  it("round-trips a call over http", async () => {
    const ping = mgr.getAllTools().find((t) => t.name === "mcp__web__ping")!;
    const r = await ping.call({}, ctx("bypassPermissions"));
    expect(r.content).toBe("pong");
  });
});

// ============================================================
// transport routing + graceful degradation
// ============================================================

describe("MCP transport routing + failure handling", () => {
  it("skips a disabled server in loadConfig (writes a config file)", async () => {
    const mgr = new MCPManager();
    // loadConfig over a non-existent path is a no-op; build config inline instead
    // by connecting directly — disabled servers are filtered in loadConfig, so
    // we assert the filter via a temp config file.
    const tmp = fileURLToPath(new URL("./fixtures/disabled.mcp.json", import.meta.url));
    const fs = await import("node:fs");
    fs.writeFileSync(
      tmp,
      JSON.stringify({ mcpServers: { off: { type: "stdio", command: "node", disabled: true } } }),
    );
    try {
      await mgr.loadConfig(tmp);
      expect(mgr.serverCount).toBe(0);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("loadConfig on a missing file is a silent no-op", async () => {
    const mgr = new MCPManager();
    await expect(mgr.loadConfig("/no/such/mcp.json")).resolves.toBeUndefined();
    expect(mgr.serverCount).toBe(0);
  });

  it("loadConfig tolerates malformed JSON without throwing", async () => {
    const tmp = fileURLToPath(new URL("./fixtures/bad.mcp.json", import.meta.url));
    const fs = await import("node:fs");
    fs.writeFileSync(tmp, "{ not valid json");
    try {
      await expect(new MCPManager().loadConfig(tmp)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("stdio config without a command is rejected gracefully", async () => {
    const mgr = new MCPManager();
    await mgr.connectServer("nocmd", { type: "stdio" });
    expect(mgr.serverCount).toBe(0);
  });

  it("http/sse config without a url is rejected gracefully", async () => {
    const mgr = new MCPManager();
    await mgr.connectServer("nourl-http", { type: "http" });
    await mgr.connectServer("nourl-sse", { type: "sse" });
    expect(mgr.serverCount).toBe(0);
  });

  it("an unknown transport type is rejected gracefully", async () => {
    const mgr = new MCPManager();
    await mgr.connectServer("weird", { type: "carrier-pigeon" } as any);
    expect(mgr.serverCount).toBe(0);
  });

  it("a refused http endpoint degrades to zero servers, no throw", async () => {
    const mgr = new MCPManager();
    // Port 1 on loopback refuses immediately (ECONNREFUSED), no 30s hang.
    await expect(
      mgr.connectServer("dead-http", { type: "http", url: "http://127.0.0.1:1/mcp" }),
    ).resolves.toBeUndefined();
    expect(mgr.serverCount).toBe(0);
  }, 35_000);

  it("a refused ws endpoint degrades to zero servers, no throw", async () => {
    const mgr = new MCPManager();
    await expect(
      mgr.connectServer("dead-ws", { type: "ws", url: "ws://127.0.0.1:1/mcp" }),
    ).resolves.toBeUndefined();
    expect(mgr.serverCount).toBe(0);
  }, 35_000);

  it("getAllTools is empty before any connection", () => {
    expect(new MCPManager().getAllTools()).toEqual([]);
  });
});
