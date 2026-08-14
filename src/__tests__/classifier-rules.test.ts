// ============================================================
// Tests: classifier rule layer (Phase C2)
// ============================================================

import { describe, expect, it } from "vitest";
import {
  buildClassifierPrompt,
  DEFAULT_CLASSIFIER_RULES,
  mergeClassifierRules,
  parseClassifierRules,
} from "../classifier-rules.js";

describe("buildClassifierPrompt", () => {
  it("injects allow/soft_deny/environment rules", () => {
    const prompt = buildClassifierPrompt({
      allow: ["read files"],
      soft_deny: ["rm -rf"],
      environment: ["trusted workspace"],
    });
    expect(prompt).toContain("read files");
    expect(prompt).toContain("rm -rf");
    expect(prompt).toContain("trusted workspace");
  });

  it("renders (none) for empty sections", () => {
    const prompt = buildClassifierPrompt({ allow: [], soft_deny: [], environment: [] });
    expect(prompt).toContain("- (none)");
  });
});

describe("mergeClassifierRules", () => {
  it("replaces a section when the user provides a non-empty one", () => {
    const merged = mergeClassifierRules(DEFAULT_CLASSIFIER_RULES, { allow: ["my custom allow"] });
    expect(merged.allow).toEqual(["my custom allow"]);
    // Non-overridden sections keep defaults.
    expect(merged.soft_deny).toEqual(DEFAULT_CLASSIFIER_RULES.soft_deny);
  });

  it("keeps defaults when the user section is empty/absent", () => {
    const merged = mergeClassifierRules(DEFAULT_CLASSIFIER_RULES, { allow: [] });
    expect(merged.allow).toEqual(DEFAULT_CLASSIFIER_RULES.allow);
  });
});

describe("parseClassifierRules", () => {
  it("parses a JSON string", () => {
    const parsed = parseClassifierRules('{"allow":["a"],"soft_deny":["b"]}');
    expect(parsed).toEqual({ allow: ["a"], soft_deny: ["b"], environment: undefined });
  });

  it("returns null for missing/invalid input", () => {
    expect(parseClassifierRules(undefined)).toBeNull();
    expect(parseClassifierRules("")).toBeNull();
    expect(parseClassifierRules("not json")).toBeNull();
  });
});
