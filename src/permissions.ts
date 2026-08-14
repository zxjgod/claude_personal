// ============================================================
// Permission System — 4 modes + dangerous pattern detection
//                          + LLM-assisted risk classifier (M15.3)
// ============================================================

import * as path from "node:path";
import { buildClassifierPrompt } from "./classifier-rules.js";
import type {
  ClassifierResult,
  PermissionClassifier,
  PermissionDecisionReason,
  Tool,
  ToolContext,
} from "./types.js";

// --- Debug Logging ---

const PERMISSION_DEBUG = process.env.DEBUG_PERMISSIONS === "1";

function logPermissionDecision(
  step: number,
  toolName: string,
  action: string,
  result: { allowed: boolean; reason?: string; decisionReason?: PermissionDecisionReason },
  extra?: Record<string, unknown>,
): void {
  if (!PERMISSION_DEBUG) return;
  const timestamp = new Date().toISOString().split("T")[1]?.slice(0, 8) ?? "";
  console.error(
    `${timestamp} [perm] Step ${step}: ${toolName}(${action}) → ${result.allowed ? "ALLOW" : "DENY"}` +
      (result.reason ? ` (${result.reason})` : "") +
      (result.decisionReason ? ` [${result.decisionReason}]` : "") +
      (extra ? ` ${JSON.stringify(extra)}` : ""),
  );
}

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
    if (resolved !== resolvedWorkspace && !resolved.startsWith(resolvedWorkspace + path.sep)) {
      return {
        dangerous: true,
        reason: `Path "${input.filePath}" is outside workspace "${workspaceRoot}"`,
      };
    }
  }

  // PowerShell-specific dangerous patterns (Windows shell). Kept tight: the
  // destructive equivalents of the bash checks below.
  if (toolName === "powershell" && input.command && typeof input.command === "string") {
    const cmd = input.command as string;
    if (/\bRemove-Item\b[^|;]*\s+-Recurse/i.test(cmd) || /\brm\s+[^|;]*-r/i.test(cmd)) {
      return { dangerous: true, reason: "Recursive delete (Remove-Item -Recurse / rm -r)" };
    }
    if (/\bInvoke-Expression\b|\biex\b/i.test(cmd)) {
      return { dangerous: true, reason: "Invoke-Expression — executes arbitrary code" };
    }
    if (/\bSet-ExecutionPolicy\b/i.test(cmd)) {
      return { dangerous: true, reason: "Set-ExecutionPolicy — changes script execution policy" };
    }
    if (/\bStart-Process\b[^|;]*\s+-Verb\s+RunAs|\bsudo\b/i.test(cmd)) {
      return { dangerous: true, reason: "Privilege escalation (Start-Process -Verb RunAs / sudo)" };
    }
    if (/(curl|wget|iwr|Invoke-WebRequest)[^|;]*\|[^|;]*(iex|Invoke-Expression)/i.test(cmd)) {
      return { dangerous: true, reason: "Pipe downloaded content to a shell (code execution)" };
    }
    if (/\bwhile\s*\(\s*\$?true\s*\)/i.test(cmd) || /\bfor\s*\(\s*;\s*;\s*\)/i.test(cmd)) {
      return { dangerous: true, reason: "Command may run forever (blocking the agent loop)" };
    }
  }

  // Bash-specific dangerous patterns
  if (toolName === "bash" && input.command && typeof input.command === "string") {
    const cmd = input.command as string;

    // Recursive deletion
    if (/\brm\s+.*-rf\b/.test(cmd)) {
      return {
        dangerous: true,
        reason: "递归删除命令 (rm -rf) — 将强制删除所有内容且无法恢复",
      };
    }
    if (/\brm\s+.*-r/.test(cmd)) {
      return {
        dangerous: true,
        reason: "递归删除命令 (rm -r) — 将删除目录及其所有子内容",
      };
    }

    // Privilege escalation
    if (/\bsudo\b/.test(cmd)) {
      return {
        dangerous: true,
        reason: "提权命令 (sudo) — 尝试获取管理员权限",
      };
    }

    // Pipe to shell
    if (/(curl|wget).*\|.*(bash|sh|zsh)/.test(cmd)) {
      return {
        dangerous: true,
        reason: "管道到 Shell — 执行从网络下载的未知代码 (严重安全风险)",
      };
    }

    // Force push
    if (/\bgit\s+push\s+.*--force/.test(cmd)) {
      return {
        dangerous: true,
        reason: "强制推送 (git push --force) — 可能覆盖远程分支的提交历史",
      };
    }

    // Hard reset
    if (/\bgit\s+reset\s+--hard/.test(cmd)) {
      return {
        dangerous: true,
        reason: "强制重置 (git reset --hard) — 将丢弃所有未提交的更改",
      };
    }

    // Disk/filesystem operations
    if (/\b(mkfs|dd|fdisk)\b/.test(cmd)) {
      return {
        dangerous: true,
        reason: "磁盘操作命令 — 可能损坏文件系统或清除数据",
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
//
// The bypass-immune safety floor (kernel §4, 1g). Writing to any of these is
// denied in EVERY permission mode — including bypassPermissions / YOLO. The
// rule: the escape valve must never be global; a small class of paths must
// always be off-limits to automated edits (secrets, VCS internals, the
// assistant's own config, and shell startup files that grant code execution).
const BLOCKED_PATTERNS = [
  // --- secrets / credentials ---
  /\.ssh\/.*/,
  /\.ssh$/,
  /\/etc\/(passwd|shadow|sudoers)/,
  /\/etc\/ssl\//,
  /\.env$/,
  /\.env\./,
  /credentials\.json$/,
  /\.npmrc$/,
  // --- VCS internals: the whole .git/ tree, not just config/hooks. Editing
  //     refs/objects/index can corrupt the repo or smuggle in hooks. ---
  /(^|[/\\])\.git([/\\]|$)/,
  // --- the assistant's own project config / memory (kernel names .claude/) ---
  /(^|[/\\])\.claude([/\\]|$)/,
  // --- shell startup files: writing these grants arbitrary code execution
  //     on the next shell launch, a classic bypass-mode escalation. ---
  /(^|[/\\])\.(bashrc|bash_profile|zshrc|zprofile|profile|fish\/config\.fish)$/,
  /(^|[/\\])\.config[/\\]fish[/\\]config\.fish$/,
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
  const line =
    text
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .pop() ?? "";
  const m = /^(BLOCK|CONFIRM|ALLOW)\s*\|(.*)$/i.exec(line);
  if (!m) {
    // Unparseable → defer to the regex path (fail-safe: still prompt).
    return { block: false, unavailable: true };
  }
  const verdict = m[1]!.toUpperCase();
  const reason = m[2]!.trim();
  if (verdict === "BLOCK") {
    return { block: true, reason: reason || undefined, verdict: "BLOCK" };
  }
  if (verdict === "CONFIRM") {
    return { block: false, reason: reason || undefined, verdict: "CONFIRM" };
  }
  return { block: false, reason: undefined, verdict: "ALLOW" }; // ALLOW → defer (regex reason stands)
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
  const { callModel, modelConfig, timeoutMs = 4000, signal, rules } = classifier;
  // A rule layer (allow/soft_deny/environment) overrides the bare default prompt.
  const systemPrompt = rules ? buildClassifierPrompt(rules) : CLASSIFIER_SYSTEM_PROMPT;

  // No API key → can't call the model. Fail safe (defer to regex path).
  if (!modelConfig.apiKey) return { block: false, unavailable: true };

  const action = formatActionForClassifier(toolName, input);
  const messages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: `Classify this tool call:\n\n${action}` }],
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
    for await (const event of callModel(messages, [], systemPrompt, {
      ...modelConfig,
      temperature: 0,
    })) {
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
function formatActionForClassifier(toolName: string, input: Record<string, unknown>): string {
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
  askUser: (tool: Tool, input: Record<string, unknown>, riskHint?: string) => Promise<boolean>;
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
): Promise<{ allowed: boolean; reason?: string; decisionReason?: PermissionDecisionReason }> {
  const action = formatActionForClassifier(tool.name, input).slice(0, 100);

  // Step 1: Read-only tools are always allowed. Pass input so data-driven
  // tools (Bash: `cat` read-only, `rm` not) decide per call (M29).
  if (tool.isReadOnly(input)) {
    const result = { allowed: true as const };
    logPermissionDecision(1, tool.name, action, result);
    return result;
  }

  // Step 2: Plan mode — never execute destructive tools.
  if (context.permissionMode === "plan") {
    const result = {
      allowed: false as const,
      reason: `Plan mode: ${tool.name} is a destructive tool. Not executing.`,
      decisionReason: "mode" as const,
    };
    logPermissionDecision(2, tool.name, action, result, { permissionMode: context.permissionMode });
    return result;
  }

  // ============================================================
  // SAFETY FLOOR (kernel §4, 1f/1g) — runs BEFORE the bypass
  // short-circuit. These checks are IMMUNE to bypassPermissions: even
  // YOLO mode cannot clear them. The escape valve must never be global.
  // ============================================================

  // Step 3a (safetyCheck): blocked paths — hard deny in every mode.
  if (input.filePath && typeof input.filePath === "string") {
    if (isBlockedPath(input.filePath as string)) {
      const result = {
        allowed: false as const,
        reason: `Path "${input.filePath}" is blocked for security reasons.`,
        decisionReason: "safetyCheck" as const,
      };
      logPermissionDecision(3, tool.name, action, result, { path: input.filePath });
      return result;
    }
  }

  // Step 3b (safetyCheck): dangerous patterns — ALWAYS require confirmation,
  // even under bypassPermissions. When the LLM classifier is enabled (M15.3)
  // it runs FIRST to enrich the approval prompt; it can only block outright or
  // annotate, never relax. On any failure we fail SAFE: regex reason + prompt.
  const dangerousCheck = checkDangerousPattern(tool.name, input, context.workspaceRoot);
  if (dangerousCheck.dangerous) {
    let riskHint = dangerousCheck.reason;
    let classified: ClassifierResult | undefined;
    if (options.classifier) {
      logPermissionDecision(3, tool.name, action, { allowed: true }, { stage: "classifier-start" });
      classified = await classifyPermissionRisk(tool.name, input, options.classifier);
      logPermissionDecision(
        3,
        tool.name,
        action,
        { allowed: !classified.block, reason: classified.reason },
        { stage: "classifier-done", classified },
      );
      if (classified.block) {
        const result = {
          allowed: false as const,
          reason: classified.reason ?? dangerousCheck.reason,
          decisionReason: "classifier" as const,
        };
        return result;
      }
      if (classified.reason) {
        riskHint = classified.reason;
      }
    }

    // Auto mode: no interactive prompt. The classifier is the background safety
    // check — only an explicit ALLOW proceeds; BLOCK / CONFIRM / unavailable all
    // deny (fail-safe, since there is no human to confirm).
    if (context.permissionMode === "auto") {
      const autoAllowed = classified?.verdict === "ALLOW";
      const result = autoAllowed
        ? { allowed: true as const, decisionReason: "mode" as const }
        : { allowed: false as const, reason: riskHint, decisionReason: "mode" as const };
      logPermissionDecision(3, tool.name, action, result, { stage: "auto-mode", riskHint });
      return result;
    }

    // dontAsk mode: "ask" → "deny". Dangerous patterns always prompt, so in
    // dontAsk they are silently denied (no classifier, no prompt).
    if (context.permissionMode === "dontAsk") {
      const result = {
        allowed: false as const,
        reason: `dontAsk mode: ${tool.name} needs approval (${riskHint})`,
        decisionReason: "mode" as const,
      };
      logPermissionDecision(3, tool.name, action, result, { stage: "dontAsk-mode", riskHint });
      return result;
    }

    logPermissionDecision(
      3,
      tool.name,
      action,
      { allowed: true },
      { stage: "awaiting-user-confirm", riskHint },
    );
    const allowed = await options.askUser(tool, input, riskHint);
    const result = allowed
      ? { allowed: true as const, decisionReason: "safetyCheck" as const }
      : { allowed: false as const, reason: riskHint, decisionReason: "safetyCheck" as const };
    logPermissionDecision(3, tool.name, action, result, {
      stage: "user-confirmed",
      userAllowed: allowed,
    });
    return result;
  }

  // ============================================================
  // Past the safety floor — now mode-based fast paths may apply.
  // ============================================================

  // Step 4: Bypass mode — allow anything the safety floor didn't already stop.
  if (context.permissionMode === "bypassPermissions") {
    const result = { allowed: true, decisionReason: "mode" as const };
    logPermissionDecision(4, tool.name, action, result, { permissionMode: context.permissionMode });
    return result;
  }

  // Step 4.5: Auto mode — allow anything the safety floor didn't already stop,
  // without an interactive prompt. (Dangerous patterns were already resolved by
  // the classifier in Step 3b above; what reaches here are ordinary destructive
  // tools like write/edit/mkdir.)
  if (context.permissionMode === "auto") {
    const result = { allowed: true, decisionReason: "mode" as const };
    logPermissionDecision(4, tool.name, action, result, { permissionMode: context.permissionMode });
    return result;
  }

  // Step 5: acceptEdits — auto-approve file operations.
  if (context.permissionMode === "acceptEdits") {
    if (["edit", "write"].includes(tool.name)) {
      const result = { allowed: true, decisionReason: "mode" as const };
      logPermissionDecision(5, tool.name, action, result, {
        permissionMode: context.permissionMode,
      });
      return result;
    }
  }

  // Step 6: Default — ask only for tools that require interactive approval.
  const needsApproval = tool.requiresApproval ? tool.requiresApproval() : !tool.isReadOnly(input);
  if (!needsApproval) {
    const result = { allowed: true };
    logPermissionDecision(6, tool.name, action, result);
    return result;
  }

  // dontAsk mode: "ask" → "deny" (a tool that would prompt is silently denied).
  if (context.permissionMode === "dontAsk") {
    const result = {
      allowed: false as const,
      reason: `dontAsk mode: ${tool.name} needs approval`,
      decisionReason: "mode" as const,
    };
    logPermissionDecision(6, tool.name, action, result, { stage: "dontAsk-mode" });
    return result;
  }

  logPermissionDecision(6, tool.name, action, { allowed: true }, { stage: "awaiting-user" });
  const allowed = await options.askUser(tool, input);
  const result = allowed
    ? { allowed: true }
    : { allowed: false, reason: "User denied permission", decisionReason: "mode" as const };
  logPermissionDecision(6, tool.name, action, result, { userAllowed: allowed });
  return result;
}
