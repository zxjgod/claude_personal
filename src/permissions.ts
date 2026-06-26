// ============================================================
// Permission System — 4 modes + dangerous pattern detection
//                          + LLM-assisted risk classifier (M15.3)
// ============================================================

import * as path from "node:path";
import type {
  ModelCaller,
  ModelConfig,
  Tool,
  ToolContext,
  ToolInput,
  ClassifierResult,
  PermissionClassifier,
} from "./types.js";

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

    // Likely-never-terminating commands: infinite loops, long-running
    // servers, and interactive shells. These block the bash tool forever
    // (the tool has no stdin to feed them), which historically deadlocked
    // the agent loop on Windows where a hung grandchild keeps the pipe open.
    // Flag them up front so the user can confirm or reject before any
    // subprocess is spawned.
    if (
      /\bwhile\s*\(\s*(true|1|!!?)\s*\)/.test(cmd) || // while(true) / while(1) / while(!)
      /\bfor\s*\(\s*;\s*;\s*\)/.test(cmd) || // for(;;)
      /\btail\s+-f\b/.test(cmd) || // tail -f (follow forever)
      /\bwatch\b/.test(cmd) || // watch (loops forever)
      /\b(npm|yarn|pnpm)\s+(run\s+)?(dev|serve|start)\b/.test(cmd) || // dev servers
      /\b(vite|webpack-dev-server|next\s+dev|ng\s+serve)\b/.test(cmd) || // dev servers
      /\bssh\b/.test(cmd) || // interactive ssh
      /\b(python|node|php|irb|pry)\s*$/.test(cmd.trim()) || // bare REPL
      /\b(python|node|php|irb|pry)\s+-i\b/.test(cmd) // interactive REPL
    ) {
      return {
        dangerous: true,
        reason: "Command may run forever or wait for interactive input (blocking the agent loop)",
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

// --- LLM-Assisted Risk Classifier (M15.3) ---
//
// A model-assessed risk classification of a flagged tool call (yoloClassifier
// style). The classifier is invoked ONLY for calls already flagged by the
// regex dangerous-pattern detector — never for ordinary tools. It can:
//   - block outright (block=true): refuse before prompting the user, with a
//     model-authored reason;
//   - annotate (block=false, reason set): replace the terse regex reason with
//     a clearer, model-explained risk hint shown in the approval prompt;
//   - defer (block=false, reason undefined): leave the regex reason as-is.
//
// `unavailable` distinguishes "classifier actively blocked" from "classifier
// couldn't respond" — callers treat the latter as a soft defer (fail-safe:
// still prompt with the regex reason), never as allow.
//
// The ClassifierResult / PermissionClassifier interfaces live in types.ts
// (they're referenced from ToolContext). Re-exported here for callers that
// import the permission module directly.
export type { ClassifierResult, PermissionClassifier } from "./types.js";

const CLASSIFIER_SYSTEM_PROMPT = `You are a security permission classifier for an AI coding assistant's shell/file tools.

You are given ONE tool call that a heuristic regex already flagged as potentially dangerous. Your job is to assess the REAL risk and decide whether it must be blocked outright, or merely confirmed by the human, or is actually safe.

Respond with EXACTLY one line in this format and nothing else:
VERDICT|<short reason>

Where VERDICT is one of:
- BLOCK    — the action is clearly destructive/irreversible/unauthorized and must NOT run even with confirmation (e.g. rm -rf /, mkfs, wiping the workspace, curl|bash to a system path).
- CONFIRM  — genuinely risky but plausibly intentional; let the human decide, but explain the concrete danger (e.g. "rm -rf ./build — recursively deletes the build directory").
- ALLOW    — the regex over-flagged a benign command (e.g. "git push --force" to a feature branch the user owns, "rm -rf node_modules" which is routine). Give a one-line reason it is safe.

Rules:
- Be conservative: when in doubt, choose CONFIRM over ALLOW and BLOCK over CONFIRM.
- Never invent facts about the workspace you weren't given.
- The reason is shown to the user in the approval prompt — keep it under ~120 chars, concrete, no hedging.
- Do not output markdown, code fences, or any preamble. Just VERDICT|reason.`;

/** Parse a single `VERDICT|reason` classifier line into a ClassifierResult. */
export function parseClassifierVerdict(text: string): ClassifierResult {
  const line = text.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
  const m = /^(BLOCK|CONFIRM|ALLOW)\s*\|(.*)$/i.exec(line);
  if (!m) {
    // Unparseable → defer to the regex path (fail-safe: still prompt).
    return { block: false, unavailable: true };
  }
  const verdict = m[1]!.toUpperCase();
  const reason = m[2]!.trim();
  if (verdict === "BLOCK") return { block: true, reason: reason || undefined };
  if (verdict === "CONFIRM") return { block: false, reason: reason || undefined };
  return { block: false, reason: undefined }; // ALLOW → defer (regex reason stands)
}

/**
 * Ask the model to classify an already-flagged tool call. Pure with respect to
 * the permission decision: it never allows on its own — ALLOW just means "drop
 * my annotation, use the regex reason". On any error/timeout it returns
 * { block:false, unavailable:true } so the caller falls back to prompting.
 */
export async function classifyPermissionRisk(
  toolName: string,
  input: Record<string, unknown>,
  classifier: PermissionClassifier,
): Promise<ClassifierResult> {
  const { callModel, modelConfig, timeoutMs = 4000, signal } = classifier;

  // No API key → can't call the model. Fail safe (defer to regex path).
  if (!modelConfig.apiKey) return { block: false, unavailable: true };

  const action = formatActionForClassifier(toolName, input);
  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: `Classify this tool call:\n\n${action}` },
      ],
    },
  ];

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  // If the caller already aborted (turn cancelled), short-circuit.
  if (signal?.aborted) {
    clearTimeout(timer);
    return { block: false, unavailable: true };
  }
  const onParentAbort = () => timeoutController.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    let text = "";
    for await (const event of callModel(
      messages,
      [],
      CLASSIFIER_SYSTEM_PROMPT,
      { ...modelConfig, temperature: 0 },
    )) {
      if (timeoutController.signal.aborted) break;
      if (event.type === "text_delta") text += event.delta;
    }
    if (timeoutController.signal.aborted && !text) {
      return { block: false, unavailable: true };
    }
    return parseClassifierVerdict(text);
  } catch {
    // API error, network failure, etc. — never block the tool on a classifier
    // outage; defer to the existing regex + interactive prompt.
    return { block: false, unavailable: true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

/** Render a tool call as a compact, classifier-readable description. */
function formatActionForClassifier(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "bash" && typeof input.command === "string") {
    return `bash: ${input.command}`;
  }
  if (typeof input.filePath === "string") {
    const op = ["edit", "write"].includes(toolName) ? toolName : "access";
    return `${op}: ${input.filePath}`;
  }
  if (typeof input.url === "string") {
    return `${toolName}: ${input.url}`;
  }
  return `${toolName}: ${JSON.stringify(input)}`;
}

// --- Main Permission Check ---

export interface PermissionCheckOptions {
  /** Callback to prompt the user for permission */
  askUser: (
    tool: Tool,
    input: Record<string, unknown>,
    riskHint?: string,
  ) => Promise<boolean>;
  /**
   * Optional LLM-assisted risk classifier (M15.3). When present, invoked only
   * for tool calls the regex dangerous-pattern detector already flagged — it
   * never runs for ordinary tools. Off by default; the CLI enables it via
   * --llm-perm-classifier / CCR_PERM_CLASSIFIER=1. Absent in tests and when
   * no model config is available.
   */
  classifier?: PermissionClassifier;
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

  // Step 5: Dangerous patterns — ALWAYS require confirmation. When the LLM
  // classifier is enabled (M15.3), it runs FIRST to enrich the approval
  // prompt with a model-assessed risk reason. The classifier never relaxes
  // the prompt — it can only block outright or annotate. On any failure
  // (no caller, no apiKey, parse error, API error, timeout) we fail SAFE:
  // fall back to the regex reason and still prompt, exactly as before.
  const dangerousCheck = checkDangerousPattern(
    tool.name,
    input,
    context.workspaceRoot,
  );
  if (dangerousCheck.dangerous) {
    let riskHint = dangerousCheck.reason;
    if (options.classifier) {
      const classified = await classifyPermissionRisk(
        tool.name,
        input,
        options.classifier,
      );
      if (classified.block) {
        return {
          allowed: false,
          reason: classified.reason ?? dangerousCheck.reason,
        };
      }
      if (classified.reason) {
        riskHint = classified.reason;
      }
    }
    const allowed = await options.askUser(tool, input, riskHint);
    return allowed
      ? { allowed: true }
      : { allowed: false, reason: riskHint };
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
