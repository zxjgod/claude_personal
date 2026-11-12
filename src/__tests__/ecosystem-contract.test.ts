import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig } from "../cli-config.js";
import { reloadWorkspaceExtensions, setupTools } from "../cli-tools.js";
import { getCustomCommand, resetCustomCommands } from "../commands/loadCommandsDir.js";
import { warnUnknownSettings } from "../hooks-config.js";
import { discoverMCPConfigs } from "../mcp/index.js";
import { loadProjectInstructions, renderInstructions } from "../project-instructions.js";
import { readSettings, userConfigRoot } from "../settings.js";
import { getSkill, resetSkills, resolveSkillPrompt } from "../skills.js";
import { getSubagentType, removeCustomSubagentTypes } from "../subagents.js";

let root: string;
let workspace: string;
let user: string;
let argv: string[];

function write(relative: string, content: unknown): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

function args(...values: string[]) {
  process.argv = [...argv.slice(0, 2), ...values];
}

async function skillBody(name: string) {
  const skill = getSkill(name);
  if (!skill) throw new Error(`Missing fixture skill: ${name}`);
  return resolveSkillPrompt(skill);
}

async function commandBody(name: string) {
  const command = getCustomCommand(name);
  if (!command) throw new Error(`Missing fixture command: ${name}`);
  return command.run("", {
    workspaceRoot: workspace,
    messages: [],
    sessionId: "ecosystem-command",
    modelConfig: { provider: "custom", model: "fixture", apiKey: "fixture-unused" },
    callModel: () => {
      throw new Error("fixture must not call a model");
    },
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-ecosystem-"));
  workspace = path.join(root, "project");
  user = path.join(root, "user");
  fs.mkdirSync(workspace);
  fs.mkdirSync(user);
  argv = process.argv;
  args();
  vi.stubEnv("WORKSPACE_ROOT", workspace);
  vi.stubEnv("CCR_USER_CONFIG_DIR", user);
  vi.stubEnv("CCR_COMPAT_CLAUDE", undefined);
  vi.stubEnv("CCR_SETTING_SOURCES", undefined);
  vi.stubEnv("CCR_MANAGED_SETTINGS", undefined);
  vi.stubEnv("CCR_ECOSYSTEM_NOTE", undefined);
  vi.stubEnv("CCR_USER_SKILLS_DIR", undefined);
  vi.stubEnv("CCR_USER_AGENTS_DIR", undefined);
  vi.stubEnv("CCR_USER_COMMANDS_DIR", undefined);
  vi.stubEnv("LLM_API_KEY", "fixture-unused");
  vi.stubEnv("LLM_PROVIDER", "custom");
  vi.stubEnv("LLM_MODEL", "fixture");
  vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:1/v1");
});

afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetCustomCommands();
  resetSkills();
  removeCustomSubagentTypes();
  fs.rmSync(root, { recursive: true, force: true });
});

it("uses its independent user root by default and requires an explicit compatibility opt-in", () => {
  vi.stubEnv("CCR_USER_CONFIG_DIR", undefined);
  expect(userConfigRoot()).toBe(path.join(os.homedir(), ".claude-code-replica"));
  vi.stubEnv("CCR_COMPAT_CLAUDE", "1");
  expect(userConfigRoot()).toBe(path.join(os.homedir(), ".claude"));
  vi.stubEnv("CCR_USER_CONFIG_DIR", user);
  expect(userConfigRoot()).toBe(user);
});

it("merges enabled settings sources below explicit and managed settings", () => {
  write("user/settings.json", { model: "user", permissions: { deny: ["Read"] } });
  write("project/.claude/settings.json", { model: "project", permissions: { deny: ["Write"] } });
  write("project/.claude/settings.local.json", { model: "local", permissions: { deny: ["Edit"] } });
  const managed = write("managed.json", { model: "managed", permissions: { deny: ["Bash"] } });
  vi.stubEnv("CCR_MANAGED_SETTINGS", managed);
  args("--settings", JSON.stringify({ model: "explicit", permissions: { deny: ["Glob"] } }));
  expect(readSettings(workspace)).toMatchObject({
    model: "managed",
    permissions: { deny: ["Read", "Write", "Edit", "Glob", "Bash"] },
  });
  args("--setting-sources", "local,project");
  expect(readSettings(workspace).permissions).toEqual({ deny: ["Write", "Edit", "Bash"] });
});

