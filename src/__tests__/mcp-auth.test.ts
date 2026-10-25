// ============================================================
// Tests: MCP OAuth file-backed provider (11.2)
// ============================================================
// Exercises the OAuthClientProvider surface the MCP SDK drives: client
// metadata, static vs registered client info, token + PKCE persistence, and
// the captured authorization URL. The interactive callback server (network)
// is not exercised here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTokenOAuthProvider } from "../mcp/auth.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-oauth-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const url = new URL("https://mcp.example.com/sse");

describe("FileTokenOAuthProvider", () => {
  it("isolates credentials by resource, client identity, and unsanitized name", () => {
    const original = new FileTokenOAuthProvider("same/name", url, { clientId: "client-a" }, dir);
    // issuer: the upgraded SDK stamps the authorization server on every
    // saveTokens — a record without one is treated as legacy and dropped.
    original.saveTokens({
      access_token: "fake-token",
      token_type: "Bearer",
      issuer: "https://auth.example.com",
    } as any);
    for (const provider of [
      new FileTokenOAuthProvider(
        "same/name",
        new URL("https://other.example/sse"),
        { clientId: "client-a" },
        dir,
      ),
      new FileTokenOAuthProvider(
        "same/name",
        new URL("https://mcp.example.com/other"),
        { clientId: "client-a" },
        dir,
      ),
      new FileTokenOAuthProvider("same/name", url, { clientId: "client-b" }, dir),
      new FileTokenOAuthProvider("same_name", url, { clientId: "client-a" }, dir),
    ])
      expect(provider.tokens()).toBeUndefined();
    expect(
      new FileTokenOAuthProvider("same/name", url, { clientId: "client-a" }, dir).tokens()
        ?.access_token,
    ).toBe("fake-token");
  });

  it("does not trust legacy unbound credentials or mismatched binding metadata", () => {
    fs.writeFileSync(
      path.join(dir, "srv.json"),
      JSON.stringify({ tokens: { access_token: "legacy", token_type: "Bearer" } }),
    );
    const provider = new FileTokenOAuthProvider("srv", url, {}, dir);
    expect(provider.tokens()).toBeUndefined();
    provider.saveTokens({ access_token: "new", token_type: "Bearer" });
    const boundFile = fs.readdirSync(dir).find((name) => name !== "srv.json" && name !== ".key");
    if (!boundFile) throw new Error("Missing bound credential file");
    const stored = JSON.parse(fs.readFileSync(path.join(dir, boundFile), "utf8"));
    stored.binding = "wrong-resource";
    fs.writeFileSync(path.join(dir, boundFile), JSON.stringify(stored));
    expect(new FileTokenOAuthProvider("srv", url, {}, dir).tokens()).toBeUndefined();
  });

  it("never persists tokens in plaintext (encrypted envelope + separate key)", () => {
    const provider = new FileTokenOAuthProvider("srv", url, {}, dir);
    provider.saveTokens({
      access_token: "super-secret-token",
      token_type: "Bearer",
      issuer: "https://auth.example.com",
    } as any);
    provider.saveCodeVerifier("pkce-verifier-secret");
    const boundFile = fs.readdirSync(dir).find((name) => name.endsWith(".json"));
    if (!boundFile) throw new Error("Missing bound credential file");
    const onDisk = fs.readFileSync(path.join(dir, boundFile), "utf8");
    expect(onDisk).not.toContain("super-secret-token");
    expect(onDisk).not.toContain("pkce-verifier-secret");
    const envelope = JSON.parse(onDisk);
    expect(envelope.enc?.iv).toBeTruthy();
    expect(envelope.enc?.tag).toBeTruthy();
    expect(envelope.enc?.data).toBeTruthy();
    // The key lives in a separate file, and a fresh instance decrypts fine.
    expect(fs.existsSync(path.join(dir, ".key"))).toBe(true);
    expect(new FileTokenOAuthProvider("srv", url, {}, dir).tokens()?.access_token).toBe(
      "super-secret-token",
    );
  });

  it("drops the store (forces re-auth) when the encryption key is lost", () => {
    const provider = new FileTokenOAuthProvider("srv", url, {}, dir);
    provider.saveTokens({ access_token: "tok", token_type: "Bearer" });
    fs.unlinkSync(path.join(dir, ".key"));
    expect(new FileTokenOAuthProvider("srv", url, {}, dir).tokens()).toBeUndefined();
  });
  it("builds client metadata with the localhost redirect", () => {
    const p = new FileTokenOAuthProvider("srv", url, { redirectPort: 40000 }, dir);
    expect(p.redirectUrl).toBe("http://127.0.0.1:40000/callback");
    const meta = p.clientMetadata;
    expect(meta.redirect_uris).toContain("http://127.0.0.1:40000/callback");
    expect(meta.grant_types).toContain("authorization_code");
    expect(meta.token_endpoint_auth_method).toBe("none");
  });

  it("uses client_secret_post when a secret is configured", () => {
    const p = new FileTokenOAuthProvider("srv", url, { clientSecret: "s" }, dir);
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
  });

  it("prefers a statically configured client id", () => {
    const p = new FileTokenOAuthProvider(
      "srv",
      url,
      {
        clientId: "static-id",
        clientSecret: "sec",
      },
      dir,
    );
    expect(p.clientInformation()).toEqual({
      client_id: "static-id",
      client_secret: "sec",
    });
  });

  it("persists registered client info across instances", () => {
    const p1 = new FileTokenOAuthProvider("srv", url, {}, dir);
    expect(p1.clientInformation()).toBeUndefined();
    p1.saveClientInformation({
      client_id: "dyn-id",
      redirect_uris: [p1.redirectUrl],
    } as any);
    const p2 = new FileTokenOAuthProvider("srv", url, {}, dir);
    expect(p2.clientInformation()?.client_id).toBe("dyn-id");
  });

  it("persists tokens and the PKCE verifier", () => {
    const p1 = new FileTokenOAuthProvider("srv", url, {}, dir);
    p1.saveTokens({
      access_token: "tok",
      token_type: "bearer",
      issuer: "https://auth.example.com",
    } as any);
    p1.saveCodeVerifier("verifier-123");
    const p2 = new FileTokenOAuthProvider("srv", url, {}, dir);
    expect(p2.tokens()?.access_token).toBe("tok");
    expect(p2.codeVerifier()).toBe("verifier-123");
  });

  it("throws when reading a missing code verifier", () => {
    const p = new FileTokenOAuthProvider("srv", url, {}, dir);
    expect(() => p.codeVerifier()).toThrow(/code verifier/i);
  });

  it("captures the authorization URL from redirectToAuthorization", async () => {
    const p = new FileTokenOAuthProvider("srv", url, {}, dir);
    // No URL captured yet → interactive flow refuses.
    await expect(p.runInteractiveAuthorization()).rejects.toThrow(/authorization URL/i);
    p.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
    // We don't run the server here; just confirm the URL was stored by
    // checking a short-timeout run starts the wait (then times out fast).
    const fast = new FileTokenOAuthProvider(
      "srv2",
      url,
      { timeoutMs: 50, redirectPort: 40555 },
      dir,
    );
    fast.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
    await expect(fast.runInteractiveAuthorization()).rejects.toThrow(/timed out/i);
  });

  it("isolates token files per server name", () => {
    const a = new FileTokenOAuthProvider("alpha", url, {}, dir);
    a.saveTokens({ access_token: "A", token_type: "bearer" } as any);
    const b = new FileTokenOAuthProvider("beta", url, {}, dir);
    expect(b.tokens()).toBeUndefined();
    expect(a.tokens()?.access_token).toBe("A");
  });
});
