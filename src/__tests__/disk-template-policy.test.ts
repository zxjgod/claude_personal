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

  // Policy inversion (Top10 #2, user decision 2026-09 install-is-trust):
  // project templates are trusted like user templates. The old `index === 0`
  // heuristic made this env-dependent — with CCR_USER_* stubbed (as here) the
  // project root landed at index 1 and was silently prompt-only, contradicting
  // the default-environment behavior. Trusted-ness must not depend on roots
  // order anymore.
  it.each([
    "skill",
    "command",
  ])("project %s overrides are trusted like user templates", async (kind) => {
    const writeTemplate = (dir: string, file: string, marker: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, file),
        `${marker} Text \${ARGUMENTS}: !\`version-tool\` \${CCR_TEMPLATE_TEST_VALUE}`,
      );
    };
    if (kind === "skill") {
      writeTemplate(path.join(root, "user-skills", "sample"), "SKILL.md", "user-marker");
      writeTemplate(path.join(root, ".claude", "skills", "sample"), "SKILL.md", "project-marker");
      loadSkillsDir(root);
    } else {
      writeTemplate(path.join(root, "user-commands"), "sample.md", "user-marker");
      writeTemplate(path.join(root, ".claude", "commands"), "sample.md", "project-marker");
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
    // Project template wins the override AND expands fully.
    expect(output).toContain("project-marker Text hello");
    expect(output).not.toContain("user-marker");
    expect(output).toContain("sample-output"); // !`cmd` executed
    expect(output).toContain("sample-environment-value"); // ${ENV} expanded
    expect(output).not.toContain("shell expansion disabled");
    expect(execution).toHaveBeenCalledOnce();
  });

  it("keeps the trustedShell gate functional for explicit untrusted callers", async () => {
    // Defense-in-depth: callers passing trustedShell:false still get prompt-only
    // behavior with the honest rejection marker.
    const shellOut = await expandDiskTemplate("!`version-tool`", {
      trustedShell: false,
      workspaceRoot: root,
    });
    expect(shellOut).toContain("shell expansion disabled: untrusted template source");
    expect(execution).not.toHaveBeenCalled();
    const envOut = await expandDiskTemplate("${CCR_TEMPLATE_TEST_VALUE}", {
      trustedShell: false,
      workspaceRoot: root,
    });
    expect(envOut).toBe("");
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
