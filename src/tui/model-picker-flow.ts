import { applyProfile, loadProviderProfiles } from "../provider-profiles.js";
import type { ModelConfig } from "../types.js";
import { lookupContextWindow } from "./session-stats.js";
import type { TuiStore } from "./store.js";

/** Keep the selected profile's endpoint, credentials and model together. */
export async function runModelPicker(
  store: TuiStore,
  config: ModelConfig,
  workspaceRoot: string,
): Promise<void> {
  const profiles = loadProviderProfiles(workspaceRoot);
  if (profiles.length === 0) {
    store.addNotice("  No saved models — add .claude/providers.json or use /model <id>.");
    return;
  }

  const choices = profiles.map((profile, index) => {
    const resolved = { ...config };
    applyProfile(resolved, profile);
    return { id: `profile:${index}`, profile, resolved };
  });
  const chosen = await store.askModelPicker([
    {
      id: "current",
      name: config.model,
      label: `${config.provider}/${config.model}`,
      current: true,
    },
    ...choices.map(({ id, profile, resolved }) => ({
      id,
      name: profile.name,
      label: `${resolved.provider}/${resolved.model}`,
      current: false,
    })),
  ]);
  const choice = choices.find((item) => item.id === chosen);
  if (!choice) return;

  const previous = `${config.provider}/${config.model}`;
  applyProfile(config, choice.profile);
  const next = `${config.provider}/${config.model}`;
  store.setModel(config.model, next);
  store.setContextLimit(lookupContextWindow(config.model) ?? 0);
  store.addNotice(`  Model: ${previous} → ${next} (${choice.profile.name})`);
}
