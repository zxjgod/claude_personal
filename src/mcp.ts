// ============================================================
// MCP (Model Context Protocol) Integration
// ============================================================
// Connects to external MCP servers (stdio/http/sse), discovers
// their tools, and wraps them as native Tool objects for the
// agent loop. Uses the official @modelcontextprotocol/sdk.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { FileTokenOAuthProvider, type MCPOAuthConfig } from "./mcp-auth.js";
import type { Tool, ToolResult } from "./types.js";

// --- MCP Server Config ---

export type MCPTransportType = "stdio" | "http" | "sse" | "ws";

export interface MCPServerConfig {
  type: MCPTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** OAuth 2.0 settings for http/sse transports that require authorization. */
  oauth?: MCPOAuthConfig;
  disabled?: boolean;
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

// --- Server entry ---

interface ServerEntry {
  config: MCPServerConfig;
  client: Client;
  tools: Tool[];
}

// --- MCP Manager ---

export class MCPManager {
  private servers: Map<string, ServerEntry> = new Map();

  /**
   * Load MCP configuration from a JSON file
   */
  async loadConfig(configPath: string): Promise<void> {
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf-8");
    } catch (error: any) {
      if (error.code === "ENOENT") return; // Config file doesn't exist — fine
      console.error(
        `Error reading MCP config from ${configPath}:`,
        error.message,
      );
      return;
    }

