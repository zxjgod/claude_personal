// Regression tests for project MCP trust confirmation rendering.
// These cases deny trust so no server is connected or spawned.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCPManager } from "../mcp/index.js";

async function trustDescriptions(servers: Record<string, unknown>): Promise<string[]> {
  const manager = new MCPManager();
  const confirm = vi.fn(async (_descriptions: string[]) => false);
  await manager.loadConfig(JSON.stringify({ mcpServers: servers }), {
    requireTrust: true,
    confirm,
  });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(manager.serverCount).toBe(0);
  return confirm.mock.calls[0][0];
}

describe("MCP project trust prompt", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows command and args for a stdio server whose type is omitted", async () => {
    const descriptions = await trustDescriptions({
      local: { command: "node", args: ["server.mjs", "--verbose"] },
    });

    expect(descriptions).toEqual(["local (stdio): node server.mjs --verbose"]);
  });

  it("renders malformed args without throwing before the trust decision", async () => {
    const descriptions = await trustDescriptions({
      local: { command: "node", args: { unexpected: true } },
    });

    expect(descriptions).toEqual(["local (stdio): node <invalid args>"]);
  });

  it("normalizes inline stdio config before validating its arguments", async () => {
    const manager = new MCPManager();

    await expect(
      manager.connectServer("bad", { command: "node", args: "not-an-array" } as never),
    ).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      'MCP server "bad": stdio "args" must be an array of strings',
    );
  });

  it("renders non-string env values as unexpanded placeholders without throwing", async () => {
    const descriptions = await trustDescriptions({
      local: {
        type: "stdio",
        command: "node",
        env: { COUNT: 3, ENABLED: false, TOKEN: "${MCP_TEST_TOKEN}" },
      },
    });

    expect(descriptions).toEqual([
      "local (stdio): node [env: COUNT=<set>, ENABLED=<set>, TOKEN=${MCP_TEST_TOKEN}]",
    ]);
  });

  it("renders non-string header values as unexpanded placeholders without throwing", async () => {
    const descriptions = await trustDescriptions({
      remote: {
        type: "http",
        url: "https://example.test/mcp",
        headers: { "X-Retries": 2, Authorization: "Bearer ${MCP_TEST_TOKEN}" },
      },
    });

    expect(descriptions).toEqual([
      "remote (http): https://example.test/mcp [headers: X-Retries=<set>, Authorization=Bearer ${MCP_TEST_TOKEN}]",
    ]);
  });
});
