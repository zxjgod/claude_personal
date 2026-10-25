// ============================================================
// MemorySave Tool — durable cross-session memory write path (F1)
// ============================================================
// Closes the memory loop: without a write path the model could never persist
// a lesson, and .claude/memories.jsonl only ever grew via the manual
// /memory extract command. Saved entries are deduped and become retrievable
// by the next session's prefetch ranking (startPrefetch reads the store).
//
// Two stores, both with existing readers:
//   - memories.jsonl (default) — ranked keyword retrieval into the MAIN
//     session as a <system-reminder> attachment.
//   - agent-memory/<type>/MEMORY.md (opt-in via agent_type) — injected into
//     that sub-agent TYPE's system prompt every time it runs.
// ============================================================

import { z } from "zod";
import { appendAgentMemory } from "../../agent-memory.js";
import { isMemoryApprovalRequired } from "../../memory-approval.js";
import { MemoryStore } from "../../memory-extract.js";
import { policyDecision } from "../../permission-policy.js";
import { listSubagentNames } from "../../subagents.js";
import type { PermissionResult, Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

const MAX_CONTENT_CHARS = 2000;

const MemorySaveSchema = z.strictObject({
  content: z
    .string()
    .min(1)
    .max(MAX_CONTENT_CHARS)
    .describe(
      "The durable fact/preference/lesson to remember across sessions, one concise sentence",
    ),
  agent_type: z
    .string()
    .optional()
    .describe(
      `Also append to this sub-agent type's MEMORY.md (injected into its system prompt ` +
        `on every future run). Available types: ${listSubagentNames().join(", ")}. ` +
        `Omit to store for the main session only.`,
    ),
  scope: z
    .enum(["user", "project", "local"])
    .optional()
    .describe("Agent memory scope; user persists across projects"),
});

export const MemorySaveTool: Tool<z.infer<typeof MemorySaveSchema>> = buildTool({
  name: "MemorySave",
  description: "Save a durable fact, preference, or lesson that should persist across sessions",
  promptDescription:
    "Persist a cross-session memory. Use when the user corrects you, states a standing " +
    "preference, or a lesson worth carrying into future sessions emerges. Saved entries " +
    "surface automatically in later sessions when relevant — do NOT save one-off task details.",
  schema: MemorySaveSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: true,
  async checkPermissions(input, context): Promise<PermissionResult> {
    if (context.permissionMode === "plan")
      return { allowed: false, reason: "Plan mode: memory writes are disabled" };
    // Every scope — project/local included — persists text that is later
    // injected into future sessions' system prompts (and project scope is
    // shared via VCS). An unapproved write is a durable prompt-injection
    // channel, so all scopes require explicit approval, not just user.
    const decision = policyDecision(
      context.permissionPolicy,
      "MemorySave",
      input,
      context.workspaceRoot,
    );
    if (decision === "deny")
      return { allowed: false, reason: "Memory write denied by permission rule" };
    // /memory-approval off: the user has deliberately relaxed the T2 gate
    // (user/managed settings only — project settings cannot disable it).
    // Deny rules and plan mode above still apply.
    if (decision === "allow" || !isMemoryApprovalRequired()) {
      context.approvedUserMemoryWrite = JSON.stringify([
        input.content,
        input.agent_type,
        input.scope,
      ]);
      return { allowed: true };
    }
    const scope = input.scope ?? "project";
    const scopeLabel =
      scope === "user"
        ? "across all projects in the user scope"
        : scope === "project"
          ? "for this project (shared with collaborators via VCS)"
          : "locally for this project";
    const allowed = context.askUser
      ? await context.askUser(
          MemorySaveTool,
          { ...input, __approvalFingerprint: "memory-scope" },
          `Persist a memory ${scopeLabel}`,
        )
      : false;
    if (allowed)
      context.approvedUserMemoryWrite = JSON.stringify([
        input.content,
        input.agent_type,
        input.scope,
      ]);
    return allowed
      ? { allowed: true }
      : { allowed: false, reason: "Durable memory writes require explicit approval" };
  },

  async call(input, context): Promise<ToolResult> {
    if (context.permissionMode === "plan")
      return { content: "", error: "Plan mode: memory writes are disabled" };
    if (
      context.approvedUserMemoryWrite !==
      JSON.stringify([input.content, input.agent_type, input.scope])
    ) {
      const permission = await MemorySaveTool.checkPermissions(input, context);
      if (!permission.allowed) return { content: "", error: permission.reason };
    }
    delete context.approvedUserMemoryWrite;
    const store = new MemoryStore(context.workspaceRoot, input.scope ?? "project");
    const written = store.append([
      { source: "manual", text: input.content, tags: ["agent-saved"] },
    ]);
    const deduped = written.length === 0;
    const lines: string[] = [
      deduped
        ? `Already remembered (deduped): ${input.content.slice(0, 120)}`
        : `Saved to durable memory: ${input.content.slice(0, 120)}`,
    ];

    if (input.agent_type) {
      // Also merge into the sub-agent type's MEMORY.md so ITS system prompt
      // carries the lesson on every future run. Best-effort like the store.
      const ok = appendAgentMemory(
        input.scope ?? "project",
        input.agent_type,
        context.workspaceRoot,
        input.content,
      );
      lines.push(
        ok
          ? `Appended to agent memory for "${input.agent_type}" (${input.scope ?? "project"} scope).`
          : `Could not write agent memory for "${input.agent_type}" (check the type name).`,
      );
    }

    return {
      content: lines.join("\n"),
      metadata: {
        summary: deduped ? "Memory already present (deduped)" : "Memory saved",
      },
    };
  },
});
