// ============================================================
// DesignSync Tests
// ============================================================

import { beforeEach, describe, expect, it } from "vitest";
import {
  DESIGN_PLANS,
  DESIGN_PROJECTS,
  DesignSyncTool,
  designSystemAPI,
  resetDesignSync,
} from "../tools/extended/design-sync.js";
import type { ToolContext } from "../types.js";

describe("DesignSync", () => {
  const sessionId = "test-session";
  const projectId = "proj-test-123";

  function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      workspaceRoot: "/test/workspace",
      sessionId,
      permissionMode: "default",
      ...overrides,
    } as ToolContext;
  }

  beforeEach(() => {
    resetDesignSync();
  });

  describe("list_projects", () => {
    it("should list design system projects", async () => {
      const result = await DesignSyncTool.call({ method: "list_projects" }, ctx());

      expect(result.content).toContain("No writable design system projects");
    });

    it("should show projects after creation", async () => {
      // Create a project first
      await DesignSyncTool.call({ method: "create_project", name: "Test Design System" }, ctx());

      const result = await DesignSyncTool.call({ method: "list_projects" }, ctx());

      expect(result.content).toContain("Test Design System");
    });
  });

  describe("get_project", () => {
    it("should get project metadata", async () => {
      const result = await DesignSyncTool.call({ method: "get_project", projectId }, ctx());

      expect(result.content).toContain("Project:");
      expect(result.content).toContain("Type:");
      expect(result.content).toContain("Can Edit:");
    });
  });

  describe("list_files", () => {
    it("should list files in a project", async () => {
      const result = await DesignSyncTool.call({ method: "list_files", projectId }, ctx());

      expect(result.content).toContain("empty");
    });
  });

  describe("get_file", () => {
    it("should return error for non-existent file", async () => {
      const result = await DesignSyncTool.call(
        { method: "get_file", projectId, path: "components/button.html" },
        ctx(),
      );

      expect(result.error).toContain("not found");
    });
  });

  describe("create_project", () => {
    it("should create a new design system project", async () => {
      const result = await DesignSyncTool.call(
        { method: "create_project", name: "My Design System" },
        ctx(),
      );

      expect(result.content).toContain("Created design system project");
      expect(result.content).toContain("My Design System");
      expect(result.content).toContain("Project ID:");
    });

    it("should store project in session registry", async () => {
      await DesignSyncTool.call({ method: "create_project", name: "Test System" }, ctx());

      const projects = DESIGN_PROJECTS.get(sessionId);
      expect(projects).toHaveLength(1);
      expect(projects?.[0]?.name).toBe("Test System");
    });
  });

  describe("finalize_plan", () => {
    it("should create a plan with write/delete patterns", async () => {
      const result = await DesignSyncTool.call(
        {
          method: "finalize_plan",
          projectId,
          localDir: "/test/components",
          writes: ["components/**/*.html", "styles/**/*.css"],
          deletes: ["old/**/*"],
        },
        ctx(),
      );

      expect(result.content).toContain("Plan finalized:");
      expect(result.content).toContain("Writes: 2 patterns");
      expect(result.content).toContain("Deletes: 1 patterns");
    });

    it("should return planId for use in write operations", async () => {
      const result = await DesignSyncTool.call(
        {
          method: "finalize_plan",
          projectId,
          writes: ["**/*.html"],
        },
        ctx(),
      );

      expect(result.content).toMatch(/plan-[a-z0-9]+-\d+/);
    });

    it("should store plan in registry", async () => {
      await DesignSyncTool.call(
        {
          method: "finalize_plan",
          projectId,
          writes: ["**/*.html"],
        },
        ctx(),
      );

      expect(DESIGN_PLANS.size).toBe(1);
      const plan = Array.from(DESIGN_PLANS.values())[0];
      expect(plan?.projectId).toBe(projectId);
      expect(plan?.writes).toEqual(["**/*.html"]);
    });
  });

  describe("write_files", () => {
    it("should require a valid planId", async () => {
      const result = await DesignSyncTool.call(
        {
          method: "write_files",
          planId: "invalid-plan",
          files: [{ path: "test.html", data: "<html></html>" }],
        },
        ctx(),
      );

      expect(result.error).toContain("not found or expired");
    });

    it("should validate paths against plan", async () => {
      // Create a plan
      const planResult = await DesignSyncTool.call(
        {
          method: "finalize_plan",
          projectId,
          writes: ["components/*.html"],
        },
        ctx(),
      );

      const planId = planResult.content?.match(/plan-[a-z0-9]+-\d+/)?.[0];

      // Try to write a file outside the plan
      const result = await DesignSyncTool.call(
        {
          method: "write_files",
          planId: planId!,
          files: [{ path: "styles/main.css", data: "body {}" }],
        },
        ctx(),
      );

      expect(result.error).toContain("not in plan's write list");
    });

    it("should write files within plan", async () => {
      // Create a plan
      const planResult = await DesignSyncTool.call(
        {
          method: "finalize_plan",
          projectId,
          writes: ["components/**/*.html"],
        },
        ctx(),
      );

      const planId = planResult.content?.match(/plan-[a-z0-9]+-\d+/)?.[0];

      // Write files
      const result = await DesignSyncTool.call(
        {
          method: "write_files",
          planId: planId!,
          files: [
            { path: "components/button.html", data: "<button>Click me</button>" },
            { path: "components/card.html", data: "<div>Card</div>" },
          ],
        },
        ctx(),
      );

      expect(result.content).toContain("Wrote 2 file(s)");
    });
  });

  describe("delete_files", () => {
    it("should require a valid planId", async () => {
      const result = await DesignSyncTool.call(
        {
          method: "delete_files",
          planId: "invalid-plan",
          paths: ["old/file.html"],
        },
        ctx(),
      );

      expect(result.error).toContain("not found or expired");
    });

    it("should validate paths against plan", async () => {
      // Create a plan
      const planResult = await DesignSyncTool.call(
        {
          method: "finalize_plan",
          projectId,
          deletes: ["old/**/*"],
        },
        ctx(),
      );

      const planId = planResult.content?.match(/plan-[a-z0-9]+-\d+/)?.[0];

      // Try to delete outside plan
      const result = await DesignSyncTool.call(
        {
          method: "delete_files",
          planId: planId!,
          paths: ["components/button.html"],
        },
        ctx(),
      );

      expect(result.error).toContain("not in plan's delete list");
    });

    it("should delete files within plan", async () => {
      // Create a plan
      const planResult = await DesignSyncTool.call(
        {
          method: "finalize_plan",
          projectId,
          deletes: ["old/**/*"],
        },
        ctx(),
      );

      const planId = planResult.content?.match(/plan-[a-z0-9]+-\d+/)?.[0];

      // Delete files
      const result = await DesignSyncTool.call(
        {
          method: "delete_files",
          planId: planId!,
          paths: ["old/deprecated.html"],
        },
        ctx(),
      );

      expect(result.content).toContain("Deleted 1 file(s)");
    });
  });

  describe("register_assets", () => {
    it("should require a valid planId", async () => {
      const result = await DesignSyncTool.call(
        {
          method: "register_assets",
          planId: "invalid-plan",
          assets: [{ name: "Button", path: "button.html", group: "Components" }],
        },
        ctx(),
      );

      expect(result.error).toContain("not found or expired");
    });

    it("should register assets", async () => {
      // Create a plan
      const planResult = await DesignSyncTool.call(
        {
          method: "finalize_plan",
          projectId,
          writes: ["**/*.html"],
        },
        ctx(),
      );

      const planId = planResult.content?.match(/plan-[a-z0-9]+-\d+/)?.[0];

      // Register assets
      const result = await DesignSyncTool.call(
        {
          method: "register_assets",
          planId: planId!,
          assets: [
            {
              name: "Button",
              path: "components/button.html",
              group: "Actions",
              viewport: { width: 400, height: 200 },
            },
          ],
        },
        ctx(),
      );

      expect(result.content).toContain("Registered 1 asset(s)");
    });
  });

  describe("unregister_assets", () => {
    it("should require a valid planId", async () => {
      const result = await DesignSyncTool.call(
        {
          method: "unregister_assets",
          planId: "invalid-plan",
          paths: ["button.html"],
        },
        ctx(),
      );

      expect(result.error).toContain("not found or expired");
    });

    it("should unregister assets", async () => {
      // Create a plan
      const planResult = await DesignSyncTool.call(
        {
          method: "finalize_plan",
          projectId,
          deletes: ["**/*.html"],
        },
        ctx(),
      );

      const planId = planResult.content?.match(/plan-[a-z0-9]+-\d+/)?.[0];

      // Unregister assets
      const result = await DesignSyncTool.call(
        {
          method: "unregister_assets",
          planId: planId!,
          paths: ["components/button.html"],
        },
        ctx(),
      );

      expect(result.content).toContain("Unregistered 1 asset(s)");
    });
  });

  describe("workflow", () => {
    it("should support complete sync workflow", async () => {
      // 1. Create project
      const createResult = await DesignSyncTool.call(
        { method: "create_project", name: "Component Library" },
        ctx(),
      );
      expect(createResult.content).toContain("Created design system project");

      const newProjectId = createResult.content?.match(/Project ID: ([^\n]+)/)?.[1];

      // 2. List projects
      const listResult = await DesignSyncTool.call({ method: "list_projects" }, ctx());
      expect(listResult.content).toContain("Component Library");

      // 3. Finalize plan
      const planResult = await DesignSyncTool.call(
        {
          method: "finalize_plan",
          projectId: newProjectId!,
          writes: ["components/**/*.html"],
        },
        ctx(),
      );
      const planId = planResult.content?.match(/plan-[a-z0-9]+-\d+/)?.[0];

      // 4. Write files
      const writeResult = await DesignSyncTool.call(
        {
          method: "write_files",
          planId: planId!,
          files: [{ path: "components/button.html", data: "<button>Click</button>" }],
        },
        ctx(),
      );
      expect(writeResult.content).toContain("Wrote 1 file(s)");
    });
  });
});
