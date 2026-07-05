// ============================================================
// Slash Commands — registry (M18 directory split)
// ============================================================
// index.ts assembles every command from src/commands/<name>.ts here.
// commands.ts re-exports this so existing imports (`from "./commands.js"`)
// keep working unchanged.
// ============================================================

import { agentsCommand } from "./agents.js";
// M18 new commands
import { branchCommand } from "./branch.js";
import { clearCommand } from "./clear.js";
import { commitCommand } from "./commit.js";
import { compactCommand } from "./compact.js";
import { configCommand } from "./config.js";
import { contextCommand } from "./context.js";
import { costCommand } from "./cost.js";
import { diffCommand } from "./diff.js";
import { doctorCommand } from "./doctor.js";
import { effortCommand } from "./effort.js";
import { exportCommand } from "./export.js";
import { forkCommand } from "./fork.js";
import { goalCommand } from "./goal.js";
import { bindCommandList, helpCommand } from "./help.js";
import { hooksCommand } from "./hooks.js";
import { initCommand } from "./init.js";
import { keybindingsCommand } from "./keybindings.js";
import { mcpCommand } from "./mcp.js";
import { memoryCommand } from "./memory.js";
import { modeCommand } from "./mode.js";
import { modelCommand } from "./model.js";
import { onboardingCommand } from "./onboarding.js";
import { permissionsCommand } from "./permissions.js";
import { prCommand } from "./pr.js";
import { providerCommand } from "./provider.js";
import { recapCommand } from "./recap.js";
import { resumeCommand } from "./resume.js";
import { reviewCommand } from "./review.js";
import { rewindCommand } from "./rewind.js";
import { scheduleCommand } from "./schedule.js";
import { sessionsCommand } from "./sessions.js";
import { shareCommand } from "./share.js";
import { skillsCommand } from "./skills.js";
import { statusCommand } from "./status.js";
import { themeCommand } from "./theme.js";
import { tokensCommand } from "./tokens.js";
import { toolsCommand } from "./tools.js";
import type { SlashCommand } from "./types.js";
import { vimCommand } from "./vim.js";

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
  costCommand,
  toolsCommand,
  contextCommand,
  configCommand,
  diffCommand,
  memoryCommand,
  initCommand,
  effortCommand,
  commitCommand,
  prCommand,
  providerCommand,
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
  goalCommand,
  vimCommand,
];

// /help iterates COMMANDS at run time; bind it now that the array exists.
bindCommandList(() => COMMANDS);

export { default as helpCommand } from "./help.js";
