import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@vscode/ripgrep", () => {
  throw new Error("simulate missing binary");
});

import { GrepTool } from "../tools/core/grep.js";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-grep-fallback-"));
const workspace = path.join(fixture, "workspace");
fs.mkdirSync(workspace);
const context = {
  workspaceRoot: workspace,
  sessionId: "fallback",
  permissionMode: "default" as const,
};
afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

it("fallback rejects secrets and glob traversal while preserving valid searches", async () => {
  fs.writeFileSync(path.join(workspace, "public.txt"), "PROBE=PUBLIC");
  fs.writeFileSync(path.join(workspace, "credentials.json"), "PROBE=SECRET");
  fs.writeFileSync(path.join(fixture, "outside.txt"), "PROBE=OUTSIDE");
  expect(
    (await GrepTool.call({ pattern: "PROBE", path: "public.txt" }, context)).content,
  ).toContain("PUBLIC");
  const scan = await GrepTool.call({ pattern: "PROBE", glob: "**/*" }, context);
  expect(scan.content).toContain("PUBLIC");
  expect(scan.content).not.toContain("SECRET");
  expect(
    (await GrepTool.call({ pattern: "PROBE", glob: "../*.txt" }, context)).content,
  ).not.toContain("OUTSIDE");
});
