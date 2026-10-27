// /mcp must render the manager's actual server entries, not reconstruct them
// by splitting wrapped tool names.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpCommand } from "../commands/mcp.js";
import type { CommandContext } from "../commands/types.js";
import { MCPManager } from "../mcp/index.js";
import type { Tool } from "../types.js";

function fakeTool(name: string): Tool {
  return { name, description: name } as unknown as Tool;
}

function managerWithServers(entries: Array<[string, Tool[]]>): MCPManager {
  const manager = new MCPManager();
  const servers = (manager as unknown as { servers: Map<string, unknown> }).servers;
  for (const [name, tools] of entries) {
    servers.set(name, {
      config: { type: "http", url: "https://example.test" },
      client: null,
      transport: undefined,
      tools,
      refreshGeneration: 0,
    });
  }
  return manager;
}

function context(mcpManager: MCPManager): CommandContext {
  return {
    messages: [],
    modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "test" },
    callModel: async function* () {},
    workspaceRoot: "/workspace",
    sessionId: "mcp-command",
    systemPrompt: "system",
    mcpManager,
  };
}

let output: string[];

describe("/mcp server entries", () => {
  beforeEach(() => {
    output = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps servers with zero tools in the listing", async () => {
    const manager = managerWithServers([["empty__server", []]]);

    await mcpCommand.run("", context(manager));

    const text = output.join("\n");
    expect(text).toContain("MCP (1 server)");
    expect(text).toContain("empty__server");
    expect(text).toContain("0 tool(s)");
  });

  it("preserves __ in server names and prints tool names without splitting them", async () => {
    const manager = managerWithServers([["team__alpha", [fakeTool("mcp__team__alpha__do__work")]]]);

    await mcpCommand.run("", context(manager));

    const text = output.join("\n");
    expect(text).toContain("team__alpha");
    expect(text).toContain("- mcp__team__alpha__do__work");
  });

  it("counts and lists only tools exposed after wrapped-name deduplication", async () => {
    const manager = managerWithServers([
      ["a", [fakeTool("mcp__a__b__c")]],
      ["a__b", [fakeTool("mcp__a__b__c")]],
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await mcpCommand.run("", context(manager));

    const text = output.join("\n");
    expect(text).toContain("Servers: 2   Tools: 1");
    expect(text).toContain("a — 1 tool(s)");
    expect(text).toContain("a__b — 0 tool(s)");
  });
});
