// ============================================================
// Permission System — 4 modes + dangerous pattern detection
// ============================================================

import * as path from "node:path";
import type { Tool, ToolContext, ToolInput } from "./types.js";

// --- Dangerous Pattern Detection ---

interface DangerousCheck {
  dangerous: boolean;
  reason?: string;
}

export function checkDangerousPattern(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
): DangerousCheck {
  // Workspace boundary check for file operations
  if (input.filePath && typeof input.filePath === "string") {
    const resolvedWorkspace = path.resolve(workspaceRoot);
    // Resolve the input against the workspace root so relative paths are
    // judged correctly, and an absolute path outside the root is rejected
    // (path.resolve discards the base when the second arg is absolute).
    const resolved = path.resolve(resolvedWorkspace, input.filePath as string);
    if (
      resolved !== resolvedWorkspace &&
      !resolved.startsWith(resolvedWorkspace + path.sep)
    ) {
      return {
        dangerous: true,
        reason: `Path "${input.filePath}" is outside workspace "${workspaceRoot}"`,
      };
    }
  }

  // Bash-specific dangerous patterns
  if (toolName === "bash" && input.command && typeof input.command === "string") {
    const cmd = input.command as string;

    // Recursive deletion
    if (/\brm\s+.*-r/.test(cmd) || /\brm\s+.*-rf\b/.test(cmd)) {
      return {
        dangerous: true,
        reason: "Command includes recursive deletion (rm -r)",
      };
    }

    // Privilege escalation
    if (/\bsudo\b/.test(cmd)) {
      return {
        dangerous: true,
        reason: "Command uses sudo (privilege escalation)",
      };
    }

    // Pipe to shell
    if (/(curl|wget).*\|.*(bash|sh|zsh)/.test(cmd)) {
      return {
        dangerous: true,
        reason: "Command pipes downloaded content to a shell",
      };
    }

    // Force push
    if (/\bgit\s+push\s+.*--force/.test(cmd)) {
      return {
        dangerous: true,
        reason: "Force pushing to git",
      };
    }

    // Hard reset
    if (/\bgit\s+reset\s+--hard/.test(cmd)) {
      return {
        dangerous: true,
        reason: "Git hard reset — this discards changes",
      };
    }

    // Disk/filesystem operations
    if (/\b(mkfs|dd|fdisk)\b/.test(cmd)) {
      return {
        dangerous: true,
        reason: "Command includes disk/filesystem operations",
      };
    }
  }

  return { dangerous: false };
}

// --- Blocked Paths ---

const BLOCKED_PATTERNS = [
  /\.ssh\/.*/,
  /\.ssh$/,
  /\/etc\/(passwd|shadow|sudoers)/,
  /\/etc\/ssl\//,
  /\.env$/,
  /\.env\./,
  /credentials\.json$/,
  /\.npmrc$/,
  /\.git\/config$/,
  /\.git\/hooks\//,
];

export function isBlockedPath(filePath: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(filePath));
}

// --- Main Permission Check ---

export interface PermissionCheckOptions {
  /** Callback to prompt the user for permission */
  askUser: (
    tool: Tool,
    input: Record<string, unknown>,
    riskHint?: string,
  ) => Promise<boolean>;
}

export async function checkPermission(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolContext,
  options: PermissionCheckOptions,
): Promise<{ allowed: boolean; reason?: string }> {
  // Step 1: Read-only tools are always allowed
  if (tool.isReadOnly()) {
    return { allowed: true };
  }

  // Step 2: Plan mode — never execute destructive tools
  if (context.permissionMode === "plan") {
    return {
      allowed: false,
      reason: `Plan mode: ${tool.name} is a destructive tool. Not executing.`,
    };
  }

  // Step 3: Bypass mode — everything is allowed
  if (context.permissionMode === "bypassPermissions") {
    return { allowed: true };
  }

  // Step 4: Check blocked paths
  if (input.filePath && typeof input.filePath === "string") {
    if (isBlockedPath(input.filePath as string)) {
      return {
        allowed: false,
        reason: `Path "${input.filePath}" is blocked for security reasons.`,
      };
    }
  }

  // Step 5: Dangerous patterns — ALWAYS require confirmation
  const dangerousCheck = checkDangerousPattern(
    tool.name,
    input,
    context.workspaceRoot,
  );
  if (dangerousCheck.dangerous) {
    const allowed = await options.askUser(tool, input, dangerousCheck.reason);
    return allowed
      ? { allowed: true }
      : { allowed: false, reason: dangerousCheck.reason };
  }

  // Step 6: acceptEdits — auto-approve file operations
  if (context.permissionMode === "acceptEdits") {
    if (["edit", "write"].includes(tool.name)) {
      return { allowed: true };
    }
  }

  // Step 7: Default — ask only for tools that require interactive approval
  const needsApproval = tool.requiresApproval
    ? tool.requiresApproval()
    : !tool.isReadOnly();
  if (!needsApproval) {
    return { allowed: true };
  }

  const allowed = await options.askUser(tool, input);
  return allowed
    ? { allowed: true }
    : { allowed: false, reason: "User denied permission" };
}
