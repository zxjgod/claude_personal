import { applyProfile, loadProviderProfiles, type ProviderProfile } from "../provider-profiles.js";
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

  const choices: { id: string; profile: ProviderProfile; resolved: ModelConfig }[] = [];
  for (const [index, profile] of profiles.entries()) {
    const resolved = { ...config };
    try {
      applyProfile(resolved, profile);
    } catch {
      continue; // profile changes endpoint without credentials — not switchable
    }
    choices.push({ id: `profile:${index}`, profile, resolved });
  }
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
  try {
    applyProfile(config, choice.profile);
  } catch (error) {
    store.addNotice(`  Cannot switch: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const next = `${config.provider}/${config.model}`;
  store.setModel(config.model, next);
  store.setContextLimit(lookupContextWindow(config.model) ?? 0);
  store.addNotice(`  Model: ${previous} → ${next} (${choice.profile.name})`);
}
