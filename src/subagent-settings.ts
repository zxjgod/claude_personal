// ============================================================
// Subagent runtime settings — thinking default + sidechain mode
// ============================================================
// Backing store: the "subagents" object in the resolved settings.json (see
// settings-target.ts — user level for a global install, project level for a
// local run), e.g. { "subagents": { "thinking": true, "sidechainMode": "report" } }.
//
//   - thinking (default FALSE, 拍板 #21 = official 2.1.88): sub-agents run
//     with extended thinking OFF — a sub-agent is a task executor, and the
//     parent's thinking budget must not bleed into it. An agent frontmatter
//     `thinking: true` overrides per-type.
//   - sidechainMode (default "audit", 拍板 #22): "audit" writes the full
//     sidechain transcript (every sub-agent tool call + the final report) for
//     post-hoc debugging and as the data source of a future Resume subsystem
//     (#19); "report" writes ONLY the final report line (仅最终报告回流).
//
// Startup calls initSubagentSettings() once with the merged settings; the
// /agents slash command mutates via persistSubagentSettings() which updates
// both the on-disk file and the live runtime value.
// ============================================================

import { readSettingsFileStrict, type Settings } from "./settings.js";
import { settingsWriteTarget } from "./settings-target.js";
import { atomicWriteFile, withFileLock } from "./utils/file-lock.js";

export type SidechainMode = "audit" | "report";

export interface SubagentSettings {
  thinking: boolean;
  sidechainMode: SidechainMode;
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
  thinking: false,
  sidechainMode: "audit",
};

let runtime: SubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS };

function parse(raw: unknown): SubagentSettings {
  const section = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    thinking:
      typeof section.thinking === "boolean" ? section.thinking : DEFAULT_SUBAGENT_SETTINGS.thinking,
    sidechainMode:
      section.sidechainMode === "report" || section.sidechainMode === "audit"
        ? section.sidechainMode
        : DEFAULT_SUBAGENT_SETTINGS.sidechainMode,
  };
}

/** Current live values (startup-initialized, /agents-mutated). */
export function getSubagentSettings(): SubagentSettings {
  return runtime;
}

/** Apply the merged settings once at startup (key: "subagents"). */
export function initSubagentSettings(merged: Settings): void {
  runtime = parse(merged.subagents);
}

/** Update the live runtime value only (tests, in-session overrides). */
export function setSubagentSettings(partial: Partial<SubagentSettings>): void {
  runtime = { ...runtime, ...partial };
}

/**
 * Persist a change to the settings layer that OWNS the `subagents` key (or the
 * install-level default when no layer does — see settings-target.ts), keeping
 * every other key, AND update the live runtime value. Throws when the target
 * file exists but is not valid JSON: rewriting it from a `{}` read would
 * delete every other setting in it.
 */
export function persistSubagentSettings(
  workspaceRoot: string,
  partial: Partial<SubagentSettings>,
): SubagentSettings {
  const target = settingsWriteTarget(workspaceRoot, "subagents");
  // Read-modify-write INSIDE the lock (review fix "锁外 RMW 覆盖他进程设置"):
  // a concurrent /memory-approval write between our read and our atomic write
  // used to be silently reverted.
  withFileLock(target.file, () => {
    const { value: existing, corrupt } = readSettingsFileStrict(target.file);
    if (corrupt) {
      throw new Error(
        `${target.file} is not valid JSON — fix or delete it before toggling ` +
          `(refusing to rewrite it: every other setting in it would be lost).`,
      );
    }
    const merged: Settings = {
      ...existing,
      subagents: { ...parse(existing.subagents), ...partial },
    };
    atomicWriteFile(target.file, `${JSON.stringify(merged, null, 2)}\n`);
  });
  runtime = { ...runtime, ...partial };
  return runtime;
}

/** Layer a `/agents` toggle would be written to (for command output). */
export function subagentSettingsWriteLabel(workspaceRoot: string): string {
  return settingsWriteTarget(workspaceRoot, "subagents").label;
}
