// ============================================================
// Tests: Disk sub-agent loader — frontmatter → SubagentType
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentsDir } from "../agents/loadAgentsDir.js";
import { getSubagentType, listSubagentNames } from "../subagents.js";

let repo: string;

function writeAgent(name: string, content: string) {
  const dir = path.join(repo, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-agents-"));
  // Pin the user-scope agents root to an empty sandbox.
  process.env.CCR_USER_AGENTS_DIR = path.join(repo, "user-agents-empty");
});

afterEach(() => {
  delete process.env.CCR_USER_AGENTS_DIR;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("loadAgentsDir", () => {
  it("registers agents with tools / maxTurns / memory / whenToUse", () => {
    writeAgent(
      "pr-reviewer",
      "---\nname: pr-reviewer\ndescription: Review a PR\nwhenToUse: On PR review\ntools: [read, grep]\nmaxTurns: 15\nmemory: project\n---\nYou review PRs carefully.",
    );
    const loaded = loadAgentsDir(repo);
    expect(loaded).toEqual(["pr-reviewer"]);

    const type = getSubagentType("pr-reviewer");
    expect(type).toBeDefined();
    expect(type!.description).toBe("Review a PR");
    expect(type!.whenToUse).toBe("On PR review");
    expect(type!.toolNames).toEqual(["read", "grep"]);
    expect(type!.maxTurns).toBe(15);
    expect(type!.memory).toBe("project");
    expect(type!.systemPrompt).toBe("You review PRs carefully.");
    expect(listSubagentNames()).toContain("pr-reviewer");
  });

  it("derives name from filename when frontmatter lacks one", () => {
    writeAgent("helper", "---\ndescription: a helper\n---\nBe helpful.");
    loadAgentsDir(repo);
    expect(getSubagentType("helper")?.description).toBe("a helper");
  });

  it("rejects an invalid memory scope", () => {
    writeAgent("badmem", "---\nmemory: wrong\n---\nbody");
    loadAgentsDir(repo);
    expect(getSubagentType("badmem")?.memory).toBeUndefined();
  });

  it("skips files without a body", () => {
    writeAgent("empty", "---\ndescription: nothing\n---\n");
    expect(loadAgentsDir(repo)).toEqual([]);
  });
});
