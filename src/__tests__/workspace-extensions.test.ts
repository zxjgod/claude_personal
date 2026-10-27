import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspaceExtensions, reloadWorkspaceExtensions } from "../cli-tools.js";
import { getCustomCommand, resetCustomCommands } from "../commands/loadCommandsDir.js";
import { getSkill, resetSkills } from "../skills.js";
import { getSubagentType, removeCustomSubagentTypes, type SubagentType } from "../subagents.js";

let temp: string;
let workspaceA: string;
let workspaceB: string;
let plugin: string;
let originalArgv: string[];
let originalConfigDir: string | undefined;

function writeCommand(root: string, name: string, body = name): void {
  const dir = path.join(root, ".claude", "commands");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), body);
}

function writeSkill(root: string, name: string): void {
  const dir = path.join(root, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\ndescription: ${name}\n---\n${name} body`);
}

function writeAgent(root: string, name: string): void {
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `${name} system prompt`);
}

function writeUserExtensions(configRoot: string): void {
  for (const [kind, name, file] of [
    ["commands", "UserCmd", "UserCmd.md"],
    ["agents", "UserAgent", "UserAgent.md"],
  ] as const) {
    const dir = path.join(configRoot, kind);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${name} body`);
  }
  const skillDir = path.join(configRoot, "skills", "UserSkill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\ndescription: UserSkill\n---\nUserSkill body",
  );
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-workspace-ext-"));
  workspaceA = path.join(temp, "a");
  workspaceB = path.join(temp, "b");
  plugin = path.join(temp, "explicit plugin");
  fs.mkdirSync(workspaceA, { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });
  originalArgv = process.argv;
  originalConfigDir = process.env.CCR_USER_CONFIG_DIR;
  process.env.CCR_USER_CONFIG_DIR = path.join(temp, "user-config");
  writeUserExtensions(process.env.CCR_USER_CONFIG_DIR);
  for (const [root, name] of [
    [workspaceA, "Old"],
    [workspaceB, "New"],
  ] as const) {
    writeCommand(root, `${name}Cmd`);
    writeSkill(root, `${name}Skill`);
    writeAgent(root, `${name}Agent`);
  }
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(
    path.join(plugin, "plugin.json"),
    JSON.stringify({ name: "plug", version: "1.0.0" }),
  );
  writeCommand(plugin, "PlugCmd");
  writeSkill(plugin, "PlugSkill");
  writeAgent(plugin, "PlugAgent");
  process.argv = [...originalArgv, "--plugin-dir", plugin];
});

afterEach(() => {
  process.argv = originalArgv;
  if (originalConfigDir === undefined) delete process.env.CCR_USER_CONFIG_DIR;
  else process.env.CCR_USER_CONFIG_DIR = originalConfigDir;
  resetCustomCommands();
  resetSkills();
  removeCustomSubagentTypes();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("workspace extension reload", () => {
  it("drops old project entries and restores user, explicit-plugin, and inline sources", () => {
    const inline: SubagentType = {
      name: "inline",
      description: "session inline",
      toolNames: [],
      systemPrompt: "inline prompt",
    };
    loadWorkspaceExtensions(workspaceA, { announce: false, preserveAgents: [inline] });
    expect(getCustomCommand("oldcmd")).toBeDefined();
    expect(getSkill("oldskill")).toBeDefined();
    expect(getSubagentType("OldAgent")).toBeDefined();

    reloadWorkspaceExtensions(workspaceB, { announce: false, preserveAgents: [inline] });

    expect(getCustomCommand("oldcmd")).toBeUndefined();
    expect(getSkill("oldskill")).toBeUndefined();
    expect(getSubagentType("OldAgent")).toBeUndefined();
    expect(getCustomCommand("NEWCMD")?.name).toBe("NewCmd");
    expect(getSkill("NEWSKILL")?.name).toBe("NewSkill");
    expect(getSubagentType("NewAgent")?.systemPrompt).toBe("NewAgent system prompt");

    expect(getCustomCommand("usercmd")).toBeDefined();
    expect(getSkill("userskill")).toBeDefined();
    expect(getSubagentType("UserAgent")).toBeDefined();
    expect(getCustomCommand("plug:plugcmd")).toBeDefined();
    expect(getSkill("plug:plugskill")).toBeDefined();
    expect(getSubagentType("plug:PlugAgent")).toBeDefined();
    expect(getSubagentType("inline")).toEqual(inline);
    expect(getSkill("deep-research")).toBeDefined();
    expect(getSubagentType("general")?.source).toBe("built-in");
  });
});
