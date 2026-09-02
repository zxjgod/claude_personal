// ============================================================
// MCP OAuth 2.0 Authorization (11.2)
// ============================================================
// A file-backed OAuthClientProvider for the MCP SDK. It persists tokens,
// client registration, and the PKCE verifier under ~/.claude/mcp-auth/ so
// authorization survives across runs. The interactive flow spins up a tiny
// localhost callback server, prints the authorization URL for the user to
// open, and captures the returned authorization code.
//
// Security: tokens are written to a user-only directory (mode 0700). We never
// log token values. The redirect server binds to 127.0.0.1 and shuts down as
// soon as the code arrives (or times out).
// ============================================================

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// --- Config (from .mcp.json `oauth` block) ---

export interface MCPOAuthConfig {
  /** Pre-registered client id. Omit to use dynamic client registration. */
  clientId?: string;
  /** Pre-registered client secret (confidential clients). */
  clientSecret?: string;
  /** OAuth scopes to request. */
  scopes?: string[];
  /** Localhost port for the redirect callback (default 33418). */
  redirectPort?: number;
  /** Timeout (ms) to wait for the user to complete authorization. */
  timeoutMs?: number;
}

// --- Persisted state on disk ---

interface StoredAuth {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

function authDir(): string {
  return path.join(os.homedir(), ".claude", "mcp-auth");
}

function safeName(serverName: string): string {
  return serverName.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

/**
 * OAuthClientProvider backed by a per-server JSON file. The MCP SDK calls
 * these methods to drive the authorization-code + PKCE flow.
 */
export class FileTokenOAuthProvider implements OAuthClientProvider {
  private readonly storePath: string;
  private readonly storeDir: string;
  private stored: StoredAuth;
  /** Authorization URL captured during the SDK's redirect step. */
  private pendingAuthUrl: URL | null = null;

  constructor(
    private readonly serverName: string,
    /** Reserved for the authorization flow (currently the SDK drives URLs itself). */
    _serverUrl: URL,
    private readonly config: MCPOAuthConfig,
    /** Override the auth-state directory (tests). Defaults to ~/.claude/mcp-auth. */
    storeDir: string = authDir(),
  ) {
    this.storeDir = storeDir;
    this.storePath = path.join(storeDir, `${safeName(serverName)}.json`);
    this.stored = this.read();
  }

  // --- Persistence helpers ---

  private read(): StoredAuth {
    try {
      return JSON.parse(fs.readFileSync(this.storePath, "utf-8")) as StoredAuth;
    } catch {
      return {};
    }
  }

  private write(): void {
    try {
      fs.mkdirSync(this.storeDir, { recursive: true, mode: 0o700 });
    } catch {
      /* best effort */
    }
    fs.writeFileSync(this.storePath, JSON.stringify(this.stored, null, 2), {
      mode: 0o600,
    });
  }

  // --- OAuthClientProvider interface ---

  get redirectUrl(): string {
    const port = this.config.redirectPort ?? 33418;
    return `http://127.0.0.1:${port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "claude-code-replica",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      scope: this.config.scopes?.join(" "),
    } as OAuthClientMetadata;
  }

  clientInformation(): OAuthClientInformation | undefined {
    // A statically configured client id takes precedence over a registered one.
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      } as OAuthClientInformation;
    }
    return this.stored.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.stored.clientInformation = info;
    this.write();
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.stored.tokens = tokens;
    this.write();
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.stored.codeVerifier = codeVerifier;
    this.write();
  }

  codeVerifier(): string {
    if (!this.stored.codeVerifier) {
      throw new Error(`No PKCE code verifier saved for MCP server "${this.serverName}"`);
    }
    return this.stored.codeVerifier;
  }

  /**
   * The SDK calls this to hand us the authorization URL. We don't open a
   * browser automatically (headless-safe); instead we stash it and print it
   * in runInteractiveAuthorization, which also runs the callback server.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingAuthUrl = authorizationUrl;
  }

  // --- Interactive code exchange ---

  /**
   * Print the authorization URL, run a one-shot localhost callback server, and
   * resolve with the authorization code once the user completes the flow.
   * Must be called after the SDK has populated the pending auth URL (i.e.
   * after the first connect attempt threw UnauthorizedError).
   */
  async runInteractiveAuthorization(): Promise<string> {
    if (!this.pendingAuthUrl) {
      throw new Error(
        `OAuth flow for "${this.serverName}" has no authorization URL — the server may not require OAuth.`,
      );
    }
    const port = this.config.redirectPort ?? 33418;
    const timeoutMs = this.config.timeoutMs ?? 5 * 60_000;

    console.log("");
    console.log(`  Open this URL to authorize "${this.serverName}":`);
    console.log(`    ${this.pendingAuthUrl.toString()}`);
    console.log(`  Waiting for the callback on ${this.redirectUrl} …`);

    return await this.waitForCallbackCode(port, timeoutMs);
  }

  private waitForCallbackCode(port: number, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
          if (reqUrl.pathname !== "/callback") {
            res.writeHead(404).end("Not found");
            return;
          }
          const code = reqUrl.searchParams.get("code");
          const error = reqUrl.searchParams.get("error");
          res.writeHead(200, { "Content-Type": "text/html" });
          if (error) {
            res.end(`<h3>Authorization failed: ${error}</h3>You can close this tab.`);
            cleanup();
            reject(new Error(`OAuth authorization error: ${error}`));
            return;
          }
          if (!code) {
            res.end("<h3>Missing authorization code.</h3>");
            return;
          }
          res.end("<h3>Authorized. You can close this tab and return to the CLI.</h3>");
          cleanup();
          resolve(code);
        } catch (e) {
          cleanup();
          reject(e);
        }
      });

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`OAuth authorization timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        server.close();
      };

      server.on("error", (e) => {
        cleanup();
        reject(e);
      });
      server.listen(port, "127.0.0.1");
    });
  }
}
