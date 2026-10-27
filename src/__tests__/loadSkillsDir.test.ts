// ============================================================
// Tests: Disk SKILL.md loader — frontmatter, ${VAR}, !`shell`, trust (M37)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandSkillBody, loadSkillsDir, parseFrontmatter } from "../skills/loadSkillsDir.js";
import { getSkill, resetSkills, resolveSkillPrompt } from "../skills.js";

let repo: string;

function writeSkill(name: string, content: string) {
  const dir = path.join(repo, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
}

beforeEach(() => {
  resetSkills();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-skills-"));
  // Pin the user-scope skills root to an empty sandbox so the host machine's
  // real ~/.claude/skills can't leak into these assertions.
  process.env.CCR_USER_SKILLS_DIR = path.join(repo, "user-skills-empty");
});

afterEach(() => {
  resetSkills();
  delete process.env.CCR_USER_SKILLS_DIR;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  it("splits frontmatter from body and parses lists", () => {
    const { frontmatter, body } = parseFrontmatter(
      "---\nname: x\ndescription: hi\nallowedTools: [read, grep]\n---\nThe body here.",
    );
    expect(frontmatter.name).toBe("x");
    expect(frontmatter.description).toBe("hi");
    expect(frontmatter.allowedTools).toEqual(["read", "grep"]);
    expect(body).toBe("The body here.");
  });

  it("accepts an empty frontmatter block without changing body trimming", () => {
    expect(parseFrontmatter("---\n---\n  body  \n")).toEqual({
      frontmatter: {},
      body: "body",
    });
    expect(parseFrontmatter("---\r\n---\r\nbody")).toEqual({
      frontmatter: {},
      body: "body",
    });
  });

  it("still rejects malformed YAML in a frontmatter block", () => {
    expect(() => parseFrontmatter("---\nname: [unterminated\n---\nbody")).toThrow(
      "Invalid frontmatter:",
    );
  });

  it("treats a file with no frontmatter as a pure body", () => {
    const { frontmatter, body } = parseFrontmatter("just a body, no fences");
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe("just a body, no fences");
  });

  it("never writes into __proto__/constructor keys (review fix)", () => {
    // A YAML `__proto__:` scalar used to hit `frontmatter[key] = …`, which
    // mutates the object's PROTOTYPE instead of an own property.
    const { frontmatter } = parseFrontmatter("---\nname: x\n__proto__: 1\n---\nbody");
    expect(Object.getPrototypeOf(frontmatter)).toBe(Object.prototype);
    expect(frontmatter.name).toBe("x");
  });

  it("drops an invalid effort level instead of passing it through (review fix)", () => {
    fs.mkdirSync(path.join(repo, ".claude", "skills", "typo"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".claude", "skills", "typo", "SKILL.md"),
      "---\ndescription: d\neffort: hige\n---\nbody",
    );
    loadSkillsDir(repo);
    expect(getSkill("typo")?.effort).toBeUndefined();
  });
});

describe("expandSkillBody", () => {
  it("substitutes ${ARGUMENTS} and ${WORKSPACE}", async () => {
    const out = await expandSkillBody("args=${ARGUMENTS} ws=${WORKSPACE}", {
      args: "hello",
      workspaceRoot: "/tmp/ws",
      trustedShell: true,
    });
    expect(out).toBe("args=hello ws=/tmp/ws");
  });

  it("runs !`shell` for trusted sources", async () => {
    const out = await expandSkillBody("out=!`echo trusted`", {
      workspaceRoot: repo,
      trustedShell: true,
    });
    expect(out).toContain("trusted");
  });

  it("STRIPS !`shell` for untrusted sources (never executes)", async () => {
    const out = await expandSkillBody("before !`echo SHOULD_NOT_RUN` after", {
      workspaceRoot: repo,
      trustedShell: false,
    });
    expect(out).not.toContain("SHOULD_NOT_RUN");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });
});

describe("loadSkillsDir", () => {
  it("registers a disk skill with frontmatter config", () => {
    writeSkill(
      "release-notes",
      "---\nname: release-notes\ndescription: Draft notes\nwhenToUse: When cutting a release.\n---\nDraft notes for ${ARGUMENTS}.",
    );
    const loaded = loadSkillsDir(repo);
    expect(loaded).toContain("release-notes");
    const skill = getSkill("release-notes")!;
    expect(skill.source).toBe("disk");
    expect(skill.whenToUse).toContain("release");
  });

  it("keeps the body lazy and expands ${ARGUMENTS} at resolution", async () => {
    writeSkill("greet", "---\nname: greet\ndescription: greet\n---\nHello ${ARGUMENTS}!");
    loadSkillsDir(repo);
    const out = await resolveSkillPrompt(getSkill("greet")!, {
      args: "world",
      workspaceRoot: repo,
    });
    expect(out).toContain("Hello world!");
  });

  it("parses context:fork and allowedTools from frontmatter", () => {
    writeSkill(
      "audit",
      "---\nname: audit\ndescription: audit\ncontext: fork\nagent: code-explorer\nallowedTools: [read, grep]\n---\nAudit it.",
    );
    loadSkillsDir(repo);
    const skill = getSkill("audit")!;
    expect(skill.context).toBe("fork");
    expect(skill.agent).toBe("code-explorer");
    expect(skill.allowedTools).toEqual(["read", "grep"]);
  });

  it("ignores directories without a SKILL.md", () => {
    fs.mkdirSync(path.join(repo, ".claude", "skills", "empty"), { recursive: true });
    const loaded = loadSkillsDir(repo);
    expect(loaded).not.toContain("empty");
  });

  it("returns empty when the skills root is absent", () => {
    const loaded = loadSkillsDir(path.join(repo, "nonexistent"));
    expect(loaded).toEqual([]);
  });

  describe("grant/hook trust tier", () => {
    const HOOKED =
      "---\nname: hooked\ndescription: d\nallowed-tools: [bash]\nhooks:\n  pre: echo hi\n---\nBody.";

    it("does NOT grant auto-approval or hooks to project-scope skills", () => {
      writeSkill("hooked", HOOKED);
      loadSkillsDir(repo);
      const skill = getSkill("hooked")!;
      expect(skill.allowedTools).toEqual(["bash"]); // restriction still works
      expect(skill.toolPermissionGrant).toBe(false);
      expect(skill.hooks).toBeUndefined();
    });

    it("grants auto-approval and hooks to user-scope skills", () => {
      const userRoot = process.env.CCR_USER_SKILLS_DIR!;
      const dir = path.join(userRoot, "hooked");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), HOOKED);
      loadSkillsDir(repo);
      const skill = getSkill("hooked")!;
      expect(skill.toolPermissionGrant).toBe(true);
      expect(skill.hooks).toBeDefined();
    });
  });
});