it("does not apply a disabled user settings environment or a project environment", () => {
  write("user/settings.json", { env: { CCR_ECOSYSTEM_NOTE: "user" } });
  write("project/.claude/settings.json", { env: { CCR_ECOSYSTEM_NOTE: "project" } });
  args("--setting-sources", "project");
  loadConfig();
  expect(process.env.CCR_ECOSYSTEM_NOTE).toBeUndefined();
});

it.each(["inline", "file"])("applies the explicit %s settings environment", (kind) => {
  write("user/settings.json", { env: { CCR_ECOSYSTEM_NOTE: "user" } });
  const explicit = { env: { CCR_ECOSYSTEM_NOTE: "explicit" } };
  const file = write("explicit.json", explicit);
  args("--settings", kind === "inline" ? JSON.stringify(explicit) : file);
  loadConfig();
  expect(process.env.CCR_ECOSYSTEM_NOTE).toBe("explicit");
});

it("keeps managed settings above explicit env and keeps existing process env above both", () => {
  vi.stubEnv(
    "CCR_MANAGED_SETTINGS",
    write("managed.json", { env: { CCR_ECOSYSTEM_NOTE: "managed" } }),
  );
  args("--settings", JSON.stringify({ env: { CCR_ECOSYSTEM_NOTE: "explicit" } }));
  loadConfig();
  expect(process.env.CCR_ECOSYSTEM_NOTE).toBe("managed");
  vi.stubEnv("CCR_ECOSYSTEM_NOTE", "process");
  loadConfig();
  expect(process.env.CCR_ECOSYSTEM_NOTE).toBe("process");
});

it("can resolve a third-party provider from trusted settings credentials alone", () => {
  vi.stubEnv("LLM_API_KEY", undefined);
  args(
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ env: { LLM_API_KEY: "explicit-fixture-key" } }),
  );
  expect(loadConfig().apiKey).toBe("explicit-fixture-key");
});

it("keeps project extension precedence, plugin namespaces and inline agents across workspace reload", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  write("user/skills/review/SKILL.md", "---\nname: review\n---\nuser skill");
  write("project/.claude/skills/review/SKILL.md", "---\nname: review\n---\nproject skill");
  write("user/commands/check.md", "user command");
  write("project/.claude/commands/check.md", "project command");
  write("user/agents/reviewer.md", "user agent");
  write("project/.claude/agents/reviewer.md", "project agent");
  write("project/.claude/plugins/demo/plugin.json", { name: "demo", version: "1.0.0" });
  write("project/.claude/plugins/demo/skills/review/SKILL.md", "plugin skill");
  write("project/.claude/plugins/demo/commands/check.md", "plugin command");
  write("project/.claude/plugins/demo/agents/reviewer.md", "plugin agent");
  reloadWorkspaceExtensions(workspace, { announce: false });
  expect(await skillBody("review")).toContain("project skill");
  expect(await skillBody("demo:review")).toContain("plugin skill");
  expect(await commandBody("check")).toMatchObject({ prompt: "project command" });
  expect(await commandBody("demo:check")).toMatchObject({ prompt: "plugin command" });
  expect(getSubagentType("reviewer")?.systemPrompt).toBe("project agent");
  expect(getSubagentType("demo:reviewer")?.systemPrompt).toBe("plugin agent");
  const next = path.join(root, "next");
  fs.mkdirSync(next);
  reloadWorkspaceExtensions(next, {
    announce: false,
    preserveAgents: [
      {
        name: "session-only",
        description: "inline",
        systemPrompt: "inline",
        toolNames: [],
        maxTurns: 2,
      },
    ],
  });
  expect(getSkill("demo:review")).toBeUndefined();
  expect(getSubagentType("demo:reviewer")).toBeUndefined();
  expect(getCustomCommand("demo:check")).toBeUndefined();
  expect(await skillBody("review")).toContain("user skill");
  expect(getSubagentType("session-only")?.systemPrompt).toBe("inline");
});

