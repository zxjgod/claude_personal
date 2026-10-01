// ============================================================
// CLI tool wiring — build the ToolRegistry: core tools, disk
// skills/commands/agents, MCP servers (with interactive trust
// gating), MCP resource tools, and ToolSearch.
// ============================================================

import chalk from "chalk";

import { loadAgentsDir } from "./agents/loadAgentsDir.js";
import { askYesNo } from "./cli-prompts.js";
import { loadCommandsDir } from "./commands.js";
import { discoverMCPConfigs, MCPManager } from "./mcp/index.js";
import { pluginDirs } from "./plugins.js";
import { loadSkillsDir } from "./skills/loadSkillsDir.js";
import { setCoreToolsForSubagents } from "./subagents.js";
import { createMcpResourceTools, createToolSearchTool } from "./tools/breadth/index.js";
import { CORE_TOOLS } from "./tools/index.js";
import { ToolRegistry } from "./tools/registry.js";
import type { Tool } from "./types.js";

export interface ToolSetup {
  toolRegistry: ToolRegistry;
  mcpManager: MCPManager;
  /** /tools listing — derived from the registry, single source of truth. */
  toolSources: ReturnType<ToolRegistry["listSources"]>;
  /** The enabled tool set handed to the agent loop. */
  tools: Tool[];
}

export async function setupTools(deps: {
  workspaceRoot: string;
  verbose: boolean;
}): Promise<ToolSetup> {
  const { workspaceRoot, verbose } = deps;

  const toolRegistry = new ToolRegistry();
  for (const tool of CORE_TOOLS) {
    toolRegistry.register(tool, "core");
  }
  // 16.9: inject the core tool set into the subagents registry so sub-agent
  // loops (Task/Team) resolve tool names without dynamically importing
  // tools.ts (which would re-enter the tools.ts → TaskTool → tools.ts cycle).
  setCoreToolsForSubagents(CORE_TOOLS);

  // M37: discover disk skills (<root>/.claude/skills/<name>/SKILL.md and the
  // user-level equivalent). Cheap — only frontmatter is read here; each skill's
  // body stays lazy until the Skill tool or /<name> sugar invokes it.
  try {
    const loaded = loadSkillsDir(workspaceRoot);
    if (loaded.length > 0) {
      console.log(chalk.gray(`Loaded ${loaded.length} disk skill(s): ${loaded.join(", ")}`));
    }
  } catch {
    // Disk skills are optional; a malformed skills dir never blocks startup.
  }
  // Plugin manifests are workspace-local. Their declared component folders
  // are copied into the same loaders, preserving one source of truth.
  for (const dir of pluginDirs(workspaceRoot)) {
    try {
      loadSkillsDir(dir);
    } catch {
      /* malformed plugin is isolated */
    }
    try {
      loadCommandsDir(dir);
    } catch {
      /* optional */
    }
    try {
      loadAgentsDir(dir);
    } catch {
      /* optional */
    }
  }

  // Custom slash commands (<root>/.claude/commands/<name>.md and the user-level
  // equivalent). Each file's body is a prompt template injected via /<name>.
  try {
    const loadedCommands = loadCommandsDir(workspaceRoot);
    if (loadedCommands.length > 0) {
      console.log(
        chalk.gray(
          `Loaded ${loadedCommands.length} custom command(s): ${loadedCommands.join(", ")}`,
        ),
      );
    }
  } catch {
    // Custom commands are optional; a malformed commands dir never blocks startup.
  }

  // Custom sub-agents (<root>/.claude/agents/<name>.md and the user-level
  // equivalent). Registered into the sub-agent type registry so the Task tool's
  // `subagent_name` enum and /agents pick them up.
  try {
    const loadedAgents = loadAgentsDir(workspaceRoot);
    if (loadedAgents.length > 0) {
      console.log(
        chalk.gray(`Loaded ${loadedAgents.length} custom agent(s): ${loadedAgents.join(", ")}`),
      );
    }
  } catch {
    // Custom agents are optional; a malformed agents dir never blocks startup.
  }

  // MCP Setup
  const mcpManager = new MCPManager();
  const mcpConfigs = discoverMCPConfigs(workspaceRoot);
  for (const cfg of mcpConfigs) {
    // Trust gate binds on the discovery SCOPE, not a path string comparison
    // (the old comparison never matched the discovered location, leaving the
    // gate dead — Top10 #1). Project configs travel with cloned repos and can
    // spawn arbitrary stdio commands, so they require a fingerprint-trust
    // confirmation; plugin configs are install-is-trust (see McpConfigScope).
    const gated = cfg.scope === "project";
    await mcpManager.loadConfig(cfg.path, {
      requireTrust: gated,
      confirm:
        gated && process.stdin.isTTY && process.stdout.isTTY
          ? async (descriptions) => {
              console.log(
                chalk.yellow(
                  "\nThis project defines MCP servers that can execute external actions:",
                ),
              );
              for (const description of descriptions) console.log(chalk.gray(`   ${description}`));
              return askYesNo("Trust and enable these project MCP servers? [y/N] ");
            }
          : undefined,
    });
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

  // ToolSearch (8.5) registered last so it can see the full tool set.
  const toolSearchTool = createToolSearchTool(() => toolRegistry.getEnabledTools());
  toolRegistry.register(toolSearchTool, "core");

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
    // Re-set the sub-agent injection set so `mcp__*` types follow the change.
    setCoreToolsForSubagents([...CORE_TOOLS, ...incoming]);
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
