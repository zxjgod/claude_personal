// ============================================================
// CLI tool wiring — build the ToolRegistry: core tools, disk
// skills/commands/agents, MCP servers (with interactive trust
// gating), MCP resource tools, and ToolSearch.
// ============================================================

import * as path from "node:path";
import chalk from "chalk";

import { loadAgentsDir } from "./agents/loadAgentsDir.js";
import { askYesNo } from "./cli-prompts.js";
import {
  parseBriefFlag,
  parseDisableSlashCommands,
  parseToolsSelection,
  type ToolsSelection,
  toolAllowed,
} from "./cli-session-flags.js";
import { loadCommandsDir } from "./commands.js";
import { readSettings } from "./hooks-config.js";
import { discoverMCPConfigs, MCPManager } from "./mcp/index.js";
import { pluginComponentRoots, pluginDirs, readManifest } from "./plugins.js";
import { loadSkillsDir } from "./skills/loadSkillsDir.js";
import {
  AGENT_DESCRIPTION_TOKEN_LIMIT,
  agentDescriptionTokens,
  applyDisableExplorePlanEnv,
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

  // M37: discover disk skills (<root>/.claude/skills/<name>/SKILL.md and the
  // user-level equivalent). Cheap — only frontmatter is read here; each skill's
  // body stays lazy until the Skill tool or /<name> sugar invokes it.
  try {
    const loaded = customizations && !skillsDisabled ? loadSkillsDir(workspaceRoot) : [];
    if (loaded.length > 0) {
      // Skill names are directory names on disk (project-untrusted) — sanitize.
      console.log(
        chalk.gray(
          `Loaded ${loaded.length} disk skill(s): ${loaded.map(sanitizeTerminalText).join(", ")}`,
        ),
      );
    }
  } catch {
    // Disk skills are optional; a malformed skills dir never blocks startup.
  }
  // Plugin manifests are workspace-local. Their declared component folders
  // are copied into the same loaders, preserving one source of truth.
  for (const dir of customizations ? pluginDirs(workspaceRoot) : []) {
    const namespace = readManifest(dir)?.name;
    try {
      if (!skillsDisabled)
        loadSkillsDir(dir, { roots: pluginComponentRoots(dir, "skills"), namespace });
    } catch {
      /* malformed plugin is isolated */
    }
    try {
      loadCommandsDir(dir, { roots: pluginComponentRoots(dir, "commands"), namespace });
    } catch {
      /* optional */
    }
    try {
      loadAgentsDir(dir, { roots: pluginComponentRoots(dir, "agents"), namespace });
    } catch {
      /* optional */
    }
  }

  // Custom slash commands (<root>/.claude/commands/<name>.md and the user-level
  // equivalent). Each file's body is a prompt template injected via /<name>.
  try {
    const loadedCommands = customizations ? loadCommandsDir(workspaceRoot) : [];
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
    const loadedAgents = customizations ? loadAgentsDir(workspaceRoot) : [];
    if (loadedAgents.length > 0) {
      console.log(
        chalk.gray(`Loaded ${loadedAgents.length} custom agent(s): ${loadedAgents.join(", ")}`),
      );
    }
  } catch {
    // Custom agents are optional; a malformed agents dir never blocks startup.
  }

  // Official CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS (2.1.202 wjr gate):
  // removes the built-in Explore/Plan agents. Runs AFTER disk agents load so a
  // same-named custom agent survives (only source==="built-in" is removed).
  try {
    const removed = applyDisableExplorePlanEnv();
    if (removed.length > 0) {
      console.log(
        chalk.gray(
          `Disabled built-in agent(s) per CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: ${removed.join(", ")}`,
        ),
      );
    }
  } catch {
    // Advisory only.
  }

  // Official parity (2.1.202): every custom agent's "name: whenToUse" hint
  // rides along in the Task/Agent tool prompt, so oversized descriptions tax
  // every session. Warn when the non-built-in total passes the 15k budget.
  try {
    const descTokens = agentDescriptionTokens();
    if (descTokens > AGENT_DESCRIPTION_TOKEN_LIMIT) {
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

  // Rebuild the Task/Agent tool descriptions now that disk agents are
  // registered — and in lean form (whenToUseLean) when the description budget
  // is blown (official Y$l). The adapter reads promptDescription per request,
  // so the new text takes effect immediately.
  try {
    const lean = agentDescriptionTokens() > AGENT_DESCRIPTION_TOKEN_LIMIT;
    TaskTool.promptDescription = buildTaskPromptDescription(lean);
    AgentTool.promptDescription = buildAgentPromptDescription(lean);
  } catch {
    // Descriptions are cosmetic; never block startup.
  }

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
              return askYesNo("Trust and enable these project MCP servers? [y/N] ");
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
