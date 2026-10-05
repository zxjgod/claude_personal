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

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { getWorkspaceRoot } from "../cli-config.js";
import { ccrPath } from "../workspace-config.js";

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
  binding?: string;
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/** On-disk envelope: only the (public, hash-derived) binding stays readable. */
interface StoredEnvelope {
  binding: string;
  enc: { iv: string; tag: string; data: string };
}

// --- At-rest encryption ---
// Tokens used to be persisted as plaintext JSON (review finding: "MCP OAuth
// token 明文存储"). They are now AES-256-GCM encrypted under a per-install
// random key kept in a SEPARATE file (`<dir>/.key`). This is obfuscation-
// level protection — any process running as the same user can read both
// files — but it keeps bearer tokens out of backups, sync folders, dotfile
// repos, and casual `cat ~/.claude/mcp-auth/*`. There is no OS-keychain
// dependency in this project, so a random key file is the honest ceiling.
function keyPath(storeDir: string): string {
  return path.join(storeDir, ".key");
}

function loadOrCreateKey(storeDir: string): Buffer {
  try {
    const hex = fs.readFileSync(keyPath(storeDir), "utf-8").trim();
    const key = Buffer.from(hex, "hex");
    if (key.length === 32) return key;
  } catch {
    /* fall through to create */
  }
  const key = randomBytes(32);
  try {
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyPath(storeDir), key.toString("hex"), { mode: 0o600 });
  } catch {
    /* best effort — write() will surface persistent failures */
  }
  return key;
}

function encryptPayload(key: Buffer, payload: StoredAuth): StoredEnvelope["enc"] {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf-8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptPayload(key: Buffer, enc: StoredEnvelope["enc"]): StoredAuth {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(enc.data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf-8")) as StoredAuth;
}

function authDir(): string {
  // getWorkspaceRoot() (WORKSPACE_ROOT env, else the startup cwd) — the same
  // source of truth the rest of the config layer uses. A bare process.cwd()
  // here drifts from the logical workspace whenever the two disagree, and the
  // stored OAuth tokens would "move" (forcing re-auth) between launches.
  return ccrPath(getWorkspaceRoot(), "mcp-auth");
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
  private readonly binding: string;
  /** Authorization URL captured during the SDK's redirect step. */
  private pendingAuthUrl: URL | null = null;

  constructor(
    private readonly serverName: string,
    serverUrl: URL,
    private readonly config: MCPOAuthConfig,
    /** Override the auth-state directory (tests). Defaults to ~/.claude/mcp-auth. */
    storeDir: string = authDir(),
  ) {
    this.storeDir = storeDir;
    const resource = new URL(serverUrl);
    resource.hash = "";
    this.binding = createHash("sha256")
      .update(
        JSON.stringify([
          serverName,
          resource.href,
          config.clientId ?? null,
          config.scopes ?? [],
          this.redirectUrl,
        ]),
      )
      .digest("hex");
    // Never import legacy name-only stores: their token audience is unknown.
    this.storePath = path.join(
      storeDir,
      `${safeName(serverName).slice(0, 60)}-${this.binding}.json`,
    );
    this.stored = this.read();
  }

  // --- Persistence helpers ---

  private read(): StoredAuth {
    try {
      const raw = JSON.parse(fs.readFileSync(this.storePath, "utf-8")) as StoredEnvelope &
        StoredAuth;
      if (raw.binding !== this.binding) return {};
      if (raw.enc) {
        // Encrypted envelope — a decryption failure (missing/rotated key)
        // drops the store and forces re-authorization, never a silent
        // fallback to treating ciphertext as state.
        return decryptPayload(loadOrCreateKey(this.storeDir), raw.enc);
      }
      // Legacy plaintext store — migrate to the encrypted envelope on read.
      const legacy: StoredAuth = {
        clientInformation: raw.clientInformation,
        tokens: raw.tokens,
        codeVerifier: raw.codeVerifier,
      };
      if (legacy.clientInformation || legacy.tokens || legacy.codeVerifier) {
        this.stored = legacy;
        this.write();
      }
      return legacy;
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
    const envelope: StoredEnvelope = {
      binding: this.binding,
      enc: encryptPayload(loadOrCreateKey(this.storeDir), this.stored),
    };
    fs.writeFileSync(this.storePath, JSON.stringify(envelope, null, 2), {
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
      // CSRF check (Top10 follow-up A7): when the SDK's authorization URL
      // carries a `state` parameter, the callback MUST echo it back exactly —
      // otherwise any local process (or a malicious page hitting
      // 127.0.0.1:port/callback?code=…) could inject its own authorization
      // code. Conditional because the SDK version in use may omit state;
      // PKCE still binds the token exchange in that case.
      const expectedState = this.pendingAuthUrl?.searchParams.get("state") ?? null;
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
          if (expectedState !== null && reqUrl.searchParams.get("state") !== expectedState) {
            res.end("<h3>State mismatch — the callback was rejected (possible CSRF).</h3>");
            cleanup();
            reject(new Error("OAuth callback state mismatch (possible CSRF) — rejected"));
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
        // Actionable message for the common failure: the callback port is
        // occupied. The port CANNOT simply be randomized per run — the
        // redirect URL is part of both the OAuth client registration and the
        // token-store binding hash, so it must stay stable across launches.
        if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
          reject(
            new Error(
              `OAuth callback port ${port} is already in use. Free the port or configure a stable "redirectPort" for this server's OAuth config.`,
            ),
          );
          return;
        }
        reject(e);
      });
      server.listen(port, "127.0.0.1");
    });
  }
}
