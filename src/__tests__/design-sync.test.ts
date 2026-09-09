import { describe, expect, it } from "vitest";
import { getCoreToolsForSubagents, setCoreToolsForSubagents } from "../subagents.js";
import { DesignSyncTool } from "../tools/extended/design-sync.js";
import { ToolRegistry } from "../tools/registry.js";

describe("DesignSync unavailable backend", () => {
  it("is also excluded from subagent tool sets", async () => {
    const original = await getCoreToolsForSubagents();
    try {
      setCoreToolsForSubagents([DesignSyncTool]);
      expect(await getCoreToolsForSubagents()).toEqual([]);
    } finally {
      setCoreToolsForSubagents(original);
    }
  });
  it("is excluded from enabled tools", () => {
    const registry = new ToolRegistry();
    registry.register(DesignSyncTool);
    expect(registry.getEnabledTools()).not.toContain(DesignSyncTool);
  });

  it.each([
    "list_projects",
    "get_project",
    "list_files",
    "get_file",
    "create_project",
    "finalize_plan",
    "write_files",
    "delete_files",
    "register_assets",
    "unregister_assets",
  ])("fails explicitly for saved %s calls without claiming success", async (method) => {
    const result = await DesignSyncTool.call(
      { method },
      {
        workspaceRoot: process.cwd(),
        sessionId: "design-unavailable",
        permissionMode: "default",
      },
    );
    expect(result.error).toContain("not implemented");
    expect(result.content).toBe("");
  });
});
