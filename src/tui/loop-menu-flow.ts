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
      const config = loopConfig(scope.workspaceRoot);
      startLoop(scope, objective, config);
      // Same quality guidance as the CLI path: a loop without machine-
      // checkable acceptance can only end on the model's self-assessment.
      if (config.completion !== "continuous" && !config.commands.length && !config.files.length)
        store.addNotice(
          "  No completion checks configured — add commands/files (menu item 6) so quality is verified objectively.",
        );
    },
  });
}
