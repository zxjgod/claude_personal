import { z } from "zod";
import { MemoryStore } from "../../memory-extract.js";
import { buildTool } from "../registry.js";
export const MemoryRecallTool = buildTool({
  name: "memory_recall",
  description: "Read indexed project or user memories",
  promptDescription:
    "List or search durable memories, or read a memory by its id. User scope is shared across projects; project scope is shared across worktrees. Use this to recall the details behind the project memory index.",
  schema: z.strictObject({
    scope: z.enum(["user", "project", "local"]).default("project"),
    query: z.string().optional(),
    id: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const entries = new MemoryStore(context.workspaceRoot, input.scope)
      .list()
      .filter(
        (entry) =>
          (!input.id || entry.id === input.id) &&
          (!input.query ||
            `${entry.text} ${entry.tags?.join(" ") ?? ""}`
              .toLowerCase()
              .includes(input.query.toLowerCase())),
      )
      .slice(-input.limit);
    return { content: JSON.stringify(entries) };
  },
});
