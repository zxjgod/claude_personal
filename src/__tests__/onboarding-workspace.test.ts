import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onboardingCommand } from "../commands/onboarding.js";
import type { CommandContext } from "../commands/types.js";
import type { ModelCaller } from "../types.js";

const fakeCaller: ModelCaller = async function* () {};
const originalCwd = process.cwd();

let workspace: string;
let otherCwd: string;

function makeCtx(): CommandContext {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    modelConfig: { provider: "openai", model: "test-model", apiKey: "test-key" },
    callModel: fakeCaller,
    workspaceRoot: workspace,
    sessionId: "onboarding-workspace-test",
  };
}

function makeWorkspaceReady(root: string): void {
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Fixture\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "LLM_API_KEY=test-key\n", "utf8");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "cli.js"), "// built fixture\n", "utf8");
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-onboarding-workspace-"));
  otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-onboarding-cwd-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(otherCwd, { recursive: true, force: true });
});

describe("/onboarding active workspace paths", () => {
  it("accepts CLAUDE.md, .env and build files from workspaceRoot when cwd differs", async () => {
    makeWorkspaceReady(workspace);
    process.chdir(otherCwd);

    const result = await onboardingCommand.run("", makeCtx());

    expect(result?.prompt).toBeUndefined();
  });

  it("does not let cwd files hide files missing from workspaceRoot", async () => {
    makeWorkspaceReady(otherCwd);
    process.chdir(otherCwd);

    const result = await onboardingCommand.run("", makeCtx());

    expect(result?.prompt).toContain("CLAUDE.md project memory");
    expect(result?.prompt).toContain(".env file");
    expect(result?.prompt).toContain("build (dist/cli.js)");
  });
});
