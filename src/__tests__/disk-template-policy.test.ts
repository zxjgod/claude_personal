import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execution = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execution }));

import {
  getCustomCommands,
  loadCommandsDir,
  resetCustomCommands,
} from "../commands/loadCommandsDir.js";
import { loadSkillsDir } from "../skills/loadSkillsDir.js";
import { getSkill, resetSkills, resolveSkillPrompt } from "../skills.js";
import { expandDiskTemplate } from "../utils/disk-template.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-template-policy-"));
  vi.stubEnv("CCR_USER_SKILLS_DIR", path.join(root, "user-skills"));
  vi.stubEnv("CCR_USER_COMMANDS_DIR", path.join(root, "user-commands"));
  vi.stubEnv("CCR_TEMPLATE_TEST_VALUE", "sample-environment-value");
  execution.mockReset();
  execution.mockImplementation((_file, _args, _options, callback) =>
    callback(null, { stdout: "sample-output", stderr: "" }),
  );
});
afterEach(() => {
  resetSkills();
  resetCustomCommands();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("disk template trust policy", () => {
  it("preserves literal shell expansion in user-scope templates", async () => {
    const skillDir = path.join(root, "user-skills", "sample");
    const commandDir = path.join(root, "user-commands");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(commandDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "!`version-tool`");
    fs.writeFileSync(path.join(commandDir, "sample.md"), "!`version-tool`");
    loadSkillsDir(root);
    loadCommandsDir(root);
    expect(await resolveSkillPrompt(getSkill("sample")!, { workspaceRoot: root })).toBe(
      "sample-output",
    );
    expect(
      (
        await getCustomCommands()
          .get("sample")!
          .run("", { workspaceRoot: root } as never)
      )?.prompt,
    ).toBe("sample-output");
    expect(execution).toHaveBeenCalledTimes(2);
  });

  it.each(["skill", "command"])("keeps project %s overrides prompt-only", async (kind) => {
    const writeTemplate = (dir: string, file: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, file),
        "Text ${ARGUMENTS}: !`version-tool` ${CCR_TEMPLATE_TEST_VALUE}",
      );
    };
    if (kind === "skill") {
      writeTemplate(path.join(root, "user-skills", "sample"), "SKILL.md");
      writeTemplate(path.join(root, ".claude", "skills", "sample"), "SKILL.md");
      loadSkillsDir(root);
    } else {
      writeTemplate(path.join(root, "user-commands"), "sample.md");
      writeTemplate(path.join(root, ".claude", "commands"), "sample.md");
      loadCommandsDir(root);
    }
    const output =
      kind === "skill"
        ? await resolveSkillPrompt(getSkill("sample")!, { args: "hello", workspaceRoot: root })
        : (
            await getCustomCommands()
              .get("sample")!
              .run("hello", { workspaceRoot: root } as never)
          )?.prompt;
    expect(output).toContain("Text hello");
    expect(output).toContain("shell expansion disabled");
    expect(output).not.toContain("sample-environment-value");
    expect(execution).not.toHaveBeenCalled();
  });

  it("keeps argument values literal while allowing a trusted template's literal directive", async () => {
    const args = "literal ${WORKSPACE}";
    const output = await expandDiskTemplate("${ARGUMENTS} !`version-tool`", {
      args,
      trustedShell: true,
      workspaceRoot: root,
    });
    expect(output).toBe(`${args} sample-output`);
    expect(execution).toHaveBeenCalledOnce();
  });

  it("disables substitutions within shell directives", async () => {
    const output = await expandDiskTemplate("!`version-tool ${ARGUMENTS}`", {
      args: "hello",
      trustedShell: true,
      workspaceRoot: root,
    });
    expect(output).toContain("template substitutions in commands");
    expect(execution).not.toHaveBeenCalled();
  });
});
