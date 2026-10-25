// ============================================================
// MCP (Model Context Protocol) Integration
// ============================================================
// Connects to external MCP servers (stdio/http/sse), discovers
// their tools, and wraps them as native Tool objects for the
// agent loop. Uses the official @modelcontextprotocol/sdk.
// ============================================================

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import {
  type CallToolResult,
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pluginDirs, readManifest } from "../plugins.js";
import { userConfigRoot } from "../settings.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
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
 * Mirrors Claude Code's MCP config behavior: an MCP config (CCR reads
 * `.claude/mcp.json`) may reference secrets (e.g. `"Authorization":
 * "Bearer ${GITHUB_TOKEN}"`) without baking them into the repo. Undefined
 * variables expand to "" rather than leaking a literal `${...}` (which would
 * be sent verbatim as a header value).
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
  namespace?: string;
  /** Require explicit approval before connecting servers from a project file. */
  requireTrust?: boolean;
  confirm?: (descriptions: string[]) => Promise<boolean>;
  /** Official `disabledMcpjsonServers` (settings.json): server NAMES to skip
   *  entirely — they neither connect nor trigger the trust prompt. */
  disabledServers?: ReadonlySet<string>;
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
  // Review fix: Windows stdio servers commonly fail to start without these —
  // APPDATA/LOCALAPPDATA (node/python config homes), PATHEXT (cmd resolves
  // .cmd/.bat shims through it), PSModulePath (powershell-based servers).
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "PSModulePath",
]);

/** Keep ambient credentials out of project-controlled MCP child processes. */
export function buildStdioEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_STDIO_ENV_KEYS) {
    // Review fix ("Path 大小写"): Windows env keys are case-INSENSITIVE but
    // process.env property lookup preserves the key casing the parent was
    // started with ("Path" on most Windows systems) — an exact-case read
    // misses it and the child spawns without a PATH at all. Fall back to a
    // case-insensitive scan.
    let value = process.env[key];
    if (value === undefined) {
      const lower = key.toLowerCase();
      for (const [k, v] of Object.entries(process.env)) {
        if (k.toLowerCase() === lower && v !== undefined) {
          value = v;
          break;
        }
      }
    }
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...(expandEnvRecord(overrides) ?? {}) };
}

// --- Project-MCP trust gate ------------------------------------------------
// A project `.claude/mcp.json` can spawn arbitrary stdio commands (and reach
// http endpoints) — loading it unconditionally would make "clone a malicious
// repo and run the assistant" a supply-chain exploit. Servers from a project
// config are therefore trusted ONCE per (config-path, config-content) pair,
// keyed on a fingerprint of the raw file so any edit re-prompts. Trust is
// persisted to the same directory as the hooks trust store, in a separate file.
// Plugin configs are exempt by decision (install-is-trust); see McpConfigScope.

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

