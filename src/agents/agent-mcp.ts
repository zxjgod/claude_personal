// ============================================================
// Agent-scoped MCP servers — 拍板 #14-B (official 2.1.202 parity)
// ============================================================
// Official lets an agent frontmatter declare `mcpServers: {...}` — the agent
// spawns its OWN MCP connections (scope: agent), independent from the main
// session's pool, closed when the agent finishes. That is a trust-boundary
// expansion: a repo's .claude/agents/*.md can declare arbitrary stdio commands
// / remote URLs, so the declarations pass the SAME one-time fingerprint trust
// gate as project .claude/mcp.json (inline confirmation showing command/url,
// env keys and header keys — the T3 lesson: never hide the dangerous parts).
//
// Lifecycle per sub-agent run:
//   prepareAgentMcpServers(type, context)  → trust gate → connect → tools
//   ... sub-agent loop runs with the extra tools ...
//   handle.close()                          → disconnectAll (try/finally)
// ============================================================

import {
  isMcpConfigTrusted,
  MCPManager,
  type MCPServerConfig,
  trustMcpConfig,
} from "../mcp/index.js";
import type { SubagentType } from "../subagents.js";
import type { Tool, ToolContext } from "../types.js";

export interface AgentMcpHandle {
  /** Tools contributed by the agent-declared servers (mcp__ns__name). */
  tools: Tool[];
  /** Disconnect every agent-scoped server. Idempotent. */
  close(): Promise<void>;
}

export type AgentMcpPrepare =
  | { kind: "none" } // no mcpServers declared
  | { kind: "ready"; handle: AgentMcpHandle }
  | { kind: "error"; error: string };

/** One-line, danger-visible description of a declared server (trust prompt). */
function describeServer(name: string, cfg: MCPServerConfig): string {
  const parts: string[] = [`"${name}" (${cfg.type})`];
  if (cfg.command) parts.push(`command: ${cfg.command} ${(cfg.args ?? []).join(" ")}`.trim());
  if (cfg.url) parts.push(`url: ${cfg.url}`);
  if (cfg.env && Object.keys(cfg.env).length > 0)
    parts.push(`env keys: ${Object.keys(cfg.env).join(", ")}`);
  if (cfg.headers && Object.keys(cfg.headers).length > 0)
    parts.push(`header keys: ${Object.keys(cfg.headers).join(", ")}`);
  return parts.join(" · ");
}

/**
 * Trust-gate and connect the agent's declared MCP servers.
 *
 * Fail-closed: without an interactive `askUser` (headless, tests), an
 * untrusted declaration is an ERROR, never a silent connect. A trust approval
 * is persisted per (agent, declarations-fingerprint) — editing the frontmatter
 * re-prompts.
 */
export async function prepareAgentMcpServers(
  type: SubagentType,
  context: ToolContext,
): Promise<AgentMcpPrepare> {
  const servers = type.mcpServers;
  if (!servers || Object.keys(servers).length === 0) return { kind: "none" };

  const trustKey = `agent-mcp:${type.name}`;
  const raw = JSON.stringify(servers);
  if (!isMcpConfigTrusted(trustKey, raw)) {
    if (!context.askUser) {
      return {
        kind: "error",
        error:
          `Sub-agent "${type.name}" declares agent-scoped MCP servers ` +
          `(${Object.keys(servers).join(", ")}) but no approval channel is available ` +
          `(headless). Refusing to connect — approve interactively once, or remove ` +
          `the mcpServers frontmatter.`,
      };
    }
    const lines = Object.entries(servers).map(([name, cfg]) => `  - ${describeServer(name, cfg)}`);
    const approved = await context.askUser(
      { name: "mcp" } as unknown as Tool,
      { server: `agent:${type.name}` },
      `Sub-agent "${type.name}" wants to spawn its OWN MCP servers (agent scope, ` +
        `independent connections — they can execute local commands / reach remote URLs):\n` +
        `${lines.join("\n")}\nTrust these declarations? (one-time per declaration content)`,
    );
    if (!approved) {
      return {
        kind: "error",
        error: `Agent-scoped MCP servers for "${type.name}" denied by the user.`,
      };
    }
    trustMcpConfig(trustKey, raw);
  }

  const manager = new MCPManager();
  try {
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg.disabled) continue;
      // Agent-scoped namespace keeps tool names distinct from session servers:
      // mcp__<agent>-<server>__<tool> would be long — instead the manager
      // namespaces per server name already (mcp__<server>__<tool>).
      await manager.connectServer(name, cfg);
    }
  } catch (err) {
    await manager.disconnectAll().catch(() => {});
    return {
      kind: "error",
      error:
        `Failed to connect agent-scoped MCP servers for "${type.name}": ` +
        (err instanceof Error ? err.message : String(err)),
    };
  }
  let closed = false;
  return {
    kind: "ready",
    handle: {
      tools: manager.getAllTools(),
      close: async () => {
        if (closed) return;
        closed = true;
        await manager.disconnectAll().catch(() => {});
      },
    },
  };
}
