import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelPicker } from "../tui/ModelPicker.js";
import { runModelPicker } from "../tui/model-picker-flow.js";
import { TuiStore } from "../tui/store.js";
import type { ModelConfig } from "../types.js";

describe("model picker profile selection", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-model-picker-"));
    fs.mkdirSync(path.join(root, ".claude"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function choose(profiles: object[], key: string, config: ModelConfig) {
    fs.writeFileSync(path.join(root, ".claude", "providers.json"), JSON.stringify({ profiles }));
    const store = new TuiStore(`${config.provider}/${config.model}`);
    const done = runModelPicker(store, config, root);
    const overlay = store.getSnapshot().overlay;
    if (overlay?.kind !== "modelPicker") throw new Error("Missing model picker");
    const app = render(<ModelPicker overlay={overlay} />);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      app.stdin.write(key);
      await done;
      return store.getSnapshot();
    } finally {
      app.unmount();
    }
  }

  it("switches provider, endpoint and key even when the selected model name is unchanged", async () => {
    const config: ModelConfig = {
      provider: "openai",
      model: "shared-model",
      apiKey: "old-key",
      baseURL: "https://old.example/v1",
    };
    const snapshot = await choose(
      [
        {
          name: "relay-a",
          provider: "openai",
          model: "shared-model",
          apiKey: "a",
          baseURL: "https://a.example/v1",
        },
        {
          name: "relay-b",
          provider: "anthropic",
          model: "shared-model",
          apiKey: "b",
          baseURL: "https://b.example",
        },
      ],
      "3",
      config,
    );
    expect(config).toMatchObject({
      provider: "anthropic",
      model: "shared-model",
      apiKey: "b",
      baseURL: "https://b.example",
    });
    expect(snapshot.modelLabel).toBe("anthropic/shared-model");
  });

  it("resolves an omitted model using provider defaults instead of the literal default", async () => {
    const config: ModelConfig = { provider: "openai", model: "old", apiKey: "old-key" };
    await choose(
      [{ name: "deepseek", provider: "deepseek", apiKey: "new-key" }],
      "\x1b[B\r",
      config,
    );
    expect(config).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "new-key",
    });
  });

  it("keeps the configuration unchanged when cancelled", async () => {
    const config: ModelConfig = { provider: "openai", model: "old", apiKey: "old-key" };
    const before = { ...config };
    await choose([{ name: "other", provider: "deepseek", apiKey: "new-key" }], "\x1b", config);
    expect(config).toEqual(before);
  });
});