    let config: MCPConfig;
    try {
      config = JSON.parse(raw);
    } catch (error: any) {
      console.error(
        `Error parsing MCP config from ${configPath}:`,
        error.message,
      );
      return;
    }

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (serverConfig.disabled) continue;
      await this.connectServer(name, serverConfig);
    }
  }

  /**
   * Connect to a single MCP server and discover its tools
   */
  async connectServer(
    name: string,
    config: MCPServerConfig,
  ): Promise<void> {
    // Don't double-connect
    if (this.servers.has(name)) {
      console.warn(`MCP server "${name}" is already connected.`);
      return;
    }

    let client: Client;

    try {
      // --- Create transport based on type ---
      if (config.type === "stdio") {
        if (!config.command) {
          console.error(
            `MCP server "${name}": stdio transport requires a "command"`,
          );
          return;
        }
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
        });
        client = new Client(
          { name: "claude-code-replica", version: "1.0.0" },
          { capabilities: {} as any },
        );
        await client.connect(transport);
      } else if (
        config.type === "http" ||
        config.type === "sse" ||
        config.type === "ws"
      ) {
        if (!config.url) {
          console.error(
            `MCP server "${name}": ${config.type} transport requires a "url"`,
          );
          return;
        }
        const url = new URL(config.url);
        client = new Client(
          { name: "claude-code-replica", version: "1.0.0" },
          { capabilities: {} as any },
        );

        // OAuth provider (11.2) — only meaningful for http/sse. The SDK drives
        // the flow: it tries the saved token, refreshes, or throws Unauthorized
        // (which we catch below to run the interactive code exchange once).
        const authProvider =
          config.oauth && (config.type === "http" || config.type === "sse")
            ? new FileTokenOAuthProvider(name, url, config.oauth)
            : undefined;

        const transport = this.createNetworkTransport(
          config.type,
          url,
          config.headers,
          authProvider,
        );

        try {
          await client.connect(transport);
        } catch (error: any) {
          // Unauthorized → run the one-shot interactive OAuth exchange, then
          // reconnect with a fresh transport carrying the new token.
          if (authProvider && this.isUnauthorized(error)) {
            console.log(
              `MCP server "${name}": authorization required — starting OAuth flow…`,
            );
            const code = await authProvider.runInteractiveAuthorization();
            const reTransport = this.createNetworkTransport(
              config.type as "http" | "sse",
              url,
              config.headers,
              authProvider,
            );
            // finishAuth exchanges the code for tokens on the transport.
            await (reTransport as any).finishAuth(code);
            await client.connect(reTransport);
          } else {
            throw error;
          }
        }
      } else {
        console.error(
          `MCP server "${name}": unknown transport type "${(config as any).type}"`,
        );
        return;
      }

      // --- Discover tools ---
      const toolsResult = await client.listTools();
      const mcpTools: Tool[] = toolsResult.tools.map(
        (remoteTool: any) => {
          // Build input schema, ensuring it's a valid JSON Schema object
          const rawSchema = remoteTool.inputSchema || {};
          const inputSchema: Tool["inputSchema"] = {
            type: "object",
            properties:
              rawSchema.properties &&
              typeof rawSchema.properties === "object"
                ? rawSchema.properties
                : {},
            required: Array.isArray(rawSchema.required)
              ? rawSchema.required
              : [],
          };

          const toolName = `mcp__${name}__${remoteTool.name}`;

          return {
            name: toolName,
            description: `MCP tool: ${remoteTool.name} (from ${name} server)`,
            promptDescription:
              remoteTool.description ||
              `MCP tool "${remoteTool.name}" from server "${name}"`,
            inputSchema,
            isEnabled: () => true,
            isReadOnly: () => false, // Conservative — assume destructive
            isConcurrencySafe: () => true, // Separate process, safe to run in parallel

            async call(input: Record<string, unknown>): Promise<ToolResult> {
              try {
                const result = await client.callTool({
                  name: remoteTool.name,
                  arguments: input,
                });

                // Extract text content from result
                const content = (result.content as any[])
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n");

                return { content: content || "(no text output)" };
              } catch (error: any) {
                return {
                  content: "",
                  error: `MCP tool error (${toolName}): ${error.message}`,
                };
              }
            },

            formatResult: (r: ToolResult) => {
              if (r.error) return `Error: ${r.error}`;
              return r.content;
            },

            checkPermissions: async () => ({ allowed: true }),
            // MCP tools auto-approved — user trusted the server
          } as Tool;
        },
      );

      this.servers.set(name, { config, client, tools: mcpTools });
      console.log(
        `MCP server "${name}" connected (${config.type}) — ${mcpTools.length} tool(s)`,
      );
    } catch (error: any) {
      console.error(
        `Failed to connect MCP server "${name}": ${error.message}`,
      );
      // Don't crash — MCP is optional
    }
  }

  /**
   * Build a network transport for the given type. http → StreamableHTTP
   * (current standard), sse → SSEClientTransport (legacy, still common),
   * ws → WebSocketClientTransport. OAuth providers attach to http/sse only.
   */
  private createNetworkTransport(
    type: "http" | "sse" | "ws",
    url: URL,
    headers?: Record<string, string>,
    authProvider?: FileTokenOAuthProvider,
  ): any {
    if (type === "ws") {
      // WebSocket transport takes no per-request headers/auth in the SDK.
      return new WebSocketClientTransport(url);
    }
    if (type === "sse") {
      return new SSEClientTransport(url, {
        authProvider,
        requestInit: headers ? { headers } : undefined,
      });
    }
    // http (streamable)
    return new StreamableHTTPClientTransport(url, {
      authProvider,
      requestInit: headers ? { headers } : undefined,
    });
  }

  /** Detect an OAuth "needs authorization" failure across SDK error shapes. */
  private isUnauthorized(error: any): boolean {
    if (!error) return false;
    const name = error.name || error.constructor?.name || "";
    if (name === "UnauthorizedError") return true;
    if (error.code === 401 || error.status === 401) return true;
    const msg = String(error.message || "").toLowerCase();
    return msg.includes("unauthorized") || msg.includes("401");
  }

  /**
   * Get all tools from connected MCP servers
   */
  getAllTools(): Tool[] {
    const allTools: Tool[] = [];
    for (const [, server] of this.servers) {
      allTools.push(...server.tools);
    }
    return allTools;
  }

  /**
   * List resources across all connected servers. Servers that don't support
   * resources (or error) are skipped. Returns flat entries tagged by server.
   */
  async listResources(): Promise<
    Array<{ server: string; uri: string; name?: string; mimeType?: string }>
  > {
    const out: Array<{ server: string; uri: string; name?: string; mimeType?: string }> = [];
    for (const [name, server] of this.servers) {
      try {
        const res: any = await server.client.listResources();
        for (const r of res.resources ?? []) {
          out.push({ server: name, uri: r.uri, name: r.name, mimeType: r.mimeType });
        }
      } catch {
        // Server doesn't expose resources — skip quietly.
      }
    }
    return out;
  }

  /**
   * Read a single resource by URI. Tries each server until one returns it.
   * Returns the concatenated text contents, or null if not found anywhere.
   */
  async readResource(uri: string): Promise<string | null> {
    for (const [, server] of this.servers) {
      try {
        const res: any = await server.client.readResource({ uri });
        const text = (res.contents ?? [])
          .map((c: any) => (typeof c.text === "string" ? c.text : ""))
          .filter(Boolean)
          .join("\n");
        if (text) return text;
        // Resource existed but had no text content (e.g. blob).
        if ((res.contents ?? []).length > 0) return "(non-text resource content)";
      } catch {
        // Not on this server — try the next.
      }
    }
    return null;
  }

  /**
   * Disconnect all MCP servers
   */
  async disconnectAll(): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        await server.client.close();
        console.log(`MCP server "${name}" disconnected.`);
      } catch (error: any) {
        console.error(
          `Error disconnecting MCP server "${name}": ${error.message}`,
        );
      }
    }
    this.servers.clear();
  }

  /**
   * Disconnect a single server by name
   */
  async disconnectServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    try {
      await server.client.close();
    } catch (error: any) {
      console.error(
        `Error disconnecting MCP server "${name}": ${error.message}`,
      );
    }
    this.servers.delete(name);
  }

  /**
   * Get the number of connected servers
   */
  get serverCount(): number {
    return this.servers.size;
  }
}

// --- Discover MCP Config Files ---

/**
 * Find all MCP configuration files from standard locations
 */
export function discoverMCPConfigs(workspaceRoot: string): string[] {
  const configs: string[] = [];

  // User-level config (~/.claude/mcp.json)
  const userConfig = path.join(os.homedir(), ".claude", "mcp.json");
  if (fs.existsSync(userConfig)) {
    configs.push(userConfig);
  }

  // Project-level config (<workspace>/.mcp.json)
  const projectConfig = path.join(workspaceRoot, ".mcp.json");
  if (fs.existsSync(projectConfig)) {
    configs.push(projectConfig);
  }

  return configs;
}
