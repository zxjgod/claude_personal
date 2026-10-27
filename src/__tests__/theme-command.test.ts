import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../cli-config.js";
import { themeCommand } from "../commands/theme.js";
import type { CommandContext } from "../commands/types.js";
import { readUserSettings } from "../settings.js";
import { applyTheme, currentTheme } from "../tui/theme.js";
import type { ModelCaller } from "../types.js";

const fakeCaller: ModelCaller = async function* () {};

let workspace: string;
let userDir: string;

function makeCtx(): CommandContext {
  return {
    messages: [],
    modelConfig: { provider: "openai", model: "test-model", apiKey: "test-key" },
    callModel: fakeCaller,
    workspaceRoot: workspace,
    sessionId: "theme-test",
  };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-theme-workspace-"));
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-theme-user-"));
  vi.stubEnv("CCR_USER_CONFIG_DIR", userDir);
  vi.stubEnv("CCR_SETTING_SOURCES", "user");
  vi.stubEnv("CCR_MANAGED_SETTINGS", undefined);
  vi.stubEnv("WORKSPACE_ROOT", workspace);
  vi.stubEnv("LLM_API_KEY", "test-key");
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_MODEL", "test-model");
  vi.spyOn(console, "log").mockImplementation(() => {});
  applyTheme("dark");
});

afterEach(() => {
  applyTheme("dark");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
});

describe("/theme settings persistence", () => {
  it("writes through the user settings source and applies the theme immediately", async () => {
    const ctx = makeCtx();

    await themeCommand.run("light", ctx);

    expect(currentTheme()).toBe("light");
    expect(ctx.modelConfig.options?.theme).toBe("light");
    expect(readUserSettings().theme).toBe("light");
  });

  it("loads the same user setting for the existing startup theme restoration", () => {
    fs.writeFileSync(
      path.join(userDir, "settings.json"),
      JSON.stringify({ theme: "light" }),
      "utf8",
    );

    const config = loadConfig();

    // runTui applies modelConfig.options.theme before its first frame.
    expect(config.options?.theme).toBe("light");
  });
});