// Exported for the agent-scoped MCP gate (拍板 #14-B): agent frontmatter
// mcpServers reuse the same (path, content-fingerprint) one-time trust.
export { isMcpConfigTrusted, trustMcpConfig };

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
   * server name → (wrapped tool name → definition fingerprint).
   *
   * Per SERVER, not one flat map: two servers can legitimately produce the same
   * wrapped name (`mcp__${server}__${tool}` — the plugin namespace separator and
   * any server/tool name containing `__` make cross-server collisions routine),
   * and `getAllTools()` resolves them "first server wins". A single flat map
   * let the LOSER's fingerprint overwrite the winner's, so the surviving tool
   * failed its own staleness check on every call and was permanently unusable
   * with "definition changed; request the refreshed tool".
   */
  private toolDefinitions: Map<string, Map<string, string>> = new Map();
  clearApprovals(): void {
    // No-op retained for callers (session resume / disconnect): MCP approvals
    // are no longer cached manager-side — a one-time "yes" approves ONE call,
    // and sticky "always" grants live in the permission prompter's alwaysAllow
    // set (keyed with the tool-definition fingerprint).
  }
  private elicitationHandler: ElicitationHandler | null = null;
  /**
   * S2: listeners fired after a server's tool set changes (toolsListChanged
   * notification or a manual /mcp refresh). The CLI subscribes to keep the
   * live tool array (and the sub-agent injection set) in sync.
   */
  private changeListeners: Array<(server: string) => void> = [];

  /** Subscribe to tool-set changes. Returns an unsubscribe function. */
  onToolsChanged(cb: (server: string) => void): () => void {
    this.changeListeners.push(cb);
    return () => {
      this.changeListeners = this.changeListeners.filter((f) => f !== cb);
    };
  }

  setElicitationHandler(handler: typeof this.elicitationHandler): void {
    this.elicitationHandler = handler;
  }

  /**
   * Load MCP configuration from a JSON file
   */
  async loadConfig(configPath: string, options: MCPLoadOptions = {}): Promise<void> {
    let raw: string;
    try {
      raw = configPath.trim().startsWith("{") ? configPath : fs.readFileSync(configPath, "utf-8");
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
      if (
        !config ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        !config.mcpServers ||
        typeof config.mcpServers !== "object" ||
        Array.isArray(config.mcpServers)
      )
        throw new Error("Expected an object with mcpServers object");
      for (const [name, server] of Object.entries(config.mcpServers)) {
        if (!server || typeof server !== "object" || Array.isArray(server)) {
          console.warn(`Invalid MCP server ${name}; skipping`);
          delete config.mcpServers[name];
        }
      }
    } catch (error) {
      console.error(
        `Error parsing MCP config from ${configPath}:`,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    if (options.requireTrust) {
      const enabled = Object.entries(config.mcpServers).filter(
        ([name, server]) => !server.disabled && !options.disabledServers?.has(name),
      );
      // Only prompt when this exact config content has not been trusted before.
      // Once trusted, subsequent launches load it silently; an edited config
      // changes the fingerprint and re-prompts.
      if (enabled.length > 0 && !isMcpConfigTrusted(configPath, raw)) {
        const descriptions = enabled.map(([name, server]) => {
          const target =
            server.type === "stdio"
              ? [server.command, ...(server.args ?? [])].join(" ")
              : server.url;
          // The trust prompt must disclose every channel through which this
          // server can receive the user's environment: `env` (stdio child
          // process) and `headers` (HTTP transport) both support ${VAR}
          // expansion, so a config that siphons secrets must be visible at
          // confirmation time. Show var NAMES, never expanded values.
          const channels: string[] = [];
          for (const [label, record] of [
            ["env", server.env],
            ["headers", server.headers],
          ] as const) {
            if (!record) continue;
            const entries = Object.entries(record).map(
              ([k, v]) => `${k}=${v.includes("${") ? v : "<set>"}`,
            );
            channels.push(`${label}: ${entries.join(", ")}`);
          }
          const suffix = channels.length > 0 ? ` [${channels.join(" | ")}]` : "";
          // The whole line is untrusted config content (name/command/args/
          // env keys) printed by the confirm callback — sanitize it here so
          // every consumer gets clean text.
          return sanitizeTerminalText(
            `${name} (${server.type}): ${target ?? "configured server"}${suffix}`,
          );
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
      if (serverConfig.disabled || options.disabledServers?.has(name)) continue;
      await this.connectServer(options.namespace ? `${options.namespace}__${name}` : name, {
        ...serverConfig,
        type: serverConfig.type ?? (serverConfig.command ? "stdio" : "http"),
      });
    }
  }

  /**
   * Connect to a single MCP server and discover its tools.
   *
   * Returns true when the server ended up registered, false otherwise
   * (missing command/url, unknown transport, connection failure). Callers
   * that treat a missing server as fatal — agent-scoped servers — can branch
   * on this instead of reading the console log (review fix "agent 作用域 MCP
   * 连接失败仍返回 ready").
   */
  async connectServer(name: string, config: MCPServerConfig): Promise<boolean> {
    // Don't double-connect
    if (this.servers.has(name)) {
      console.warn(`MCP server "${name}" is already connected.`);
      return true;
    }

    let client: Client | undefined;
    let activeTransport: McpTransport | undefined;

    try {
      // --- Create transport based on type ---
      if (config.type === "stdio") {
        if (!config.command) {
          console.error(`MCP server "${name}": stdio transport requires a "command"`);
          return false;
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
          return false;
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
            // finishAuth exchanges the code for tokens on the transport — a
            // hung token endpoint must not stall the connect flow forever
            // (review fix: every OTHER network phase here is withTimeout'd).
            await withTimeout(
              "finishAuth",
              (reTransport as StreamableHTTPClientTransport | SSEClientTransport).finishAuth(code),
              CONNECT_TIMEOUT_MS,
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
        return false;
      }

      // --- Discover tools ---
      if (!client) throw new Error("MCP client was not initialized");
      const connectedClient = client;
      const toolsResult = await withTimeout("listTools", client.listTools(), LIST_TOOLS_TIMEOUT_MS);
      const mcpTools: Tool[] = this.wrapRemoteTools(name, toolsResult.tools, connectedClient);

      this.servers.set(name, {
        config,
        client: connectedClient,
        transport: activeTransport,
        tools: mcpTools,
      });
      // S2: subscribe to the server's toolsListChanged notification so a
      // server that adds/removes tools mid-session is reflected without a
      // restart. The handler re-lists and fires the change listeners.
      try {
        connectedClient.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          void this.refreshServerTools(name).catch((error) => {
            console.warn(
              `MCP server "${name}": toolsListChanged refresh failed:`,
              error instanceof Error ? error.message : String(error),
            );
          });
        });
      } catch {
        /* SDK build without notification handlers — refresh stays manual. */
      }
      console.log(`MCP server "${name}" connected (${config.type}) — ${mcpTools.length} tool(s)`);
      return true;
    } catch (error) {
      console.error(
        `Failed to connect MCP server "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
      await closeMcpConnection(`connect(${name})`, client, activeTransport);
      // Don't crash — MCP is optional
      return false;
    }
  }

  /**
   * Wrap a server's remote tools as CCR Tool objects (S2: extracted so both
   * connectServer and refreshServerTools share one wrapping implementation —
   * approval stickiness, timeouts, schema validation and all).
   */
  private wrapRemoteTools(
    name: string,
    remoteTools: Awaited<ReturnType<Client["listTools"]>>["tools"],
    connectedClient: Client,
  ): Tool[] {
    const manager = this;
    // A server listing the same tool name twice violates the protocol, but a
    // broken/hostile server can do it — and a duplicate would make the
    // registry's register() throw mid-swap. First listing wins.
    const seenNames = new Set<string>();
    const mcpTools: Tool[] = remoteTools
      .filter((remoteTool) => {
        if (seenNames.has(remoteTool.name)) {
          console.warn(
            `MCP server "${name}": duplicate tool name "${remoteTool.name}" in list, skipping`,
          );
          return false;
        }
        seenNames.add(remoteTool.name);
        return true;
      })
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
        const definition = crypto
          .createHash("sha256")
          .update(JSON.stringify(remoteTool))
          .digest("hex");
        let definitions = this.toolDefinitions.get(name);
        if (!definitions) {
          definitions = new Map<string, string>();
          this.toolDefinitions.set(name, definitions);
        }
        definitions.set(toolName, definition);

        return {
          name: toolName,
          description: `MCP tool: ${remoteTool.name} (from ${name} server)`,
          promptDescription:
            remoteTool.description || `MCP tool "${remoteTool.name}" from server "${name}"`,
          inputSchema,
          isEnabled: () => true,
          isReadOnly: () => false, // Conservative — assume destructive
          // Conservative too (review fix): the old `true` let a destructive
          // MCP call (drop a DB, send mail) run inside a PARALLEL batch
          // alongside other mutations. "Separate process" says nothing about
          // side-effect isolation.
          isConcurrencySafe: () => false,
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

              // Extract text content from result. A remote tool reports failure
              // with `isError: true` (protocol-level, NOT a thrown error) — the
              // old code returned that as a plain success, so the model read
              // "permission denied" / "file not found" text as a completed
              // action and the TUI rendered it as a normal result. `content` is
              // also optional in the schema, and `.filter` on undefined threw a
              // TypeError that masked the real failure.
              const raw = (result as CallToolResult).content;
              const blocks = Array.isArray(raw) ? raw : [];
              // Review fix ("非文本与结构化结果被静默丢弃"): text content joins
              // as before; non-text blocks (image/audio/resource) become a
              // descriptive placeholder instead of vanishing into
              // "(no text output)", and a structuredContent payload rides
              // along as JSON so the model can actually use it.
              const parts: string[] = [];
              for (const block of blocks) {
                if (block?.type === "text" && typeof block.text === "string") {
                  parts.push(block.text);
                  continue;
                }
                if (block?.type === "resource") {
                  const resource = block as { uri?: string; text?: string };
                  parts.push(resource.text ?? `[resource: ${resource.uri ?? "unknown"}]`);
                  continue;
                }
                if (block && typeof block === "object" && "type" in block) {
                  const kind = String((block as { type?: unknown }).type);
                  const mimeType =
                    typeof (block as { mimeType?: unknown }).mimeType === "string"
                      ? ` ${(block as { mimeType: string }).mimeType}`
                      : "";
                  parts.push(`[non-text content: ${kind}${mimeType}]`);
                }
              }
              const structured = (result as { structuredContent?: unknown }).structuredContent;
              if (structured !== undefined && structured !== null)
                parts.push(JSON.stringify(structured, null, 2));
              const content = parts.join("\n");
              if ((result as CallToolResult).isError)
                return {
                  content,
                  error: `MCP tool error (${toolName}): ${content || "tool reported an error"}`,
                };
              if (!Array.isArray(raw))
                return {
                  content: "",
                  error: `MCP tool error (${toolName}): malformed tool result (content is not an array)`,
                };

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
            // 16.10 (hardened): EVERY call to an MCP tool prompts unless the
            // user chose "always" — a one-time "yes" approves exactly one
            // invocation. The old manager-side confirmed set let a single yes
            // silently authorize every later call with ANY arguments (a write
            // tool approved for /tmp/a.txt could then write anywhere). Sticky
            // trust flows through the prompter's alwaysAllow set, whose key
            // carries the definition fingerprint below, so a definition change
            // also revokes the grant. bypassPermissions/acceptEdits are
            // handled by the system level, so this returns allowed:true there
            // and lets the loop proceed.
            if (context.permissionMode === "bypassPermissions") {
              return { allowed: true };
            }
            if (this.toolDefinitions.get(name)?.get(toolName) !== definition)
              return {
                allowed: false,
                reason: "MCP tool definition changed; request the refreshed tool",
              };
            const allowed = context.askUser
              ? await context.askUser(
                  { name: toolName, isReadOnly: () => false, requiresApproval: () => true } as Tool,
                  { ..._input, __approvalFingerprint: definition },
                  `MCP tool "${toolName}" — confirm this server action (choose "always" to stop re-prompting)`,
                )
              : false;
            if (allowed) {
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
    return mcpTools;
  }

  /**
   * S2: re-list a connected server's tools and swap them in, then fire the
   * change listeners. Used by the toolsListChanged notification and a manual
   * /mcp refresh. Throws on listTools failure (callers report); a server that
   * went away stays untouched for disconnectServer to handle.
   */
  async refreshServerTools(name: string): Promise<number> {
    const entry = this.servers.get(name);
    if (!entry) throw new Error(`MCP server "${name}" is not connected`);
    const toolsResult = await withTimeout(
      "listTools(refresh)",
      entry.client.listTools(),
      LIST_TOOLS_TIMEOUT_MS,
    );
    const refreshed = new Set(toolsResult.tools.map((tool) => `mcp__${name}__${tool.name}`));
    const definitions = this.toolDefinitions.get(name);
    if (definitions)
      for (const key of definitions.keys()) if (!refreshed.has(key)) definitions.delete(key);
    entry.tools = this.wrapRemoteTools(name, toolsResult.tools, entry.client);
    this.notifyToolsChanged(name);
    return entry.tools.length;
  }

  /** Fire the tools-changed listeners; a broken one must not break the caller. */
  private notifyToolsChanged(server: string): void {
    for (const cb of this.changeListeners) {
      try {
        cb(server);
      } catch (error) {
        // Silent swallowing left the UI/registry out of sync with no trace —
        // leave one.
        console.error(
          `MCP tools-changed listener failed (${server}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
    // No handler (headless run without a reader, or tests) → decline, so the
    // server learns the user chose not to answer instead of hanging. The
    // mode/url distinction is the HANDLER's business — the bridges in cli.ts
    // branch on it; duplicating that here was a dead-code fork (both arms did
    // the same thing).
    return this.elicitationHandler ? this.elicitationHandler(params) : { action: "decline" };
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
   * Get all tools from connected MCP servers. Deduped by wrapped name:
   * server names containing `__` can produce cross-server collisions
   * (mcp__a__b__c), and a duplicate makes registry.register() throw —
   * first server (insertion order) wins. A dropped duplicate is warned about
   * once per name (getAllTools is called on every refresh/list): otherwise the
   * loser's tool vanished silently, and worse, the model could unknowingly call
   * the OTHER server's same-named tool.
   */
  private warnedCollisions = new Set<string>();
  getAllTools(): Tool[] {
    const allTools: Tool[] = [];
    const seen = new Map<string, string>(); // wrapped name → owning server
    for (const [serverName, server] of this.servers) {
      for (const tool of server.tools) {
        const owner = seen.get(tool.name);
        if (owner !== undefined) {
          if (!this.warnedCollisions.has(tool.name)) {
            this.warnedCollisions.add(tool.name);
            console.warn(
              `MCP tool name collision: "${sanitizeTerminalText(tool.name)}" is exposed by both ` +
                `"${sanitizeTerminalText(owner)}" and "${sanitizeTerminalText(serverName)}" — ` +
                `keeping the first and ignoring the duplicate.`,
            );
          }
          continue;
        }
        seen.set(tool.name, serverName);
        allTools.push(tool);
      }
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
    this.toolDefinitions.clear();
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
    // Exact key, not a `mcp__${name}__` prefix scan: with a namespaced server
    // ("plug__srv") the prefix form also matched "plug" and wiped definitions
    // belonging to servers that are still connected.
    this.toolDefinitions.delete(name);
    const server = this.servers.get(name);
    if (!server) return;
    try {
      await closeMcpConnection(`disconnect(${name})`, server.client, server.transport);
    } finally {
      this.servers.delete(name);
      // S2 covers list CHANGES; a server vanishing is one too — without this
      // the dead server's wrapped tools linger in the live tools array and
      // registry (and keep being advertised to the model) until restart.
      this.notifyToolsChanged(name);
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
 * Where a discovered MCP config came from — drives the trust gate.
 * - "project": `<root>/.claude/mcp.json` — travels with cloned repos, so it is
 *   a supply-chain risk and MUST pass the fingerprint trust gate before any of
 *   its servers is spawned.
 * - "plugin": an installed plugin's `mcp.json` — install-is-trust (user
 *   decision 2026-09): installing the plugin already vouched for its servers,
 *   the same policy as disk command/skill templates. Not gated.
 */
export type McpConfigScope = "project" | "plugin" | "user" | "explicit";

export interface DiscoveredMcpConfig {
  path: string;
  scope: McpConfigScope;
}

/**
 * Find all MCP configuration files from CCR-specific locations. Never reads
 * official Claude Code locations (`.mcp.json`, `~/.claude.json`).
 *
 * Returns structured {path, scope} entries — callers gate on `scope`, NOT on
 * string-comparing paths (the old string comparison mismatched the discovery
 * location and silently disabled the project trust gate — Top10 #1).
 */
export function discoverMCPConfigs(workspaceRoot: string): DiscoveredMcpConfig[] {
  const configs: DiscoveredMcpConfig[] = [];
  if (process.argv.includes("--safe-mode") || process.argv.includes("--bare")) return configs;
  const strict = process.argv.includes("--strict-mcp-config");
  for (let index = 0; index < process.argv.length; index++)
    if (process.argv[index] === "--mcp-config" && process.argv[index + 1])
      configs.push({
        path: process.argv[index + 1]!.trim().startsWith("{")
          ? process.argv[++index]!
          : path.resolve(workspaceRoot, process.argv[++index]!),
        scope: "explicit",
      });
  if (strict) return configs;
  const user = path.join(userConfigRoot(), "mcp.json");
  if (fs.existsSync(user)) configs.push({ path: user, scope: "user" });
  if (process.env.CCR_COMPAT_CLAUDE === "1") {
    const official = path.join(workspaceRoot, ".mcp.json");
    if (fs.existsSync(official)) configs.push({ path: official, scope: "project" });
  }

  // CCR-only workspace config: <root>/.claude/mcp.json
  const projectConfig = ccrPath(workspaceRoot, "mcp.json");
  if (fs.existsSync(projectConfig)) {
    configs.push({ path: projectConfig, scope: "project" });
  }
  for (const dir of pluginDirs(workspaceRoot)) {
    const manifest = readManifest(dir);
    const declared =
      manifest?.mcp ?? (typeof manifest?.mcpServers === "string" ? manifest.mcpServers : undefined);
    if (declared) configs.push({ path: path.resolve(dir, declared), scope: "plugin" });
    const standard = path.join(dir, ".mcp.json");
    if (fs.existsSync(standard)) configs.push({ path: standard, scope: "plugin" });
    const file = path.join(dir, "mcp.json");
    if (fs.existsSync(file)) configs.push({ path: file, scope: "plugin" });
    const nested = ccrPath(dir, "mcp.json");
    if (fs.existsSync(nested)) configs.push({ path: nested, scope: "plugin" });
  }

  return [...new Map(configs.map((entry) => [entry.path, entry])).values()];
}
