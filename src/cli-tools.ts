// ============================================================
// CLI tool wiring — build the ToolRegistry: core tools, disk
// skills/commands/agents, MCP servers (with interactive trust
// gating), MCP resource tools, and ToolSearch.
// ============================================================

import * as path from "node:path";
import chalk from "chalk";

import { loadAgentsDir } from "./agents/loadAgentsDir.js";
// cli-prompts.js pulls the TUI render chain (markdown -> highlight.js,
// ~200 files); the only use here is a TTY-guarded trust prompt, so it is
// dynamic-imported inside the callback to keep headless startups light.
import {
  parseBriefFlag,
  parseDisableSlashCommands,
  parseToolsSelection,
  type ToolsSelection,
  toolAllowed,
} from "./cli-session-flags.js";
import { loadCommandsDir, resetCustomCommands } from "./commands/loadCommandsDir.js";
import { readSettings } from "./hooks-config.js";
import { discoverMCPConfigs, MCPManager } from "./mcp/index.js";
import { pluginComponentRoots, pluginDirs, readManifest } from "./plugins.js";
import { loadSkillsDir } from "./skills/loadSkillsDir.js";
import { resetSkills } from "./skills.js";
import {
  AGENT_DESCRIPTION_TOKEN_LIMIT,
  agentDescriptionTokens,
  applyDisableExplorePlanEnv,
  registerSubagentType,
  removeCustomSubagentTypes,
  type SubagentType,
  setCoreToolsForSubagents,
} from "./subagents.js";
import { createMcpResourceTools, createToolSearchTool } from "./tools/breadth/index.js";
import { AgentTool, buildAgentPromptDescription } from "./tools/extended/agent.js";
import { SendUserMessageTool } from "./tools/extended/send-user-message.js";
import { buildTaskPromptDescription, TaskTool } from "./tools/extended/task.js";
import { CORE_TOOLS } from "./tools/index.js";
import { ToolRegistry } from "./tools/registry.js";
import { canonicalToolKey } from "./tools/utils/official-names.js";
import { sanitizeTerminalText } from "./tui/terminal-width.js";
import type { Tool } from "./types.js";

export interface ToolSetup {
  toolRegistry: ToolRegistry;
  mcpManager: MCPManager;
  /** /tools listing — derived from the registry, single source of truth. */
  toolSources: ReturnType<ToolRegistry["listSources"]>;
  /** The enabled tool set handed to the agent loop. */
  tools: Tool[];
}

/**
 * Apply the official `--tools <list>` restriction.
 *
 * Tools are UNREGISTERED rather than filtered at call time, so the registry,
 * the stable live array, the sub-agent tool set and the system prompt's
 * AVAILABLE TOOLS block all describe the same set by construction (the same
 * invariant the MCP refresh path relies on). Re-run after every MCP tool-set
 * change, otherwise a reconnect would resurrect tools the user removed.
 */
function applyToolSelection(registry: ToolRegistry, selection: ToolsSelection | undefined): void {
  if (!selection) return;
  for (const { tool } of registry.listSources()) {
    if (!toolAllowed(selection, tool.name)) registry.unregister(tool.name);
  }
}

/** `--tools` applied to a candidate list (used for the sub-agent tool set). */
function allowedTools(tools: Tool[], selection: ToolsSelection | undefined): Tool[] {
  return selection ? tools.filter((tool) => toolAllowed(selection, tool.name)) : tools;
}

export interface WorkspaceExtensionLoadOptions {
  customizations?: boolean;
  skillsDisabled?: boolean;
  /** Reapply session-scoped inline agents after disk/plugin registration. */
  preserveAgents?: SubagentType[];
  /** Print the same discovery summaries used during startup. */
  announce?: boolean;
}

