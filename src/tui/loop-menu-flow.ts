import {
  currentLoop,
  type LoopScope,
  startLoop,
  updateActiveLoop,
  validateLoopUpdate,
} from "../loop-runtime.js";
import { loopConfig, persistLoopConfig } from "../loop-settings.js";
import type { TuiStore } from "./store.js";

export async function runLoopMenu(store: TuiStore, scope: LoopScope): Promise<void> {
  await store.openLoopMenu({
    scope,
    config: loopConfig(scope.workspaceRoot),
    onConfigure: (profile, partial) => {
      const active = currentLoop(scope);
      const selected = loopConfig(scope.workspaceRoot, profile);
      if (selected.completion === "model" && (partial.commands?.length || partial.files?.length))
        partial = { ...partial, completion: "hybrid" };
      if (active?.config.profile === profile) validateLoopUpdate(active, partial);
      const config = persistLoopConfig(scope.workspaceRoot, profile, partial);
      if (active?.config.profile === profile && Object.keys(partial).length > 0)
        updateActiveLoop(scope, partial);
      return config;
    },
    onStart: (objective) => {
      startLoop(scope, objective, loopConfig(scope.workspaceRoot));
    },
  });
}
