// ============================================================
// Sub-agent Permission Control
// ============================================================
// Provides restricted approval functions for sub-agents so they cannot bypass
// security checks via defaultAskUser. Approval is capability-based: only an
// operation the tool itself reports as read-only for the given input is
// auto-approved; everything else is forwarded to the parent's approval
// channel (or denied when there is none).

import type { AskUserFn, Tool } from "../types.js";

/**
 * Create a restricted approval function for sub-agents.
 * Auto-approval requires ALL of: no risk hint, the tool reports itself
 * read-only for this input, and the tool does not demand approval itself.
 * Anything else — writes, unknown/new tools, risk-hinted reads — goes to the
 * parent approver; with no parent approver it is denied in restrictive mode
 * (the default), so a future writable tool can never silently inherit a yes.
 */
export function createSubAgentApprover(
  parentApprover?: AskUserFn,
  restrictive: boolean = true,
): AskUserFn {
  return async (tool: Tool, input: Record<string, unknown>, riskHint?: string) => {
    // Unknown/new capabilities must not silently inherit approval. A risk
    // hint can also force approval for an otherwise read-only operation.
    if (riskHint || !tool.isReadOnly(input) || tool.requiresApproval?.()) {
      if (parentApprover) {
        // Forward to parent approver with the correct riskHint parameter
        return parentApprover(tool, input, riskHint);
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
