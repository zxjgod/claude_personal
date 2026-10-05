// ============================================================
// Tests: cloud gateway routing (11.3)
// ============================================================

import { describe, expect, it } from "vitest";
import { isCloudGateway, resolveGateway } from "../cloud-gateway.js";
import { resolveProviderConfig } from "../llm-adapter.js";

describe("cloud-gateway", () => {
  it("recognizes known gateways only", () => {
    expect(isCloudGateway("bedrock")).toBe(true);
    expect(isCloudGateway("vertex")).toBe(true);
    expect(isCloudGateway("openai")).toBe(false);
    expect(isCloudGateway(undefined)).toBe(false);
  });

  it("resolves Bedrock base URL with default region", () => {
    const r = resolveGateway("bedrock");
    expect(r.baseURL).toContain("bedrock-runtime.us-east-1.amazonaws.com");
    expect(r.baseURL).toContain("/openai/v1");
    expect(r.defaultModel).toContain("claude");
  });

  it("honors a custom Bedrock region", () => {
    const r = resolveGateway("bedrock", { region: "eu-west-1" });
    expect(r.baseURL).toContain("eu-west-1");
  });

  it("resolves Vertex base URL with project + region", () => {
    const r = resolveGateway("vertex", { project: "my-proj", region: "us-central1" });
    expect(r.baseURL).toContain("us-central1-aiplatform.googleapis.com");
    expect(r.baseURL).toContain("projects/my-proj");
  });

  it("uses the documented v1 OpenAI-compatible Vertex path by default", () => {
    // Google's documented compat base URL is
    // .../v1/projects/P/locations/L/endpoints/openapi — the v1beta1 prefix
    // belongs to the NATIVE publisher-model endpoints. An earlier round
    // flipped this to v1beta1 on an untested assumption; the segment is now
    // overridable instead of being a silent guess.
    const r = resolveGateway("vertex", { project: "my-proj", region: "us-central1" });
    expect(r.baseURL).toContain("/v1/projects/my-proj/");
    expect(r.baseURL).not.toContain("v1beta1");
  });

  it("honors an explicit and an env API version override", () => {
    expect(resolveGateway("vertex", { project: "p", apiVersion: "v1beta1" }).baseURL).toContain(
      "/v1beta1/projects/p/",
    );
    const previous = process.env.LLM_GATEWAY_API_VERSION;
    try {
      process.env.LLM_GATEWAY_API_VERSION = "v1beta1";
      expect(resolveGateway("vertex", { project: "p" }).baseURL).toContain("/v1beta1/");
    } finally {
      if (previous === undefined) delete process.env.LLM_GATEWAY_API_VERSION;
      else process.env.LLM_GATEWAY_API_VERSION = previous;
    }
  });

  it("rejects an API version with path/authority metacharacters", () => {
    expect(() => resolveGateway("vertex", { project: "p", apiVersion: "v1/../evil" })).toThrow(
      /API version/i,
    );
  });

  it("throws when Vertex project is missing", () => {
    expect(() => resolveGateway("vertex")).toThrow(/project/i);
  });

  it("rejects a region with URL-authority metacharacters (credential redirect)", () => {
    // "evil.com@" would turn the URL authority into userinfo and silently
    // send API-key-bearing requests to evil.com.
    expect(() => resolveGateway("bedrock", { region: "evil.com@" })).toThrow(/region/i);
    expect(() => resolveGateway("vertex", { project: "p", region: "a/b" })).toThrow(/region/i);
  });

  it("rejects a Vertex project id with path/authority metacharacters", () => {
    expect(() => resolveGateway("vertex", { project: "../escape", region: "us-central1" })).toThrow(
      /project/i,
    );
    expect(() =>
      resolveGateway("vertex", { project: "p@evil.com", region: "us-central1" }),
    ).toThrow(/project/i);
  });
});

describe("resolveProviderConfig + gateway", () => {
  it("routes openai provider through bedrock gateway base URL", () => {
    const cfg = resolveProviderConfig({
      provider: "openai",
      apiKey: "k",
      options: { gateway: "bedrock", gatewayRegion: "us-west-2" },
    });
    expect(cfg.baseURL).toContain("bedrock-runtime.us-west-2");
    expect(cfg.model).toContain("claude");
  });

  it("lets an explicit baseURL override the gateway", () => {
    const cfg = resolveProviderConfig({
      provider: "openai",
      apiKey: "k",
      baseURL: "https://proxy.internal/v1",
      options: { gateway: "bedrock" },
    });
    expect(cfg.baseURL).toBe("https://proxy.internal/v1");
  });

  it("ignores an unknown gateway value", () => {
    const cfg = resolveProviderConfig({
      provider: "openai",
      apiKey: "k",
      options: { gateway: "nonsense" },
    });
    expect(cfg.baseURL).toBe("https://api.openai.com/v1");
  });
});
