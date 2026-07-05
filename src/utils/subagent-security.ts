// ============================================================
// Sub-agent Permission Control
// ============================================================
// Provides restricted approval functions for sub-agents to prevent
// them from bypassing security checks via defaultAskUser.

import type { AskUserFn, Tool } from "../types.js";

/**
 * Create a restricted approval function for sub-agents.
 * Dangerous tools (bash, write, edit) require parent approval;
 * read-only tools are auto-approved.
 */
export function createSubAgentApprover(
  parentApprover?: AskUserFn,
  restrictive: boolean = true,
): AskUserFn {
  return async (tool: Tool, input: any, context: any) => {
    // Dangerous tools that can modify system state
    const dangerousTools = new Set([
      "bash",
      "write",
      "edit",
      "multi_edit",
      "notebook_edit",
      "enter_worktree",
      "exit_worktree",
    ]);

    // If this is a dangerous tool, require parent approval
    if (dangerousTools.has(tool.name)) {
      if (parentApprover) {
        // Forward to parent approver
        return parentApprover(tool, input, context);
      }

      // No parent approver available
      if (restrictive) {
        // In restrictive mode, deny dangerous operations without parent
        return false;
      }

      // In permissive mode (for tests), allow
      return true;
    }

    // Read-only tools are always allowed
    return true;
  };
}

/**
 * Check if a tool is considered dangerous and requires approval.
 */
export function isDangerousTool(toolName: string): boolean {
  const dangerousTools = new Set([
    "bash",
    "write",
    "edit",
    "multi_edit",
    "notebook_edit",
    "enter_worktree",
    "exit_worktree",
  ]);

  return dangerousTools.has(toolName);
}
