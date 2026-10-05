// ============================================================
// Tests: Agent-scoped MCP servers (拍板 #14-B) — trust gate + lifecycle
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake the connection layer; keep the REAL fingerprint trust store (isolated
// to a temp file via CCR_TRUST_STORE_MCP per test).
const connectCalls: Array<[string, unknown]> = [];
let disconnectCount = 0;
let failOnConnect: string | undefined;

vi.mock("../mcp/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../mcp/index.js")>();
  class FakeMCPManager {
    async connectServer(name: string, cfg: unknown): Promise<void> {
      if (failOnConnect && name === failOnConnect) throw new Error("spawn EACCES");
      connectCalls.push([name, cfg]);
    }
    getAllTools() {
      return connectCalls.map(([name]) => ({
        name: `mcp__${name}__do`,
        description: "fake",
        inputSchema: { type: "object", properties: {} },
        call: async () => ({ content: "ok" }),
        formatResult: (r: { content: string }) => r.content,
      }));
    }
    async disconnectAll(): Promise<void> {
      disconnectCount++;
    }
  }
  return { ...orig, MCPManager: FakeMCPManager };
});

import { prepareAgentMcpServers } from "../agents/agent-mcp.js";
import type { SubagentType } from "../subagents.js";
import type { ToolContext } from "../types.js";

function agentWithMcp(): SubagentType {
  return {
    name: "mcp-agent",
    description: "agent with own servers",
    toolNames: [],
    systemPrompt: "sys",
    mcpServers: {
      files: { type: "stdio", command: "npx", args: ["-y", "@mcp/files"], env: { KEY: "v" } },
      web: { type: "http", url: "https://mcp.example.com/api", headers: { Authorization: "x" } },
    },
  };
}

let storeFile = "";
let ctx: ToolContext;

beforeEach(() => {
  connectCalls.length = 0;
  disconnectCount = 0;
  failOnConnect = undefined;
  storeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-")), "trust.json");
  process.env.CCR_TRUST_STORE_MCP = storeFile;
  ctx = {
    workspaceRoot: process.cwd(),
    sessionId: "agent-mcp-test",
    permissionMode: "default",
    modelConfig: { provider: "deepseek", model: "m", apiKey: "k" },
  };
});

afterEach(() => {
  delete process.env.CCR_TRUST_STORE_MCP;
});

describe("prepareAgentMcpServers (#14-B)", () => {
  it("returns 'none' when the agent declares no mcpServers", async () => {
    const agent = { ...agentWithMcp(), mcpServers: undefined };
    expect(await prepareAgentMcpServers(agent, ctx)).toEqual({ kind: "none" });
  });

  it("fail-closed without an approval channel (headless) — never connects", async () => {
    const r = await prepareAgentMcpServers(agentWithMcp(), ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain("headless");
    expect(connectCalls).toEqual([]);
  });

  it("user denial errors out and connects nothing", async () => {
    ctx.askUser = async () => false;
    const r = await prepareAgentMcpServers(agentWithMcp(), ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain("denied");
    expect(connectCalls).toEqual([]);
  });

  it("approval connects all servers, merges tools, persists one-time trust", async () => {
    let asked = 0;
    let riskHint = "";
    ctx.askUser = async (_t, _i, hint) => {
      asked++;
      riskHint = hint ?? "";
      return true;
    };
    const r = await prepareAgentMcpServers(agentWithMcp(), ctx);
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(connectCalls.map(([n]) => n)).toEqual(["files", "web"]);
    expect(r.handle.tools.map((t) => t.name)).toEqual(["mcp__files__do", "mcp__web__do"]);
    // The trust prompt must show the dangerous parts (T3 lesson).
    expect(riskHint).toContain("npx -y @mcp/files");
    expect(riskHint).toContain("https://mcp.example.com/api");
    expect(riskHint).toContain("KEY");
    expect(riskHint).toContain("Authorization");
    // close() disconnects, idempotently.
    await r.handle.close();
    await r.handle.close();
    expect(disconnectCount).toBe(1);
    // Trust persisted: a second run asks NOTHING.
    const r2 = await prepareAgentMcpServers(agentWithMcp(), ctx);
    expect(asked).toBe(1);
    expect(r2.kind).toBe("ready");
    if (r2.kind === "ready") await r2.handle.close();
  });

  it("editing the declarations re-prompts (fingerprint keyed on content)", async () => {
    ctx.askUser = async () => true;
    const r1 = await prepareAgentMcpServers(agentWithMcp(), ctx);
    if (r1.kind === "ready") await r1.handle.close();
    let askedAgain = 0;
    ctx.askUser = async () => {
      askedAgain++;
      return true;
    };
    const edited = agentWithMcp();
    edited.mcpServers = { ...edited.mcpServers, extra: { type: "http", url: "https://x.dev" } };
    const r2 = await prepareAgentMcpServers(edited, ctx);
    expect(askedAgain).toBe(1);
    if (r2.kind === "ready") await r2.handle.close();
  });

  it("connect failure cleans up partial connections and errors", async () => {
    ctx.askUser = async () => true;
    failOnConnect = "web";
    const r = await prepareAgentMcpServers(agentWithMcp(), ctx);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain("spawn EACCES");
    expect(disconnectCount).toBe(1);
  });
});
