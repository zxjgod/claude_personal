// ============================================================
// Tests: cloud gateway routing (11.3)
// ============================================================

import { describe, it, expect } from "vitest";
import {
  isCloudGateway,
  resolveGateway,
} from "../cloud-gateway.js";
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

  it("throws when Vertex project is missing", () => {
    expect(() => resolveGateway("vertex")).toThrow(/project/i);
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
