import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadAgentsDir } from "../agents/loadAgentsDir.js";
import { pluginComponentRoots, readManifest } from "../plugins.js";
import { runForkSkill } from "../skills/forkSkill.js";
import { loadSkillsDir } from "../skills/loadSkillsDir.js";
import { getSkill, renderSkillCatalog, resetSkills } from "../skills.js";
import { getSubagentType, resolveSubagentTools, setCoreToolsForSubagents } from "../subagents.js";
import { buildTool } from "../tools/registry.js";

const fixture = vi.hoisted(() => ({ models: [] as string[] }));
vi.mock("../llm-adapter.js", () => ({
  createModelCaller: (config: { model: string }) =>
    async function* () {
      fixture.models.push(config.model);
      yield { type: "text_delta", delta: "done" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    },
}));
let root: string;
function write(file: string, body: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-extension-"));
  vi.stubEnv("CCR_USER_CONFIG_DIR", path.join(root, "user"));
  resetSkills();
  fixture.models.length = 0;
});
afterEach(() => {
  resetSkills();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it("interprets standard YAML skill controls and uses the fork model instead of the parent's model", async () => {
  write(
    ".claude/skills/review/SKILL.md",
    "---\nname: review\ndescription: review\ndisable-model-invocation: true\nuser-invocable: true\ncontext: fork\nmodel: child-model\nallowed-tools:\n  - Read\n---\nReview $ARGUMENTS",
  );
  loadSkillsDir(root);
  const skill = getSkill("review")!;
  expect(renderSkillCatalog().text).not.toContain("- review:");
  expect(await skill.getPromptForCommand({ args: "fixture", workspaceRoot: root })).toBe(
    "Review fixture",
  );
  setCoreToolsForSubagents([]);
  const result = await runForkSkill(skill, "review", {
    workspaceRoot: root,
    sessionId: "extension-model",
    permissionMode: "plan",
    modelConfig: { provider: "custom", model: "parent-model", apiKey: "unused" },
  });
  expect(result.error).toBeUndefined();
  expect(fixture.models).toEqual(["child-model"]);
});
it("loads nested agents and maps official tools while preserving omitted-tool inheritance", () => {
  write(
    ".claude/agents/nested/reader.md",
    "---\nname: reader\ndescription: read\ntools: Read, Grep\n---\nRead",
  );
  write(".claude/agents/inherited.md", "---\nname: inherited\ndisallowedTools: Write\n---\nRead");
  loadAgentsDir(root);
  const read = buildTool({
    name: "read",
    description: "fixture",
    promptDescription: "fixture",
    schema: z.object({}),
    isReadOnly: true,
    call: async () => ({ content: "" }),
  });
  expect(resolveSubagentTools(getSubagentType("reader")!, [read])).toEqual([read]);
  expect(resolveSubagentTools(getSubagentType("inherited")!, [read])).toEqual([read]);
});
it("loads standard plugin layouts under distinct namespaces", () => {
  for (const name of ["first", "second"]) {
    write(`${name}/.claude-plugin/plugin.json`, JSON.stringify({ name, version: "1.0.0" }));
    write(`${name}/skills/review/SKILL.md`, `---\nname: review\n---\n${name}`);
    const directory = path.join(root, name);
    expect(readManifest(directory)?.name).toBe(name);
    loadSkillsDir(directory, { roots: pluginComponentRoots(directory, "skills"), namespace: name });
  }
  expect(getSkill("first:review")).toBeDefined();
  expect(getSkill("second:review")).toBeDefined();
  expect(getSkill("review")).toBeUndefined();
});
