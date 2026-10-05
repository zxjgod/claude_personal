// ============================================================
// Tests: MCP cross-server tool name collision warning
// ============================================================
// getAllTools() dedupes by wrapped name (first server wins) because a
// duplicate would make registry.register() throw. A dropped duplicate used
// to vanish silently — the loser's tool was unreachable AND the model could
// unknowingly call the OTHER server's same-named tool. The warning must fire
// exactly once per colliding name (getAllTools is called on every refresh).
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPManager } from "../mcp/index.js";
import type { Tool } from "../types.js";

function fakeTool(name: string): Tool {
  return { name, description: `tool ${name}` } as unknown as Tool;
}

function managerWithTools(entries: Array<[string, Tool[]]>): MCPManager {
  const manager = new MCPManager();
  const servers = (manager as unknown as { servers: Map<string, unknown> }).servers;
  for (const [name, tools] of entries) {
    servers.set(name, {
      config: { type: "http", url: "http://example.test" },
      client: null,
      transport: { close: () => undefined },
      tools,
    });
  }
  return manager;
}

describe("MCPManager.getAllTools collision warning", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the first server's tool and warns once per colliding name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = managerWithTools([
      ["alpha", [fakeTool("mcp__x__y__dup"), fakeTool("mcp__alpha__only")]],
      ["beta", [fakeTool("mcp__x__y__dup")]],
    ]);

    const tools = manager.getAllTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp__alpha__only", "mcp__x__y__dup"]);
    // First server wins.
    expect(tools.find((t) => t.name === "mcp__x__y__dup")?.description).toBe("tool mcp__x__y__dup");

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain("MCP tool name collision");
    expect(message).toContain("mcp__x__y__dup");
    expect(message).toContain("alpha");
    expect(message).toContain("beta");

    // Called on every refresh — must not warn again for the same name.
    manager.getAllTools();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn when names are unique", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = managerWithTools([
      ["a", [fakeTool("mcp__a__one")]],
      ["b", [fakeTool("mcp__b__two")]],
    ]);
    expect(manager.getAllTools()).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
