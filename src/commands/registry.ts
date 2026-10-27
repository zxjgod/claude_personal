// ============================================================
// Slash Commands — registry (M18 directory split)
// ============================================================
// index.ts assembles every command from src/commands/<name>.ts here.
// commands.ts re-exports this so existing imports (`from "./commands.js"`)
// keep working unchanged.
// ============================================================

import { listSkills } from "../skills.js";
import { addDirCommand } from "./add-dir.js";
import { agentsCommand } from "./agents.js";
// M18 new commands
import { branchCommand } from "./branch.js";
import { cdCommand } from "./cd.js";
import { clearCommand } from "./clear.js";
import { commitCommand } from "./commit.js";
import { compactCommand } from "./compact.js";
import { configCommand } from "./config.js";
import { contextCommand } from "./context.js";
import { copyCommand } from "./copy.js";
import { costCommand } from "./cost.js";
import { diffCommand } from "./diff.js";
import { doctorCommand } from "./doctor.js";
import { effortCommand } from "./effort.js";
import { exportCommand } from "./export.js";
import { forkCommand } from "./fork.js";
import { goalCommand } from "./goal.js";
import helpCommand, { bindCommandList } from "./help.js";
import { hooksCommand } from "./hooks.js";
import { initCommand } from "./init.js";
import { keybindingsCommand } from "./keybindings.js";
import { getCustomCommands } from "./loadCommandsDir.js";
import { loopCommand } from "./loop.js";
import { mcpCommand } from "./mcp.js";
import { memoryCommand } from "./memory.js";
import { memoryApprovalCommand } from "./memory-approval.js";
import { modeCommand } from "./mode.js";
import { modelCommand } from "./model.js";
import { onboardingCommand } from "./onboarding.js";
import { outputStyleCommand } from "./output-style.js";
import { permissionsCommand } from "./permissions.js";
import { pluginCommand } from "./plugin.js";
import { prCommand } from "./pr.js";
import { providerCommand } from "./provider.js";
import { recapCommand } from "./recap.js";
import { releaseNotesCommand } from "./release-notes.js";
import { resumeCommand } from "./resume.js";
import { reviewCommand } from "./review.js";
import { rewindCommand } from "./rewind.js";
import { scheduleCommand } from "./schedule.js";
import { sessionsCommand } from "./sessions.js";
import { shareCommand } from "./share.js";
import { skillsCommand } from "./skills.js";
import { statusCommand } from "./status.js";
import { themeCommand } from "./theme.js";
import { todosCommand } from "./todos.js";
import { tokensCommand } from "./tokens.js";
import { toolsCommand } from "./tools.js";
import type { CommandCatalogEntry, SlashCommand } from "./types.js";
import { usageCommand } from "./usage.js";
import { vimCommand } from "./vim.js";
import { workflowsCommand } from "./workflows.js";

/** All built-in slash commands, in display order. */
export const COMMANDS: SlashCommand[] = [
  helpCommand,
  clearCommand,
  modelCommand,
  compactCommand,
  tokensCommand,
  doctorCommand,
  sessionsCommand,
  resumeCommand,
  permissionsCommand,
  modeCommand,
  statusCommand,
  cdCommand,
  costCommand,
  toolsCommand,
  usageCommand,
  addDirCommand,
  todosCommand,
  contextCommand,
  configCommand,
  diffCommand,
  memoryCommand,
  memoryApprovalCommand,
  initCommand,
  effortCommand,
  commitCommand,
  prCommand,
  providerCommand,
  pluginCommand,
  agentsCommand,
  skillsCommand,
  exportCommand,
  mcpCommand,
  themeCommand,
  keybindingsCommand,
  // M18
  branchCommand,
  forkCommand,
  reviewCommand,
  recapCommand,
  shareCommand,
  rewindCommand,
  onboardingCommand,
  hooksCommand,
  scheduleCommand,
  loopCommand,
  goalCommand,
  vimCommand,
  outputStyleCommand,
  workflowsCommand,
  copyCommand,
  releaseNotesCommand,
];

/**
 * Live slash catalog shared by help, completion, and pickers. Dispatch order is
 * mirrored here: built-ins win, then disk commands, then user-invocable skills.
 */
export function getAvailableCommands(): CommandCatalogEntry[] {
  const catalog: CommandCatalogEntry[] = [];
  const seen = new Set<string>();
  const append = (entry: CommandCatalogEntry): void => {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    catalog.push({ name: entry.name, description: entry.description });
  };
  for (const command of COMMANDS) append(command);
  for (const command of getCustomCommands().values()) append(command);
  for (const skill of listSkills()) {
    if (skill.userInvocable !== false) append(skill);
  }
  return catalog;
}

// /help resolves the same live catalog used by raw/Ink completion and pickers.
bindCommandList(getAvailableCommands);
