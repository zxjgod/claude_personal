// ============================================================
// Tests: scoped-execution — agent-hook trust gate + per-loop skill scopes
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateSkill,
  activeSkillModel,
  clearSkillActivation,
  prepareAgentHooks,
} from "../scoped-execution.js";
import type { SkillDefinition } from "../skills.js";

describe("prepareAgentHooks (agent-hooks trust gate)", () => {
  const oldStore = process.env.CCR_TRUST_STORE;
  let storeFile: string;
  let repo: string;

  const hooksConfig = {
    PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "run-repo-hook.sh" }] }],
  };

  beforeEach(() => {
    storeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccr-hooks-trust-")), "trust.json");
    process.env.CCR_TRUST_STORE = storeFile;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-hooks-repo-"));
  });
  afterEach(() => {
    if (oldStore === undefined) delete process.env.CCR_TRUST_STORE;
    else process.env.CCR_TRUST_STORE = oldStore;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("passes user-scope agent hooks through with no prompt", async () => {
    const asked: string[] = [];
    const result = await prepareAgentHooks(
      { name: "mine", hooks: hooksConfig, hooksTrusted: true },
      async (_tool, _input, hint) => {
        asked.push(hint ?? "");
        return false;
      },
      repo,
    );
    expect(result.hooksConfig).toBe(hooksConfig);
    expect(result.note).toBeUndefined();
    expect(asked).toHaveLength(0);
  });

  it("fails closed for untrusted project hooks without an approval channel", async () => {
    const result = await prepareAgentHooks(
      { name: "repo-agent", hooks: hooksConfig },
      undefined,
      repo,
    );
    expect(result.hooksConfig).toBeUndefined();
    expect(result.note).toContain("will NOT run");
  });

  it("drops untrusted hooks when the user denies, and persists approval when accepted", async () => {
    let answer = false;
    const ask = async () => answer;
    const denied = await prepareAgentHooks({ name: "repo-agent", hooks: hooksConfig }, ask, repo);
    expect(denied.hooksConfig).toBeUndefined();
    expect(denied.note).toContain("denied");

    answer = true;
    const approved = await prepareAgentHooks({ name: "repo-agent", hooks: hooksConfig }, ask, repo);
    expect(approved.hooksConfig).toBe(hooksConfig);

    // The approval was persisted — a later run needs no prompt.
    const trusted = await prepareAgentHooks(
      { name: "repo-agent", hooks: hooksConfig },
      undefined,
      repo,
    );
    expect(trusted.hooksConfig).toBe(hooksConfig);

    // ...but a DIFFERENT hook declaration re-prompts (fingerprint binding).
    const edited = {
      PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "other-hook.sh" }] }],
    };
    const rePrompt = await prepareAgentHooks(
      { name: "repo-agent", hooks: edited },
      undefined,
      repo,
    );
    expect(rePrompt.hooksConfig).toBeUndefined();
  });

  it("scopes trust per workspace (self-review fix)", async () => {
    // Approving repo-agent's hooks in ONE repo must not auto-trust the same
    // declaration in ANOTHER repo — the first cut keyed the store entry by
    // agent name alone, so the approval crossed workspace boundaries.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-hooks-repo-b-"));
    try {
      const answer = true;
      const ask = async () => answer;
      const approved = await prepareAgentHooks(
        { name: "repo-agent", hooks: hooksConfig },
        ask,
        repo,
      );
      expect(approved.hooksConfig).toBe(hooksConfig);

      const asked: string[] = [];
      const crossWorkspace = await prepareAgentHooks(
        { name: "repo-agent", hooks: hooksConfig },
        async (_tool, _input, hint) => {
          asked.push(hint ?? "");
          return false;
        },
        other,
      );
      expect(crossWorkspace.hooksConfig).toBeUndefined();
      expect(asked).toHaveLength(1); // re-prompted, not silently trusted

      // And within the ORIGINAL workspace the approval still holds.
      const stillTrusted = await prepareAgentHooks(
        { name: "repo-agent", hooks: hooksConfig },
        undefined,
        repo,
      );
      expect(stillTrusted.hooksConfig).toBe(hooksConfig);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("treats a hooks-free agent as nothing to gate", async () => {
    const result = await prepareAgentHooks({ name: "plain" }, undefined, repo);
    expect(result).toEqual({});
  });
});

describe("skill activation scopes (parallel sub-agent isolation)", () => {
  const skill = (model: string): SkillDefinition =>
    ({ name: `sk-${model}`, model }) as SkillDefinition;
  const parent = { provider: "openai" as const, apiKey: "x", model: "base", options: {} };

  afterEach(() => {
    clearSkillActivation("s1");
    clearSkillActivation("s1", "task-a");
    clearSkillActivation("s1", "task-b");
  });

  it("a worker's activation never changes the parent or a sibling", () => {
    expect(activeSkillModel("s1", parent).model).toBe("base");
    activateSkill("s1", skill("worker-model"), "task-a");
    // Parent and sibling still see the base model.
    expect(activeSkillModel("s1", parent).model).toBe("base");
    expect(activeSkillModel("s1", parent, "task-b").model).toBe("base");
    // Only the activating worker sees its model.
    expect(activeSkillModel("s1", parent, "task-a").model).toBe("worker-model");
  });

  it("clearing one scope leaves the parent's root activation intact", () => {
    activateSkill("s1", skill("root-model"));
    activateSkill("s1", skill("worker-model"), "task-a");
    clearSkillActivation("s1", "task-a");
    expect(activeSkillModel("s1", parent).model).toBe("root-model");
  });
});
