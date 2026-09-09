// DesignSync is unavailable until an authenticated persistence backend exists.
// Keep the input contract so saved conversations receive a clear failure.
import { z } from "zod";
import type { Tool } from "../../types.js";
import { buildTool } from "../registry.js";

const DesignSyncSchema = z.discriminatedUnion("method", [
  // Read methods
  z.object({
    method: z.literal("list_projects"),
  }),
  z.object({
    method: z.literal("get_project"),
    projectId: z.string(),
  }),
  z.object({
    method: z.literal("list_files"),
    projectId: z.string(),
  }),
  z.object({
    method: z.literal("get_file"),
    projectId: z.string(),
    path: z.string(),
  }),
  // Project creation
  z.object({
    method: z.literal("create_project"),
    name: z.string(),
  }),
  // Plan finalization
  z.object({
    method: z.literal("finalize_plan"),
    projectId: z.string(),
    localDir: z.string().optional(),
    writes: z.array(z.string()).optional(),
    deletes: z.array(z.string()).optional(),
  }),
  // Write operations (require planId)
  z.object({
    method: z.literal("write_files"),
    planId: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        localPath: z.string().optional(),
        data: z.string().optional(),
        encoding: z.enum(["base64"]).optional(),
        mimeType: z.string().optional(),
      }),
    ),
  }),
  z.object({
    method: z.literal("delete_files"),
    planId: z.string(),
    paths: z.array(z.string()),
  }),
  // Asset registration (require planId)
  z.object({
    method: z.literal("register_assets"),
    planId: z.string(),
    assets: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        group: z.string(),
        subtitle: z.string().optional(),
        viewport: z
          .object({
            width: z.number(),
            height: z.number().optional(),
          })
          .optional(),
      }),
    ),
  }),
  z.object({
    method: z.literal("unregister_assets"),
    planId: z.string(),
    paths: z.array(z.string()),
  }),
]);

export const DesignSyncTool: Tool = {
  ...buildTool({
    name: "DesignSync",
    description: "Design system synchronization (unavailable)",
    promptDescription:
      "DesignSync is not implemented. No remote project, file, or asset operations are available.",
    schema: DesignSyncSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    aliases: ["design_sync"],
    async call() {
      return {
        content: "",
        error:
          "DesignSync is not implemented: no authenticated storage backend is configured. No changes were made.",
      };
    },
  }),
  isEnabled: () => false,
};
