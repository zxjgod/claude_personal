// ============================================================
// Tests: provider profiles (/provider hot-swap)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelCaller } from "../llm-adapter.js";
import {
  applyProfile,
  findProfile,
  loadProviderProfiles,
  type ProviderProfile,
  providersFilePath,
} from "../provider-profiles.js";
import type { ModelConfig } from "../types.js";

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-providers-"));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

/** Write `.claude/providers.json` into the temp workspace. */
function writeProfiles(content: string): void {
  const file = providersFilePath(ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function baseConfig(over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: "openai",
    model: "gpt-4o",
    apiKey: "key-original",
    baseURL: "https://api.openai.com/v1",
    maxTokens: 4096,
    temperature: 0.1,
    options: { effort: "high" },
    ...over,
  };
}

describe("loadProviderProfiles", () => {
  it("returns [] when the file is missing", () => {
    expect(loadProviderProfiles(ws)).toEqual([]);
  });

  it("returns [] on malformed JSON", () => {
    writeProfiles("{ not valid json ");
    expect(loadProviderProfiles(ws)).toEqual([]);
  });

  it("returns [] when 'profiles' is not an array", () => {
    writeProfiles(JSON.stringify({ profiles: { name: "x" } }));
    expect(loadProviderProfiles(ws)).toEqual([]);
  });

  it("loads valid profiles and fills optional fields", () => {
    writeProfiles(
      JSON.stringify({
        profiles: [
          {
            name: "relay",
            provider: "openai",
            baseURL: "https://r/v1",
            apiKey: "sk-r",
            model: "gpt-4o",
          },
          { name: "kimi", provider: "moonshot", apiKey: "sk-k" },
        ],
      }),
    );
    const profiles = loadProviderProfiles(ws);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toMatchObject({ name: "relay", provider: "openai", model: "gpt-4o" });
    expect(profiles[1]).toMatchObject({ name: "kimi", provider: "moonshot" });
    expect(profiles[1]!.model).toBeUndefined();
  });

  it("skips entries without a string name", () => {
    writeProfiles(
      JSON.stringify({
        profiles: [{ provider: "openai" }, { name: "" }, { name: "ok" }, null, 42],
      }),
    );
    const profiles = loadProviderProfiles(ws);
    expect(profiles.map((p) => p.name)).toEqual(["ok"]);
  });

  it("drops an unknown provider (falls back later to openai)", () => {
    writeProfiles(JSON.stringify({ profiles: [{ name: "weird", provider: "gemini" }] }));
    const [p] = loadProviderProfiles(ws);
    expect(p!.provider).toBeUndefined();
  });
});

describe("findProfile", () => {
  const profiles: ProviderProfile[] = [
    { name: "relay" },
    { name: "deepseek" },
    { name: "deepthink" },
  ];

  it("matches exactly, case-insensitively", () => {
    expect(findProfile(profiles, "RELAY")?.name).toBe("relay");
  });

  it("matches a unique prefix", () => {
    expect(findProfile(profiles, "rel")?.name).toBe("relay");
  });

  it("returns undefined for an ambiguous prefix", () => {
    expect(findProfile(profiles, "deep")).toBeUndefined();
  });

  it("returns undefined for no match / empty query", () => {
    expect(findProfile(profiles, "nope")).toBeUndefined();
    expect(findProfile(profiles, "  ")).toBeUndefined();
  });

  it("prefers an exact match over a prefix collision", () => {
    const withExact: ProviderProfile[] = [{ name: "deep" }, { name: "deepseek" }];
    expect(findProfile(withExact, "deep")?.name).toBe("deep");
  });
});

describe("applyProfile", () => {
  it("mutates the config in place (same reference)", () => {
    const cfg = baseConfig();
    const ref = cfg;
    applyProfile(cfg, {
      name: "ds",
      provider: "deepseek",
      apiKey: "sk-ds",
      model: "deepseek-chat",
    });
    expect(cfg).toBe(ref);
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.model).toBe("deepseek-chat");
    expect(cfg.apiKey).toBe("sk-ds");
    expect(cfg.baseURL).toContain("deepseek.com");
  });

  it("fills baseURL/model from provider defaults when omitted", () => {
    const cfg = baseConfig();
    applyProfile(cfg, { name: "qwen", provider: "qwen", apiKey: "sk-q" });
    expect(cfg.baseURL).toContain("dashscope.aliyuncs.com");
    expect(cfg.model).toBe("qwen-plus");
  });

  it("reuses the current apiKey when the profile omits one", () => {
    const cfg = baseConfig({ apiKey: "keep-me" });
    applyProfile(cfg, { name: "relay", baseURL: "https://r/v1", model: "gpt-4o" });
    expect(cfg.apiKey).toBe("keep-me");
  });

  it("defaults provider to openai when omitted", () => {
    const cfg = baseConfig({ provider: "deepseek" });
    applyProfile(cfg, { name: "relay", baseURL: "https://r/v1", apiKey: "sk", model: "x" });
    expect(cfg.provider).toBe("openai");
  });

  it("preserves maxTokens/temperature/options", () => {
    const cfg = baseConfig();
    applyProfile(cfg, { name: "ds", provider: "deepseek", apiKey: "sk" });
    expect(cfg.maxTokens).toBe(4096);
    expect(cfg.temperature).toBe(0.1);
    expect(cfg.options).toMatchObject({ effort: "high" });
  });

  it("switches the caller family when provider class changes", () => {
    // The /provider fix: resolving the caller per config (not once at startup)
    // means switching to/from anthropic picks a different caller function.
    const cfg = baseConfig({ provider: "openai" });
    const openaiCaller = createModelCaller(cfg);
    applyProfile(cfg, { name: "claude", provider: "anthropic", apiKey: "sk-ant" });
    const anthropicCaller = createModelCaller(cfg);
    expect(anthropicCaller).not.toBe(openaiCaller);
  });
});
