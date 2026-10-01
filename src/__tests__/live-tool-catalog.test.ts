import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupTools } from "../cli-tools.js";
import { toolsCommand } from "../commands/tools.js";
import { createTool } from "../tools/registry.js";
import type { Tool } from "../types.js";

const live = vi.hoisted(() => ({
  tools: [] as Tool[],
  changed: undefined as (() => void) | undefined,
}));
vi.mock("../mcp/index.js", () => ({
  discoverMCPConfigs: () => [],
  MCPManager: class {
    serverCount = 0;
    getAllTools() {
      return live.tools;
    }
    onToolsChanged(listener: () => void) {
      live.changed = listener;
    }
  },
}));
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tool(name: string) {
  return createTool({
    name,
    description: name,
    promptDescription: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    isReadOnly: true,
    call: async () => ({ content: "ok" }),
  });
}

describe("live MCP catalog", () => {
  it("keeps execution and /tools in sync through a real setupTools refresh", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-catalog-"));
    dirs.push(root);
    live.tools = [tool("mcp__catalog__old")];
    const setup = await setupTools({ workspaceRoot: root, verbose: false });
    live.tools = [tool("mcp__catalog__new")];
    live.changed?.();
    expect(setup.tools.some((t) => t.name === "mcp__catalog__new")).toBe(true);
    expect(setup.tools.some((t) => t.name === "mcp__catalog__old")).toBe(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await toolsCommand.run("", {
      workspaceRoot: root,
      sessionId: "catalog",
      messages: [],
      tools: setup.toolSources,
      modelConfig: { provider: "custom", model: "test", apiKey: "unused" },
      callModel: async function* () {},
    });
    const rendered = log.mock.calls.flat().join("\n");
    expect(rendered).toContain("mcp__catalog__new");
    expect(rendered).not.toContain("mcp__catalog__old");
  });
});
