// ============================================================
// Slash Commands — registry (M18 directory split)
// ============================================================
// index.ts assembles every command from src/commands/<name>.ts here.
// commands.ts re-exports this so existing imports (`from "./commands.js"`)
// keep working unchanged.
// ============================================================

import type { SlashCommand } from "./types.js";
import { helpCommand, bindCommandList } from "./help.js";
import { clearCommand } from "./clear.js";
import { modelCommand } from "./model.js";
import { compactCommand } from "./compact.js";
import { tokensCommand } from "./tokens.js";
import { doctorCommand } from "./doctor.js";
import { sessionsCommand } from "./sessions.js";
import { resumeCommand } from "./resume.js";
import { permissionsCommand } from "./permissions.js";
import { statusCommand } from "./status.js";
import { costCommand } from "./cost.js";
import { toolsCommand } from "./tools.js";
import { contextCommand } from "./context.js";
import { configCommand } from "./config.js";
import { diffCommand } from "./diff.js";
import { memoryCommand } from "./memory.js";
import { initCommand } from "./init.js";
import { effortCommand } from "./effort.js";
import { commitCommand } from "./commit.js";
import { prCommand } from "./pr.js";
import { agentsCommand } from "./agents.js";
import { skillsCommand } from "./skills.js";
import { exportCommand } from "./export.js";
import { mcpCommand } from "./mcp.js";
import { themeCommand } from "./theme.js";
import { keybindingsCommand } from "./keybindings.js";
// M18 new commands
import { branchCommand } from "./branch.js";
import { forkCommand } from "./fork.js";
import { reviewCommand } from "./review.js";
import { recapCommand } from "./recap.js";
import { shareCommand } from "./share.js";
import { rewindCommand } from "./rewind.js";
import { onboardingCommand } from "./onboarding.js";

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
];

// /help iterates COMMANDS at run time; bind it now that the array exists.
bindCommandList(() => COMMANDS);

export { default as helpCommand } from "./help.js";
