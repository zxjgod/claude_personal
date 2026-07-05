// ============================================================
// Core Tools Export
// ============================================================

// Import from other tool modules
import { LspDiagnosticsTool, NotebookEditTool } from "../tools-m8.js";
import {
  AskUserQuestionTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
} from "../tools-m8-interactive.js";
import { M14_TOOLS } from "../tools-m9.js";
import { TEAM_TOOLS } from "../tools-team.js";
import type { Tool } from "../types.js";
import { BashTool } from "./core/bash.js";
import { EditTool, MultiEditTool } from "./core/edit.js";
import { GlobTool } from "./core/glob.js";
import { GrepTool } from "./core/grep.js";
import { ReadTool } from "./core/read.js";
import { WriteTool } from "./core/write.js";
import { TaskTool } from "./extended/task.js";
import { TodoTool } from "./extended/todo.js";
import { WebFetchTool } from "./extended/web-fetch.js";
import { WebSearchTool } from "./extended/web-search.js";

export const CORE_TOOLS: Tool[] = [
  ReadTool,
  WriteTool,
  EditTool,
  MultiEditTool,
  BashTool,
  GlobTool,
  GrepTool,
  TodoTool,
  WebFetchTool,
  WebSearchTool,
  TaskTool,
  NotebookEditTool,
  LspDiagnosticsTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
  AskUserQuestionTool,
  ...TEAM_TOOLS,
  ...M14_TOOLS,
];
