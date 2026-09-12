// ============================================================
// MCP (Model Context Protocol) Integration
// ============================================================
// Connects to external MCP servers (stdio/http/sse), discovers
// their tools, and wraps them as native Tool objects for the
// agent loop. Uses the official @modelcontextprotocol/sdk.
// ============================================================

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import {
  type CallToolResult,
  ElicitRequestSchema,
  type TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { pluginDirs } from "../plugins.js";
import type { PermissionResult, Tool, ToolContext, ToolResult } from "../types.js";
import { ccrPath } from "../workspace-config.js";
import { FileTokenOAuthProvider, type MCPOAuthConfig } from "./auth.js";

// --- Timeout helper ---
//
// MCP servers are external processes/services that can hang indefinitely (a
// crashed stdio child, an unresponsive HTTP server, a network partition).
// Without a timeout, `client.connect` / `listTools` / `callTool` would pin the
// agent loop forever. This races the operation against a timer and rejects
// with a TimeoutError so the caller can surface a tool error instead of
// hanging. The original promise is left to settle on its own (the SDK has no
// generic cancel); for stdio servers the child is reaped on disconnect.

export class TimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`MCP ${operation} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(
  operation: string,
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(operation, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Expand `${ENV_VAR}` placeholders in a string using process.env.
 *
 * Mirrors Claude Code's MCP config behavior: `.mcp.json` may reference
 * secrets (e.g. `"Authorization": "Bearer ${GITHUB_TOKEN}"`) without baking
 * them into the repo. Undefined variables expand to "" rather than leaking a
 * literal `${...}` (which would be sent verbatim as a header value).
 */
export function expandEnvTemplate(value: string): string {
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}

/** Expand `${VAR}` in every key and value of a record (headers / env). */
export function expandEnvRecord(
  record?: Record<string, string>,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    out[expandEnvTemplate(key)] = expandEnvTemplate(val);
  }
  return out;
}

// Conservative per-operation ceilings. A well-behaved MCP server should
// respond far faster; these bound the worst case so a hung server degrades
// to an error rather than freezing the session.
const CONNECT_TIMEOUT_MS = 30_000;
const LIST_TOOLS_TIMEOUT_MS = 20_000;
const CALL_TOOL_TIMEOUT_MS = 60_000;
const RESOURCE_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 5_000;

interface McpTransport {
  close?: () => Promise<void> | void;
}

async function closeMcpConnection(
  label: string,
  client?: Client,
  transport?: McpTransport,
): Promise<void> {
  try {
    if (client) {
      await withTimeout(
        `${label}.client`,
        Promise.resolve().then(() => client.close()),
        CLOSE_TIMEOUT_MS,
      );
    }
  } catch {
    // Transport cleanup below is the hard stop if graceful close hangs.
  }
  try {
    if (transport?.close) {
      await withTimeout(
        `${label}.transport`,
        Promise.resolve().then(() => transport.close!()),
        CLOSE_TIMEOUT_MS,
      );
    }
  } catch {
    // Best-effort teardown must never pin CLI shutdown.
  }
}

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

export interface MCPLoadOptions {
  /** Require explicit approval before connecting servers from a project file. */
  requireTrust?: boolean;
  confirm?: (descriptions: string[]) => Promise<boolean>;
}

const SAFE_STDIO_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "ComSpec",
]);

/** Keep ambient credentials out of project-controlled MCP child processes. */
export function buildStdioEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_STDIO_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...(expandEnvRecord(overrides) ?? {}) };
}

// --- Project-MCP trust gate ------------------------------------------------
// A project `.mcp.json` can spawn arbitrary stdio commands (and reach http
// endpoints) — loading it unconditionally would make "clone a malicious repo
// and run the assistant" a supply-chain exploit. Servers from a project config
// are therefore trusted ONCE per (config-path, config-content) pair, keyed on a
// fingerprint of the raw file so any edit re-prompts. Trust is persisted to the
// same directory as the hooks trust store, in a separate file.

function mcpTrustStorePath(): string {
  return (
    process.env.CCR_TRUST_STORE_MCP ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".claude-code-replica",
      "trusted-mcp.json",
    )
  );
}

function mcpConfigFingerprint(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function isMcpConfigTrusted(configPath: string, raw: string): boolean {
  try {
    const store = JSON.parse(fs.readFileSync(mcpTrustStorePath(), "utf-8")) as Record<
      string,
      string
    >;
    return store[path.resolve(configPath)] === mcpConfigFingerprint(raw);
  } catch {
    return false;
  }
}

function trustMcpConfig(configPath: string, raw: string): void {
  try {
    const file = mcpTrustStorePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let store: Record<string, string> = {};
    try {
      store = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>;
    } catch {
      // Missing or corrupt store — start fresh.
    }
    store[path.resolve(configPath)] = mcpConfigFingerprint(raw);
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
  } catch {
    // Trust persistence is best-effort; failing to save just re-prompts next time.
  }
}

// --- Server entry ---

interface ServerEntry {
  config: MCPServerConfig;
  client: Client;
  transport?: McpTransport;
  tools: Tool[];
}

// --- MCP Manager ---

export class MCPManager {
  private servers: Map<string, ServerEntry> = new Map();
  /**
   * 16.10: MCP tools whose first call the user already confirmed this session.
   * Keyed by the synthetic tool name `mcp__<server>__<tool>`. Subsequent calls
   * skip the prompt so a trusted tool doesn't nag every turn.
   */
  private confirmedMcpTools: Set<string> = new Set();
  private elicitationHandler: ElicitationHandler | null = null;

  setElicitationHandler(handler: typeof this.elicitationHandler): void {
    this.elicitationHandler = handler;
  }

  /**
   * Load MCP configuration from a JSON file
   */
  async loadConfig(configPath: string, options: MCPLoadOptions = {}): Promise<void> {
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf-8");
    } catch (error) {
      // Config file doesn't exist — fine
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      console.error(
        `Error reading MCP config from ${configPath}:`,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    let config: MCPConfig;
    try {
      config = JSON.parse(raw);
    } catch (error) {
      console.error(
        `Error parsing MCP config from ${configPath}:`,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    if (options.requireTrust) {
      const enabled = Object.entries(config.mcpServers).filter(([, server]) => !server.disabled);
      // Only prompt when this exact config content has not been trusted before.
      // Once trusted, subsequent launches load it silently; an edited config
      // changes the fingerprint and re-prompts.
      if (enabled.length > 0 && !isMcpConfigTrusted(configPath, raw)) {
        const descriptions = enabled.map(([name, server]) => {
          const target =
            server.type === "stdio"
              ? [server.command, ...(server.args ?? [])].join(" ")
              : server.url;
          return `${name} (${server.type}): ${target ?? "configured server"}`;
        });
        const trusted = options.confirm ? await options.confirm(descriptions) : false;
        if (!trusted) {
          console.error(
            `MCP project config not trusted; skipped ${descriptions.length} server(s).`,
          );
          return;
        }
        trustMcpConfig(configPath, raw);
      }
    }

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (serverConfig.disabled) continue;
      await this.connectServer(name, serverConfig);
    }
  }

  /**
   * Connect to a single MCP server and discover its tools
   */
  async connectServer(name: string, config: MCPServerConfig): Promise<void> {
    // Don't double-connect
    if (this.servers.has(name)) {
      console.warn(`MCP server "${name}" is already connected.`);
      return;
    }

    let client: Client | undefined;
    let activeTransport: McpTransport | undefined;

    try {
      // --- Create transport based on type ---
      if (config.type === "stdio") {
        if (!config.command) {
          console.error(`MCP server "${name}": stdio transport requires a "command"`);
          return;
        }
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: buildStdioEnv(config.env),
        });
        activeTransport = transport;
        client = new Client(
          { name: "claude-code-replica", version: "1.0.0" },
          { capabilities: { elicitation: {} } },
        );
        client.setRequestHandler(ElicitRequestSchema, async (request) =>
          this.handleElicitation(request.params),
        );
        await withTimeout("connect(stdio)", client.connect(transport), CONNECT_TIMEOUT_MS);
      } else if (config.type === "http" || config.type === "sse" || config.type === "ws") {
        if (!config.url) {
          console.error(`MCP server "${name}": ${config.type} transport requires a "url"`);
          return;
        }
        const url = new URL(config.url);
        client = new Client(
          { name: "claude-code-replica", version: "1.0.0" },
          { capabilities: { elicitation: {} } },
        );
        client.setRequestHandler(ElicitRequestSchema, async (request) =>
          this.handleElicitation(request.params),
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
          expandEnvRecord(config.headers),
          authProvider,
        );
        activeTransport = transport;

        try {
          await withTimeout("connect(network)", client.connect(transport), CONNECT_TIMEOUT_MS);
        } catch (error) {
          // Unauthorized → run the one-shot interactive OAuth exchange, then
          // reconnect with a fresh transport carrying the new token.
          if (authProvider && this.isUnauthorized(error)) {
            console.log(`MCP server "${name}": authorization required — starting OAuth flow…`);
            const code = await authProvider.runInteractiveAuthorization();
            const reTransport = this.createNetworkTransport(
              config.type as "http" | "sse",
              url,
              expandEnvRecord(config.headers),
              authProvider,
            );
            await closeMcpConnection(`connect(${name}:unauthorized)`, client, activeTransport);
            activeTransport = reTransport;
            // finishAuth exchanges the code for tokens on the transport.
            // Only http/sse transports reach this branch (authProvider is set
            // for those types only), and both expose finishAuth.
            await (reTransport as StreamableHTTPClientTransport | SSEClientTransport).finishAuth(
              code,
            );
            await withTimeout(
              "connect(network:reauth)",
              client.connect(reTransport),
              CONNECT_TIMEOUT_MS,
            );
          } else {
            throw error;
          }
        }
      } else {
        console.error(`MCP server "${name}": unknown transport type "${config.type}"`);
        return;
      }

      // --- Discover tools ---
      if (!client) throw new Error("MCP client was not initialized");
      const connectedClient = client;
      const manager = this;
      const toolsResult = await withTimeout("listTools", client.listTools(), LIST_TOOLS_TIMEOUT_MS);
      const mcpTools: Tool[] = toolsResult.tools
        .map((remoteTool) => {
          // P1-4: Build input schema with type-safe validation to prevent
          // malicious schema injection. Reject non-object properties.
          const rawSchema = remoteTool.inputSchema || {};
          const rawProperties = rawSchema.properties;

          // Validate properties is a plain object (not an array, function, etc.)
          if (
            rawProperties !== null &&
            (typeof rawProperties !== "object" || Array.isArray(rawProperties))
          ) {
            console.warn(`MCP tool "${remoteTool.name}": invalid schema.properties type, skipping`);
            return null;
          }

          const inputSchema: Tool["inputSchema"] = {
            type: "object",
            properties: (rawProperties ?? {}) as Tool["inputSchema"]["properties"],
            required: Array.isArray(rawSchema.required) ? rawSchema.required : [],
          };

          const toolName = `mcp__${name}__${remoteTool.name}`;

          return {
            name: toolName,
            description: `MCP tool: ${remoteTool.name} (from ${name} server)`,
            promptDescription:
              remoteTool.description || `MCP tool "${remoteTool.name}" from server "${name}"`,
            inputSchema,
            isEnabled: () => true,
            isReadOnly: () => false, // Conservative — assume destructive
            isConcurrencySafe: () => true, // Separate process, safe to run in parallel
            // 16.10: MCP servers can execute arbitrary external actions (drop a
            // DB, send mail), so trusting them sight-unseen is risky. We now
            // require interactive approval in default mode for the FIRST call to
            // each MCP tool, then remember the user's choice for the rest of the
            // session. plan/bypass/acceptEdits still flow through the system-level
            // checkPermission on top of this. The "always" choice is sticky so a
            // confirmed tool stops prompting.
            requiresApproval: () => true,

            async call(input: Record<string, unknown>): Promise<ToolResult> {
              try {
                const result = await withTimeout(
                  `callTool(${toolName})`,
                  connectedClient.callTool({
                    name: remoteTool.name,
                    arguments: input,
                  }),
                  CALL_TOOL_TIMEOUT_MS,
                );

                // Extract text content from result
                const content = (result.content as CallToolResult["content"])
                  .filter((c): c is TextContent => c.type === "text")
                  .map((c) => c.text)
                  .join("\n");

                return { content: content || "(no text output)" };
              } catch (error) {
                if (error instanceof TimeoutError) await manager.disconnectServer(name);
                return {
                  content: "",
                  error: `MCP tool error (${toolName}): ${error instanceof Error ? error.message : String(error)}`,
                };
              }
            },

            formatResult: (r: ToolResult) => {
              if (r.error) {
                // call() always produces error messages without "Error:" prefix
                // (e.g. "MCP tool error (name): ..."), so we add it here so the
                // terminal renderer always shows a red "Error: ..." label.
                return r.error.startsWith("Error:") ? r.error : `Error: ${r.error}`;
              }
              return r.content;
            },

            checkPermissions: async (
              _input: Record<string, unknown>,
              context: ToolContext,
            ): Promise<PermissionResult> => {
              // 16.10: prompt on the first call to each MCP tool per session,
              // then honor the sticky "always" decision. In plan mode the
              // system-level checkPermission hard-blocks anyway; here we only
              // gate the default-mode first use. bypassPermissions/acceptEdits
              // are likewise handled by the system level, so this returns
              // allowed:true there and lets the loop proceed.
              if (context.permissionMode === "bypassPermissions") {
                return { allowed: true };
              }
              if (this.confirmedMcpTools.has(toolName)) {
                return { allowed: true };
              }
              const allowed = context.askUser
                ? await context.askUser(
                    { name: toolName } as Tool,
                    _input,
                    `First call to MCP tool "${toolName}" — confirm to trust this server action`,
                  )
                : true;
              if (allowed) {
                this.confirmedMcpTools.add(toolName);
                return { allowed: true };
              }
              return {
                allowed: false,
                reason: `MCP tool "${toolName}" not approved by user`,
              };
            },
          } as Tool;
        })
        .filter((t): t is Tool => t !== null);

      this.servers.set(name, {
        config,
        client: connectedClient,
        transport: activeTransport,
        tools: mcpTools,
      });
      console.log(`MCP server "${name}" connected (${config.type}) — ${mcpTools.length} tool(s)`);
    } catch (error) {
      console.error(
        `Failed to connect MCP server "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
      await closeMcpConnection(`connect(${name})`, client, activeTransport);
      // Don't crash — MCP is optional
    }
  }

  private async handleElicitation(params: {
    message: string;
    requestedSchema?: Record<string, unknown>;
    mode?: string;
    url?: string;
  }): Promise<{
    action: "accept" | "decline" | "cancel";
    content?: Record<string, string | number | boolean | string[]>;
  }> {
    if (params.mode === "url") {
      return this.elicitationHandler ? this.elicitationHandler(params) : { action: "decline" };
    }
    if (!this.elicitationHandler) return { action: "decline" };
    return this.elicitationHandler(params);
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
  ): StreamableHTTPClientTransport | SSEClientTransport | WebSocketClientTransport {
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
  private isUnauthorized(error: unknown): boolean {
    if (!error) return false;
    // Probe the common shapes: SDK UnauthorizedError, or an HTTP-ish error
    // carrying a 401 code/status.
    const e = error as {
      name?: string;
      constructor?: { name?: string };
      code?: number;
      status?: number;
      message?: string;
    };
    const name = e.name || e.constructor?.name || "";
    if (name === "UnauthorizedError") return true;
    if (e.code === 401 || e.status === 401) return true;
    const msg = String(e.message || "").toLowerCase();
    return msg.includes("unauthorized") || msg.includes("401");
  }

  /**
   * Get all tools from connected MCP servers
   */
  getAllTools(): Tool[] {
    const allTools: Tool[] = [];
    for (const server of this.servers.values()) {
      allTools.push(...server.tools);
    }
    return allTools;
  }

  /**
   * Compact "server → tools" summary for the system prompt. Lets the model see
   * WHICH MCP servers are connected and what each exposes (beyond the bare tool
   * definitions carried by the API `tools` argument). Returns "" when no servers
   * are connected, so callers can pass it straight into buildSystemPrompt.
   */
  describeServersForPrompt(): string {
    const lines: string[] = [];
    for (const [name, server] of this.servers) {
      const tools = server.tools.map((t) => t.name).join(", ");
      lines.push(`- ${name}: ${tools || "(no tools)"}`);
    }
    return lines.join("\n");
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
        const res = await withTimeout(
          `listResources(${name})`,
          server.client.listResources(),
          RESOURCE_TIMEOUT_MS,
        );
        for (const r of res.resources ?? []) {
          out.push({ server: name, uri: r.uri, name: r.name, mimeType: r.mimeType });
        }
      } catch (error) {
        if (error instanceof TimeoutError) await this.disconnectServer(name);
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
    for (const [name, server] of this.servers) {
      try {
        const res = await withTimeout(
          `readResource(${uri})`,
          server.client.readResource({ uri }),
          RESOURCE_TIMEOUT_MS,
        );
        const text = (res.contents ?? [])
          .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
          .filter(Boolean)
          .join("\n");
        if (text) return text;
        // Resource existed but had no text content (e.g. blob).
        if ((res.contents ?? []).length > 0) return "(non-text resource content)";
      } catch (error) {
        if (error instanceof TimeoutError) await this.disconnectServer(name);
        // Not on this server — try the next.
      }
    }
    return null;
  }

  async listPrompts(): Promise<Array<{ server: string; name: string; description?: string }>> {
    const out: Array<{ server: string; name: string; description?: string }> = [];
    for (const [name, server] of this.servers) {
      try {
        const res = await withTimeout(
          `listPrompts(${name})`,
          server.client.listPrompts(),
          RESOURCE_TIMEOUT_MS,
        );
        for (const p of res.prompts ?? [])
          out.push({ server: name, name: p.name, description: p.description });
      } catch (error) {
        if (error instanceof TimeoutError) await this.disconnectServer(name);
      }
    }
    return out;
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<string | null> {
    for (const [serverName, server] of this.servers) {
      try {
        const res = await withTimeout(
          `getPrompt(${name})`,
          server.client.getPrompt({ name, arguments: args }),
          RESOURCE_TIMEOUT_MS,
        );
        const text = (res.messages ?? [])
          .map((m) => {
            const c = m.content as { type?: string; text?: string };
            return c.type === "text" ? (c.text ?? "") : "";
          })
          .filter(Boolean)
          .join("\n");
        if (text) return text;
      } catch (error) {
        if (error instanceof TimeoutError) await this.disconnectServer(serverName);
      }
    }
    return null;
  }

  /**
   * Disconnect all MCP servers
   */
  async disconnectAll(): Promise<void> {
    const entries = [...this.servers.entries()];
    this.servers.clear();
    await Promise.all(
      entries.map(async ([name, server]) => {
        await closeMcpConnection(`disconnect(${name})`, server.client, server.transport);
        console.log(`MCP server "${name}" disconnected.`);
      }),
    );
  }

  /**
   * Disconnect a single server by name
   */
  async disconnectServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    try {
      await closeMcpConnection(`disconnect(${name})`, server.client, server.transport);
    } finally {
      this.servers.delete(name);
    }
  }

  /**
   * Get the number of connected servers
   */
  get serverCount(): number {
    return this.servers.size;
  }
}

export interface ElicitationRequest {
  message: string;
  requestedSchema?: Record<string, unknown>;
  mode?: string;
  url?: string;
}
export interface ElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
}
export type ElicitationHandler = (request: ElicitationRequest) => Promise<ElicitationResult>;

// --- Discover MCP Config Files ---

/**
 * Find all MCP configuration files from standard locations
 */
export function discoverMCPConfigs(workspaceRoot: string): string[] {
  const configs: string[] = [];

  // User-level config (~/.claude/mcp.json)
  // CCR-only workspace config; never read official Claude Code locations.
  const projectConfig = ccrPath(workspaceRoot, "mcp.json");
  if (fs.existsSync(projectConfig)) {
    configs.push(projectConfig);
  }
  for (const dir of pluginDirs(workspaceRoot)) {
    const file = path.join(dir, "mcp.json");
    if (fs.existsSync(file)) configs.push(file);
    const nested = ccrPath(dir, "mcp.json");
    if (fs.existsSync(nested)) configs.push(nested);
  }

  return configs;
}