/** Load user, workspace, and explicitly selected plugin extensions. */
export function loadWorkspaceExtensions(
  workspaceRoot: string,
  options: WorkspaceExtensionLoadOptions = {},
): { skills: string[]; commands: string[]; agents: string[] } {
  const customizations =
    options.customizations ??
    (!process.argv.includes("--safe-mode") && !process.argv.includes("--bare"));
  const skillsDisabled = options.skillsDisabled ?? parseDisableSlashCommands(process.argv);
  const announce = options.announce ?? true;
  const loadedSkills: string[] = [];
  const loadedCommands: string[] = [];
  const loadedAgents: string[] = [];

  try {
    const loaded = customizations && !skillsDisabled ? loadSkillsDir(workspaceRoot) : [];
    loadedSkills.push(...loaded);
    if (announce && loaded.length > 0) {
      console.log(
        chalk.gray(
          `Loaded ${loaded.length} disk skill(s): ${loaded.map(sanitizeTerminalText).join(", ")}`,
        ),
      );
    }
  } catch {
    // Disk skills are optional; a malformed skills dir never blocks startup.
  }

  for (const dir of customizations ? pluginDirs(workspaceRoot) : []) {
    const namespace = readManifest(dir)?.name;
    try {
      if (!skillsDisabled)
        loadedSkills.push(
          ...loadSkillsDir(dir, { roots: pluginComponentRoots(dir, "skills"), namespace }),
        );
    } catch {
      /* malformed plugin is isolated */
    }
    try {
      loadedCommands.push(
        ...loadCommandsDir(dir, { roots: pluginComponentRoots(dir, "commands"), namespace }),
      );
    } catch {
      /* optional */
    }
    try {
      loadedAgents.push(
        ...loadAgentsDir(dir, { roots: pluginComponentRoots(dir, "agents"), namespace }),
      );
    } catch {
      /* optional */
    }
  }

  try {
    const loaded = customizations ? loadCommandsDir(workspaceRoot) : [];
    loadedCommands.push(...loaded);
    if (announce && loaded.length > 0) {
      console.log(chalk.gray(`Loaded ${loaded.length} custom command(s): ${loaded.join(", ")}`));
    }
  } catch {
    // Custom commands are optional; a malformed commands dir never blocks startup.
  }

  try {
    const loaded = customizations ? loadAgentsDir(workspaceRoot) : [];
    loadedAgents.push(...loaded);
    if (announce && loaded.length > 0) {
      console.log(chalk.gray(`Loaded ${loaded.length} custom agent(s): ${loaded.join(", ")}`));
    }
  } catch {
    // Custom agents are optional; a malformed agents dir never blocks startup.
  }

  // CLI inline agents are session-scoped and more explicit than disk agents.
  for (const agent of options.preserveAgents ?? []) registerSubagentType(agent);

  try {
    const removed = applyDisableExplorePlanEnv();
    if (announce && removed.length > 0) {
      console.log(
        chalk.gray(
          `Disabled built-in agent(s) per CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: ${removed.join(", ")}`,
        ),
      );
    }
  } catch {
    // Advisory only.
  }

  try {
    const descTokens = agentDescriptionTokens();
    if (announce && descTokens > AGENT_DESCRIPTION_TOKEN_LIMIT) {
      console.log(
        chalk.yellow(
          `Large agent descriptions (~${descTokens.toLocaleString()} tokens > ` +
            `${AGENT_DESCRIPTION_TOKEN_LIMIT.toLocaleString()}) — trim agent descriptions ` +
            `in .claude/agents/`,
        ),
      );
    }
  } catch {
    // Advisory only.
  }

  try {
    const lean = agentDescriptionTokens() > AGENT_DESCRIPTION_TOKEN_LIMIT;
    TaskTool.promptDescription = buildTaskPromptDescription(lean);
    AgentTool.promptDescription = buildAgentPromptDescription(lean);
  } catch {
    // Descriptions are cosmetic; never block startup.
  }

  return { skills: loadedSkills, commands: loadedCommands, agents: loadedAgents };
}