it.each([false, true])("starts and calls the selected MCP source, strict=%s", async (strict) => {
  const fixture = path.resolve("src/__tests__/fixtures/mock-mcp-envtool-stdio-server.mjs");
  const server = {
    command: process.execPath,
    args: [fixture],
    env: { MOCK_MCP_TAG: "selected", MOCK_MCP_TOOL: "probe" },
  };
  write("project/.claude/plugins/demo/plugin.json", {
    name: "demo",
    version: "1.0.0",
    mcpServers: { probe: server },
  });
  if (strict) {
    const explicit = write("explicit-mcp.json", { mcpServers: { chosen: server } });
    args("--strict-mcp-config", "--mcp-config", explicit);
  }
  const tools = await setupTools({ workspaceRoot: workspace, verbose: false });
  try {
    expect(tools.mcpManager.serverCount).toBe(1);
    const tool = tools.tools.find(
      (item) => item.name === (strict ? "mcp__chosen__probe" : "mcp__demo__probe__probe"),
    );
    if (!tool) throw new Error("Selected MCP fixture tool is missing");
    const result = await tool.call(
      { message: "ping" },
      { workspaceRoot: workspace, sessionId: "ecosystem-mcp", permissionMode: "bypassPermissions" },
    );
    expect(result.content).toBe("selected:ping");
    expect(result.error).toBeUndefined();
  } finally {
    await tools.mcpManager.disconnectAll();
  }
});

it("loads its configured user instructions and reports unsupported settings without dropping known fields", () => {
  write("user/CLAUDE.md", "independent user instructions");
  write("project/AGENTS.md", "project instructions");
  const rendered = renderInstructions(loadProjectInstructions(workspace));
  expect(rendered).toContain("independent user instructions");
  expect(rendered).toContain("project instructions");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(
    warnUnknownSettings({ model: "fixture", env: {}, subagents: {}, misspelledModel: true }),
  ).toEqual(["misspelledModel"]);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("misspelledModel"));
});

it("discovers only explicit MCP configs under strict mode, and ignores project .mcp.json by default", () => {
  const explicit = write("explicit-mcp.json", { mcpServers: {} });
  const personal = write("user/mcp.json", { mcpServers: {} });
  const project = write("project/.claude/mcp.json", { mcpServers: {} });
  const official = write("project/.mcp.json", { mcpServers: {} });
  args("--mcp-config", explicit);
  expect(discoverMCPConfigs(workspace)).toEqual([
    { path: explicit, scope: "explicit" },
    { path: personal, scope: "user" },
    { path: project, scope: "project" },
  ]);
  args("--strict-mcp-config", "--mcp-config", explicit);
  expect(discoverMCPConfigs(workspace)).toEqual([{ path: explicit, scope: "explicit" }]);
  args();
  vi.stubEnv("CCR_COMPAT_CLAUDE", "1");
  expect(discoverMCPConfigs(workspace)).toContainEqual({ path: official, scope: "project" });
});

it.each([
  "strict",
  "disabled",
  "disabled-name",
  "invalid",
])("does not start a plugin inline MCP server excluded by %s", async (mode) => {
  const marker = path.join(root, "server-started");
  const fixture = pathToFileURL(
    path.resolve("src/__tests__/fixtures/mock-mcp-envtool-stdio-server.mjs"),
  ).href;
  const entry = write(
    "inline-server.mjs",
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');await import(${JSON.stringify(fixture)});`,
  );
  const server = {
    type: "stdio",
    command: process.execPath,
    args: [entry],
    ...(mode === "disabled" ? { disabled: true } : {}),
  };
  write("project/.claude/plugins/demo/plugin.json", {
    name: "demo",
    version: "1.0.0",
    mcpServers: { probe: mode === "invalid" ? null : server },
  });
  if (mode === "strict") args("--strict-mcp-config");
  if (mode === "disabled-name")
    write("project/.claude/settings.json", { disabledMcpjsonServers: ["probe"] });
  const tools = await setupTools({ workspaceRoot: workspace, verbose: false });
  try {
    expect(fs.existsSync(marker)).toBe(false);
    expect(tools.mcpManager.serverCount).toBe(0);
  } finally {
    await tools.mcpManager.disconnectAll();
  }
});
