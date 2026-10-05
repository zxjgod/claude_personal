// Tests for the official `--betas <betas...>` flag (src/api-betas.ts + the argv
// parser in src/cli-session-flags.ts).
//
// The reason this file is heavily weighted toward the allowlist: reading the
// binary's option registration suggests `--betas` is a plain variadic with no
// validation and therefore a pure passthrough. A live probe against official
// 2.1.202 proved that wrong — an unknown value is warned about and dropped,
// and the short registry NAME is rejected while the header string is accepted.
// Every one of those cases is pinned here.
import { describe, expect, it } from "vitest";
import {
  BETA_HEADER,
  betaHeaderValue,
  betaWarnings,
  resolveBetas,
  SUPPORTED_BETAS,
} from "../api-betas.js";
import { parseBetaTokens } from "../cli-session-flags.js";

describe("--betas argv parsing", () => {
  it("collects a variadic run and stops at the next flag", () => {
    expect(parseBetaTokens(["ccr", "--betas", "a", "b"])).toEqual(["a", "b"]);
    expect(parseBetaTokens(["ccr", "--betas", "a", "-p", "hello"])).toEqual(["a"]);
  });

  it("unions repeated occurrences and supports the inline form", () => {
    expect(parseBetaTokens(["ccr", "--betas", "a", "--betas", "b"])).toEqual(["a", "b"]);
    expect(parseBetaTokens(["ccr", "--betas=a"])).toEqual(["a"]);
  });

  it("rejects a bare --betas instead of pretending nothing was asked for", () => {
    expect(() => parseBetaTokens(["ccr", "--betas"])).toThrow(/at least one/);
    expect(() => parseBetaTokens(["ccr", "--betas", "--brief"])).toThrow(/at least one/);
    expect(parseBetaTokens(["ccr", "--brief"])).toEqual([]);
  });
});

describe("allowlist", () => {
  it("is the single hard-coded entry official ships", () => {
    // `f9s = new Set([WX])` in the binary. If this list ever grows, that is a
    // deliberate change — do not widen it casually.
    expect(SUPPORTED_BETAS).toEqual(["context-1m-2025-08-07"]);
  });

  it("accepts the allowlisted header", () => {
    const result = resolveBetas(["context-1m-2025-08-07"]);
    expect(result.allowed).toEqual(["context-1m-2025-08-07"]);
    expect(result.rejected).toEqual([]);
    expect(betaWarnings(result)).toEqual([]);
  });

  it("rejects the short registry NAME even though it maps to an allowed header", () => {
    // Confirmed live: official looks the value up in a map keyed by `header`,
    // so `long_context` never matches. The name looks right and is still wrong.
    const result = resolveBetas(["long_context"]);
    expect(result.allowed).toEqual([]);
    expect(result.rejected).toEqual(["long_context"]);
    expect(betaWarnings(result)).toEqual([
      "Warning: Beta header 'long_context' is not allowed. Only the following betas are supported: context-1m-2025-08-07",
    ]);
  });

  it("warns once per rejected value, in request order", () => {
    const result = resolveBetas(["made-up-a", "made-up-b"]);
    expect(betaWarnings(result)).toEqual([
      "Warning: Beta header 'made-up-a' is not allowed. Only the following betas are supported: context-1m-2025-08-07",
      "Warning: Beta header 'made-up-b' is not allowed. Only the following betas are supported: context-1m-2025-08-07",
    ]);
  });

  it("keeps the allowed value and still reports its rejected neighbours", () => {
    const result = resolveBetas(["made-up-a", "context-1m-2025-08-07", "made-up-b"]);
    expect(result.allowed).toEqual(["context-1m-2025-08-07"]);
    expect(result.rejected).toEqual(["made-up-a", "made-up-b"]);
    expect(betaWarnings(result)).toHaveLength(2);
  });

  it("is case- and whitespace-sensitive (it is a header value, not a name)", () => {
    expect(resolveBetas(["Context-1M-2025-08-07"]).allowed).toEqual([]);
    expect(resolveBetas([" context-1m-2025-08-07"]).allowed).toEqual([]);
  });

  it("drops everything behind the API-key gate, with a single warning", () => {
    const result = resolveBetas(["context-1m-2025-08-07", "made-up-a"], {
      notApiKeyUser: true,
    });
    expect(result.allowed).toEqual([]);
    expect(result.apiKeyRequired).toBe(true);
    // Official warns ONCE for the whole list here, not once per value.
    expect(betaWarnings(result)).toEqual([
      "Warning: Custom betas are only available for API key users. Ignoring provided betas.",
    ]);
  });

  it("returns nothing for an empty request without warning", () => {
    const result = resolveBetas([]);
    expect(result).toEqual({ allowed: [], rejected: [], apiKeyRequired: false });
    expect(betaWarnings(result)).toEqual([]);
  });
});

describe("header value", () => {
  it("is the comma-joined allowlist, matching the SDK's header param", () => {
    expect(BETA_HEADER).toBe("anthropic-beta");
    expect(betaHeaderValue(["context-1m-2025-08-07"])).toBe("context-1m-2025-08-07");
  });

  it("is undefined when nothing survived, so no empty header is sent", () => {
    expect(betaHeaderValue([])).toBeUndefined();
  });
});