/** Rebuild all disk-backed registries when the active workspace changes. */
export function reloadWorkspaceExtensions(
  workspaceRoot: string,
  options: WorkspaceExtensionLoadOptions = {},
): { skills: string[]; commands: string[]; agents: string[] } {
  resetCustomCommands();
  resetSkills();
  removeCustomSubagentTypes();
  return loadWorkspaceExtensions(workspaceRoot, options);
}

export async function setupTools(deps: {
  workspaceRoot: string;
  verbose: boolean;
}): Promise<ToolSetup> {
  const { workspaceRoot, verbose } = deps;
  const customizations = !process.argv.includes("--safe-mode") && !process.argv.includes("--bare");
  // Official `--disable-slash-commands` ("Disable all skills"). Only disk and
  // plugin skills are suppressed — built-in slash commands and MCP-provided
  // prompts are not skills, so they stay available.
  const skillsDisabled = parseDisableSlashCommands(process.argv);
  // Official `--tools`: restrict the session to a named subset. Names are
  // compared through the shared canonical mapping, so `Read`, `read` and
  // `READ` all select the same tool.
  const toolSelection = parseToolsSelection(process.argv);

  const toolRegistry = new ToolRegistry();
  for (const tool of CORE_TOOLS) {
    toolRegistry.register(tool, "core");
  }
  // 16.9: inject the core tool set into the subagents registry so sub-agent
  // loops (Task/Team) resolve tool names without dynamically importing
  // tools.ts (which would re-enter the tools.ts → TaskTool → tools.ts cycle).
  setCoreToolsForSubagents(CORE_TOOLS);

  loadWorkspaceExtensions(workspaceRoot, { customizations, skillsDisabled });

  // MCP Setup
  const mcpManager = new MCPManager();
  // Official `disabledMcpjsonServers` (settings.json): skip those servers by
  // name across every discovered mcp.json — they neither connect nor trigger
  // the project-config trust prompt.
  const mergedSettings = readSettings(workspaceRoot);
  const disabledMcpServers = new Set(
    (Array.isArray(mergedSettings.disabledMcpjsonServers)
      ? mergedSettings.disabledMcpjsonServers
      : []
    ).filter((n): n is string => typeof n === "string"),
  );
  const mcpConfigs = discoverMCPConfigs(workspaceRoot);
  for (const cfg of mcpConfigs) {
    // Trust gate binds on the discovery SCOPE, not a path string comparison
    // (the old comparison never matched the discovered location, leaving the
    // gate dead — Top10 #1). Project configs travel with cloned repos and can
    // spawn arbitrary stdio commands, so they require a fingerprint-trust
    // confirmation; plugin configs are install-is-trust (see McpConfigScope).
    const gated = cfg.scope === "project";
    await mcpManager.loadConfig(cfg.path, {
      namespace:
        cfg.scope === "plugin"
          ? readManifest(
              pluginDirs(workspaceRoot).find((dir) => cfg.path.startsWith(`${dir}${path.sep}`)) ??
                "",
            )?.name
          : undefined,
      requireTrust: gated,
      disabledServers: disabledMcpServers,
      confirm:
        gated && process.stdin.isTTY && process.stdout.isTTY
          ? async (descriptions) => {
              console.log(
                chalk.yellow(
                  "\nThis project defines MCP servers that can execute external actions:",
                ),
              );
              for (const description of descriptions) console.log(chalk.gray(`   ${description}`));
              return (await import("./cli-prompts.js")).askYesNo(
                "Trust and enable these project MCP servers? [y/N] ",
              );
            }
          : undefined,
    });
  }
  for (const dir of customizations ? pluginDirs(workspaceRoot) : []) {
    const manifest = readManifest(dir);
    if (manifest?.mcpServers && typeof manifest.mcpServers === "object") {
      for (const [name, config] of Object.entries(manifest.mcpServers))
        await mcpManager.connectServer(
          `${manifest.name}__${name}`,
          config as import("./mcp/index.js").MCPServerConfig,
        );
    }
  }
  for (const mcpTool of mcpManager.getAllTools()) {
    toolRegistry.register(mcpTool, "mcp");
  }
  // S3: sub-agents resolve their toolNames against the injected set — re-set
  // it now that MCP discovery has run, so a type declaring `mcp__*` (or an
  // explicit mcp__server__tool name) actually receives those tools.
  setCoreToolsForSubagents([...CORE_TOOLS, ...mcpManager.getAllTools()]);

  // MCP resource tools (8.6) — list/read resources from connected servers.
  for (const resTool of createMcpResourceTools(mcpManager)) {
    toolRegistry.register(resTool, "core");
  }

  // Official `--brief`: the SendUserMessage tool, and ONLY under the flag —
  // a default session must not advertise a channel the user did not ask for.
  // Registered before ToolSearch so the search index covers it, and before
  // `--tools` is applied, so `--tools Read,SendUserMessage` can restrict to it.
  if (parseBriefFlag(process.argv)) toolRegistry.register(SendUserMessageTool, "core");

  // ToolSearch (8.5) registered last so it can see the full tool set.
  const toolSearchTool = createToolSearchTool(() => toolRegistry.getEnabledTools());
  toolRegistry.register(toolSearchTool, "core");

  // `--tools` applied only now, so the unknown-name report below can compare
  // the request against everything this session actually discovered.
  if (toolSelection?.kind === "allow") {
    const available = new Set(
      toolRegistry.listSources().map((entry) => canonicalToolKey(entry.tool.name)),
    );
    const unknown = [
      ...new Set(
        toolSelection.requested
          .filter((name) => !available.has(canonicalToolKey(name)))
          .map((name) => name.trim()),
      ),
    ];
    if (unknown.length > 0) {
      console.warn(
        chalk.yellow(`Warning: --tools names no available tool: ${unknown.join(", ")} (ignored).`),
      );
    }
  }
  applyToolSelection(toolRegistry, toolSelection);
  setCoreToolsForSubagents(
    allowedTools([...CORE_TOOLS, ...mcpManager.getAllTools()], toolSelection),
  );
  if (toolSelection) {
    console.log(
      chalk.gray(
        toolSelection.kind === "none"
          ? 'Tools: none (--tools "")'
          : `Tools: ${toolRegistry.enabledCount} selected by --tools`,
      ),
    );
  }

  // The live tool array the session runs on. Built once here; S2 keeps its
  // CONTENTS fresh on MCP tool-set changes while preserving the array identity
  // the TUI/REPL/agent loop hold.
  const tools = toolRegistry.getEnabledTools();
  mcpManager.onToolsChanged(() => {
    // Capture the full incoming set BEFORE touching the registry (getAllTools
    // is deduped by name, so the re-register loop below cannot throw on a
    // hostile/broken server listing) — a failure partway through must not
    // leave registry, live array and sub-agent set diverged.
    const incoming = mcpManager.getAllTools();
    for (const { tool, source } of toolRegistry.listSources()) {
      if (source === "mcp") toolRegistry.unregister(tool.name);
    }
    for (const mcpTool of incoming) toolRegistry.register(mcpTool, "mcp");
    // Re-set the sub-agent injection set so `mcp__*` types follow the change,
    // then re-apply `--tools`: a server that reconnects must not resurrect
    // tools the user removed for this session.
    applyToolSelection(toolRegistry, toolSelection);
    setCoreToolsForSubagents(allowedTools([...CORE_TOOLS, ...incoming], toolSelection));
    tools.length = 0;
    tools.push(...toolRegistry.getEnabledTools());
  });

  if (verbose) {
    console.log(`Tools loaded: ${toolRegistry.enabledCount}`);
    if (mcpManager.serverCount > 0) {
      console.log(`MCP servers:  ${mcpManager.serverCount}`);
    }
    console.log("");
  }

  return {
    toolRegistry,
    mcpManager,
    get toolSources() {
      return toolRegistry.listSources();
    },
    tools,
  };
}
