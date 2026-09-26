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
import { MemoryStore } from "../../memory-extract.js";
import { listSubagentNames } from "../../subagents.js";
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
});

export const MemorySaveTool = buildTool({
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

  async call(input, context) {
    const store = new MemoryStore(context.workspaceRoot);
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
        "project",
        input.agent_type,
        context.workspaceRoot,
        input.content,
      );
      lines.push(
        ok
          ? `Appended to agent memory for "${input.agent_type}" (project scope).`
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
