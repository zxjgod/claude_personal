// ============================================================
// Fork-Skill Runner — run a context:'fork' skill in a sub-agent (M37)
// ============================================================
// A skill with context:'fork' is not injected into the current conversation —
// its body is the task for a fresh sub-agent (kernel §Skill + §6). We reuse the
// sub-agent loop machinery: the skill picks the agent type (skill.agent) and
// may restrict the tool set (skill.allowedTools). Only the sub-agent's final
// assistant text comes back; its intermediate tool output never enters the
// parent context.
//
// Kept out of breadth/orchestration.ts so that file doesn't take a static dependency on the
// agent loop; this module is imported lazily-at-use from SkillTool.
// ============================================================

import { agentLoop } from "../agent-loop.js";
import { createModelCaller } from "../llm-adapter.js";
import { mergePermissionPolicies } from "../permission-policy.js";
import { prepareAgentHooks, scopedHooks } from "../scoped-execution.js";
import type { SkillDefinition } from "../skills.js";
import {
  buildSubagentSystemPrompt,
  extractLastAssistantText,
  getCoreToolsForSubagents,
  getSubagentType,
  preloadAgentSkills,
  resolveSubagentTools,
  type SubagentType,
  subagentModelConfig,
} from "../subagents.js";
import { canonicalToolKey } from "../tools/utils/official-names.js";
import {
  deriveSubContext,
  type Message,
  type ModelCaller,
  type ToolContext,
  type ToolResult,
} from "../types.js";
import { createSubAgentApprover } from "../utils/subagent-security.js";

const FORK_MAX_TURNS = 10;
const FORK_COMPACT_THRESHOLD = 50_000;

/**
 * Run a fork skill's resolved body as a sub-agent task. `context.modelConfig`
 * must be present (SkillTool guards this). Returns the sub-agent's final text.
 */
export async function runForkSkill(
  skill: SkillDefinition,
  resolvedBody: string,
  context: ToolContext,
  caller?: ModelCaller,
): Promise<ToolResult> {
  if (!context.modelConfig) {
    return { content: "", error: "Fork skill requires modelConfig in context." };
  }

  // Pick the sub-agent type the skill named; fall back to general-purpose.
  const type: SubagentType | undefined =
    (skill.agent ? getSubagentType(skill.agent) : undefined) ?? getSubagentType("general");
  if (!type) {
    return { content: "", error: `Fork skill "${skill.name}": no sub-agent type available.` };
  }

  const subMessages: Message[] = [
    { role: "user", content: [{ type: "text", text: resolvedBody }] },
  ];
  const config = subagentModelConfig(
    { ...type, model: skill.model ?? type.model, effort: skill.effort ?? type.effort },
    context.modelConfig,
  );
  const subCaller = caller ?? createModelCaller(config);
  // Trust-gate the agent type's declared hooks (review fix) — project-scope
  // agent hooks run shell and must pass the same fingerprint gate as project
  // settings hooks; unapproved ones are dropped with a note in the prompt.
  const typeHooks = await prepareAgentHooks(type, context.askUser, context.workspaceRoot);
  const subSystemPrompt = buildSubagentSystemPrompt(
    type,
    [
      type.systemPrompt,
      "",
      `You are running the "${skill.name}" skill.`,
      await preloadAgentSkills(type, context.workspaceRoot, context.askUser),
      ...(typeHooks.note ? ["", typeHooks.note] : []),
    ].join("\n"),
    { workspaceRoot: context.workspaceRoot },
  );

  const startTime = Date.now();
  let toolCallCount = 0;
  let errorMessage: string | undefined;
  let terminalReason: string | undefined;

  try {
    const coreTools = await getCoreToolsForSubagents();
    let tools = resolveSubagentTools(type, coreTools);
    // skill.allowedTools further narrows the resolved set (kernel: allowedTools).
    // Names canonicalize (review fix): official docs write "Read"/"Grep" while
    // registry tools are lowercase — an exact raw compare filtered out every
    // declared tool and left the fork sub-agent with nothing to run.
    if (!skill.toolPermissionGrant && skill.allowedTools && skill.allowedTools.length > 0) {
      const allow = new Set(skill.allowedTools.map(canonicalToolKey));
      tools = tools.filter((t) => allow.has(canonicalToolKey(t.name)));
    }

    const approver = createSubAgentApprover(context.askUser);
    const runner = scopedHooks(
      scopedHooks(context.hooks, typeHooks.hooksConfig, context.sessionId, context.workspaceRoot),
      skill.hooks,
      context.sessionId,
      context.workspaceRoot,
    );
    const childContext = deriveSubContext(context, {
      askUser: approver,
      hooks: runner,
      abortSignal: context.abortSignal,
      subagentDepth: (context.subagentDepth ?? 0) + 1,
      // Own skill-activation scope (see ToolContext.skillScopeId).
      skillScopeId: `fork-skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      permissionMode:
        context.permissionMode === "plan"
          ? "plan"
          : type.permissionMode === "plan" || type.permissionMode === "dontAsk"
            ? type.permissionMode
            : context.permissionMode,
    });
    childContext.modelConfig = config;
    childContext.permissionPolicy = mergePermissionPolicies(context.permissionPolicy, {
      allow: skill.toolPermissionGrant ? skill.allowedTools : [],
      deny: skill.disallowedTools,
    });
    const loop = agentLoop(subMessages, tools, subCaller, config, {
      systemPrompt: subSystemPrompt,
      maxTurns: type.maxTurns ?? FORK_MAX_TURNS,
      autoCompactThreshold: FORK_COMPACT_THRESHOLD,
      abortSignal: context.abortSignal,
      toolContext: childContext,
      askUser: approver,
    });

    for await (const event of loop) {
      if (event.type === "tool_use") toolCallCount++;
      else if (event.type === "aborted") errorMessage = event.reason;
      else if (event.type === "error") errorMessage = String(event.error);
      else if (event.type === "done") terminalReason = event.finishReason;
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const duration = Date.now() - startTime;
  const output = extractLastAssistantText(subMessages);

  if (errorMessage || terminalReason !== "end_turn") {
    return {
      content: output,
      error: `Fork skill "${skill.name}" incomplete: ${errorMessage || terminalReason || "no terminal event"}`,
      metadata: { durationMs: duration, incomplete: true },
    };
  }

  const header = [
    `[Skill "${skill.name}" (fork) completed]`,
    `Tool calls: ${toolCallCount}`,
    `Duration: ${(duration / 1000).toFixed(1)}s`,
    ``,
    `--- Result ---`,
    ``,
  ].join("\n");

  return {
    content: header + (output || "(no output)"),
    metadata: { durationMs: duration },
  };
}
