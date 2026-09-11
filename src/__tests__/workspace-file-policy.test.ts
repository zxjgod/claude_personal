import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportCommand } from "../commands/export.js";
import { shareCommand } from "../commands/share.js";
import type { CommandContext } from "../commands/types.js";
import { LspClient } from "../lsp.js";
import { LspCompletionsTool, LspDiagnosticsTool } from "../tools/breadth/index.js";

let base: string;
let root: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-file-policy-"));
  root = path.join(base, "workspace");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("workspace file policy", () => {
  it.each([
    exportCommand,
    shareCommand,
  ])("$name uses the current workspace for relative exports", (command) => {
    const context = {
      workspaceRoot: root,
      sessionId: "test",
      messages: [],
      modelConfig: { provider: "openai", model: "test" },
    } as unknown as CommandContext;
    command.run("reports/output.md", context);
    expect(fs.readFileSync(path.join(root, "reports/output.md"), "utf8")).toContain("test");
  });

  it.each([
    exportCommand,
    shareCommand,
  ])("$name refuses out-of-workspace and protected targets", (command) => {
    const context = {
      workspaceRoot: root,
      sessionId: "test",
      messages: [],
      modelConfig: { provider: "openai", model: "test" },
    } as unknown as CommandContext;
    const outside = path.join(base, "output.md");
    for (const target of [outside, "../output.md", ".claude/settings.json"]) {
      command.run(target, context);
    }
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(false);
  });

  it("rejects disallowed LSP paths before initializing a server or running fallback diagnostics", async () => {
    const client = new LspClient(root, "unused-tsserver.js");
    const initialize = vi.spyOn(LspClient.prototype, "ensureInitialized");
    const context = { workspaceRoot: root, sessionId: "test", permissionMode: "default" as const };
    for (const target of [path.join(base, "outside.ts"), "../outside.ts", ".claude/private.ts"]) {
      await expect(client.getDiagnostics(target)).rejects.toThrow(/Access denied/);
      await expect(client.getCompletions(target, 1, 1)).rejects.toThrow(/Access denied/);
      expect((await LspDiagnosticsTool.call({ filePath: target }, context)).error).toMatch(
        /Access denied/,
      );
      expect(
        (await LspCompletionsTool.call({ filePath: target, line: 1, column: 1 }, context)).error,
      ).toMatch(/Access denied/);
    }
    expect(initialize).not.toHaveBeenCalled();
  });
});
