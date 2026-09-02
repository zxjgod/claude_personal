// ============================================================
// Core Tools Export
// ============================================================

// Import from other tool modules
import {
  LspCompletionsTool,
  LspDiagnosticsTool,
  NotebookEditTool,
} from "../tools/breadth/index.js";
import {
  AskUserQuestionTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
} from "../tools/breadth/interactive.js";
import { ORCHESTRATION_TOOLS } from "../tools/breadth/orchestration.js";
import { TEAM_TOOLS } from "../tools/breadth/team.js";
import type { Tool } from "../types.js";
import { BashTool } from "./core/bash.js";
import { EditTool, MultiEditTool } from "./core/edit.js";
import { GlobTool } from "./core/glob.js";
import { GrepTool } from "./core/grep.js";
import { PowerShellTool } from "./core/powershell.js";
import { ReadTool } from "./core/read.js";
import { WriteTool } from "./core/write.js";
import { AgentTool } from "./extended/agent.js";
import { CronCreateTool, CronDeleteTool, CronListTool } from "./extended/cron-tools.js";
import { DesignSyncTool } from "./extended/design-sync.js";
import { JobKillTool, JobListTool, JobOutputTool } from "./extended/jobs.js";
import { ReplTool } from "./extended/repl.js";
import { ReportFindingsTool } from "./extended/report-findings.js";
import { ScheduleWakeupTool } from "./extended/schedule-wakeup.js";
import {
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
} from "./extended/structured-task-tools.js";
import { TaskTool } from "./extended/task.js";
import { TodoTool } from "./extended/todo.js";
import { WebFetchTool } from "./extended/web-fetch.js";
import { WebSearchTool } from "./extended/web-search.js";
import { WorkflowTool } from "./extended/workflow.js";

export const CORE_TOOLS: Tool[] = [
  ReadTool,
  WriteTool,
  EditTool,
  MultiEditTool,
  BashTool,
  PowerShellTool,
  GlobTool,
  GrepTool,
  TodoTool,
  WebFetchTool,
  WebSearchTool,
  ReplTool,
  WorkflowTool,
  TaskTool,
  AgentTool, // Enhanced sub-agent spawning with isolation support
  JobOutputTool, // Aliases: TaskOutput, task_output
  JobKillTool, // Aliases: TaskStop, task_stop
  JobListTool,
  NotebookEditTool,
  LspDiagnosticsTool,
  LspCompletionsTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
  AskUserQuestionTool,
  // Structured task management
  TaskCreateTool,
  TaskGetTool,
  TaskUpdateTool,
  TaskListTool,
  // Cron management
  CronCreateTool, // Aliases: schedule_cron, cron_create
  CronDeleteTool, // Aliases: cron_delete
  CronListTool, // Aliases: cron_list
  // Dynamic loop scheduling
  ScheduleWakeupTool, // Aliases: schedule_wakeup
  // Code review
  ReportFindingsTool, // Aliases: report_findings
  // Design system integration
  DesignSyncTool, // Aliases: design_sync
  ...TEAM_TOOLS,
  ...ORCHESTRATION_TOOLS,
];
