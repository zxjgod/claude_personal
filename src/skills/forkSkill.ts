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
// Kept out of tools-m9.ts so that file doesn't take a static dependency on the
// agent loop; this module is imported lazily-at-use from SkillTool.
// ============================================================

import { agentLoop } from "../agent-loop.js";
import { createModelCaller } from "../llm-adapter.js";
import type { SkillDefinition } from "../skills.js";
import {
  buildSubagentSystemPrompt,
  extractLastAssistantText,
  getCoreToolsForSubagents,
  getSubagentType,
  resolveSubagentTools,
  type SubagentType,
} from "../subagents.js";
import type { Message, ToolContext, ToolResult } from "../types.js";

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
  const subCaller = createModelCaller(context.modelConfig);
  const subSystemPrompt = buildSubagentSystemPrompt(
    type,
    [type.systemPrompt, "", `You are running the "${skill.name}" skill.`].join("\n"),
    { workspaceRoot: context.workspaceRoot },
  );

  const startTime = Date.now();
  let toolCallCount = 0;
  let errorMessage: string | undefined;

  try {
    const coreTools = await getCoreToolsForSubagents();
    let tools = resolveSubagentTools(type, coreTools);
    // skill.allowedTools further narrows the resolved set (kernel: allowedTools).
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      const allow = new Set(skill.allowedTools);
      tools = tools.filter((t) => allow.has(t.name));
    }

    const loop = agentLoop(subMessages, tools, subCaller, context.modelConfig, {
      systemPrompt: subSystemPrompt,
      maxTurns: type.maxTurns ?? FORK_MAX_TURNS,
      autoCompactThreshold: FORK_COMPACT_THRESHOLD,
      abortSignal: context.abortSignal,
      toolContext: {
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId,
        permissionMode: context.permissionMode,
        modelConfig: context.modelConfig,
        askUser: context.askUser,
      },
      askUser: context.askUser,
    });

    for await (const event of loop) {
      if (event.type === "tool_use") toolCallCount++;
      else if (event.type === "aborted") errorMessage = event.reason;
      else if (event.type === "error") errorMessage = String(event.error);
    }
  } catch (error: any) {
    errorMessage = error?.message || String(error);
  }

  const duration = Date.now() - startTime;
  const output = extractLastAssistantText(subMessages);

  if (errorMessage && !output) {
    return {
      content: "",
      error: `Fork skill "${skill.name}" failed: ${errorMessage}`,
      metadata: { durationMs: duration },
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
