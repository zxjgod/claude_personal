import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerCommand } from "../commands/provider.js";
import type { CommandContext } from "../commands/types.js";
import { applyProfile, loadProviderProfiles, type ProviderProfile } from "../provider-profiles.js";
import { promptSelectMenu } from "../tui/cli-interactive.js";
import { ProviderPicker } from "../tui/ProviderPicker.js";

vi.mock("../provider-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provider-profiles.js")>();
  return { ...actual, applyProfile: vi.fn(), loadProviderProfiles: vi.fn() };
});

vi.mock("../tui/cli-interactive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tui/cli-interactive.js")>();
  return { ...actual, promptSelectMenu: vi.fn() };
});

const RAW_NAME = "relay\x1b[31m";
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

function makeContext(): CommandContext {
  return {
    messages: [],
    modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "current" },
    callModel: async function* () {},
    workspaceRoot: "/workspace",
    sessionId: "sess-1",
    systemPrompt: "system",
  };
}

function forceStdinTTY(): () => void {
  const previous = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  return () => {
    if (previous) Object.defineProperty(process.stdin, "isTTY", previous);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider picker display and identity", () => {
  it("raw /provider selects by the original value, not the sanitized label", async () => {
    const profile: ProviderProfile = {
      name: RAW_NAME,
      provider: "openai",
      model: "gpt-4o",
      apiKey: "profile-key",
    };
    vi.mocked(loadProviderProfiles).mockReturnValue([profile]);
    vi.mocked(promptSelectMenu).mockImplementation(async (opts) => {
      const option = opts.options[0];
      if (!option) throw new Error("expected a provider option");
      return [option.value ?? option.label];
    });
    const ctx = makeContext();
    const restoreTTY = forceStdinTTY();
    try {
      await providerCommand.run("", ctx);
    } finally {
      restoreTTY();
    }

    const options = vi.mocked(promptSelectMenu).mock.calls[0]?.[0].options ?? [];
    expect(options[0]).toMatchObject({ label: "relay", value: RAW_NAME });
    expect(applyProfile).toHaveBeenCalledWith(ctx.modelConfig, profile);
  });

  it("Ink ProviderPicker sanitizes the rendered name but resolves the raw name", async () => {
    const resolve = vi.fn();
    const overlay = {
      kind: "providerPicker" as const,
      profiles: [{ name: RAW_NAME, label: "openai/gpt-4o", current: true }],
      resolve,
    };
    const { lastFrame, stdin, unmount } = render(<ProviderPicker overlay={overlay} />);
    await flush();
    expect(lastFrame()).toContain("relay");
    expect(lastFrame()).not.toContain("\x1b[31m");
    stdin.write("\r");
    expect(resolve).toHaveBeenCalledWith(RAW_NAME);
    unmount();
  });
});
