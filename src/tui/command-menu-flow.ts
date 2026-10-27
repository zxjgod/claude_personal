// ============================================================
// Command option menus — bare /agents and /memory-approval open a档位式
// TogglePicker overlay (each row = one setting, ←/→ flips it in place,
// every flip persists IMMEDIATELY, Enter/Esc closes). history/list remain
// text subcommands (/agents history, /agents list). Toggles persist to the
// resolved settings target (settings-target.ts): user level for a global
// install, project level for a local run.
// ============================================================

import { isMemoryApprovalRequired, persistMemoryApproval } from "../memory-approval.js";
import { settingsWriteTarget } from "../settings-target.js";
import type { SidechainMode } from "../subagent-settings.js";
import {
  getSubagentSettings,
  persistSubagentSettings,
  subagentSettingsWriteLabel,
} from "../subagent-settings.js";
import type { TuiStore } from "./store.js";

/** Bare /agents → thinking / sidechain toggle rows. */
export async function runAgentsMenu(store: TuiStore, workspaceRoot: string): Promise<void> {
  const s = getSubagentSettings();
  await store.openTogglePicker(
    "子代理设置 (subagents)",
    `持久化到 ${subagentSettingsWriteLabel(workspaceRoot)} · /agents history 运行记录 · /agents list 角色列表`,
    [
      {
        id: "thinking",
        label: "thinking",
        values: ["off", "on"],
        current: s.thinking ? "on" : "off",
        detail: "子代理 extended thinking（可被 frontmatter thinking: 覆盖）",
      },
      {
        id: "sidechain",
        label: "sidechain",
        values: ["audit", "report"],
        current: s.sidechainMode,
        detail: "audit=全量审计+Resume 数据源 / report=仅最终报告回流",
      },
    ],
    (rowId, value) => {
      // 即刻生效 — persist on every flip, not on close. A refused write (e.g. a
      // corrupt settings.json) must not take the TUI down with it.
      try {
        if (rowId === "thinking")
          persistSubagentSettings(workspaceRoot, { thinking: value === "on" });
        else persistSubagentSettings(workspaceRoot, { sidechainMode: value as SidechainMode });
        return true;
      } catch (error) {
        console.error(`设置未保存: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  );
}

/** Bare /memory-approval → on/off toggle row. */
export async function runMemoryApprovalMenu(store: TuiStore, workspaceRoot: string): Promise<void> {
  await store.openTogglePicker(
    "记忆写入审批门 (memory-approval)",
    `持久化到 ${settingsWriteTarget(workspaceRoot, "memory").label} · managed 设置可强制 ON`,
    [
      {
        id: "gate",
        label: "requireApproval",
        // 默认档位一律排左边（off 是默认）— 与 thinking/sidechain 行一致。
        values: ["off", "on"],
        current: isMemoryApprovalRequired() ? "on" : "off",
        detail: "off=免审批（默认；deny 与 plan 仍生效） / on=每次写入需批准（T2 严格姿态）",
      },
    ],
    (_rowId, value) => {
      try {
        const { effective, pinnedBy } = persistMemoryApproval(value === "on", workspaceRoot);
        // An off-toggle can still lose to a higher-precedence true (project/
        // local/managed layer). Returning false keeps the picker's previous
        // value visible; explain why the gate itself did not change.
        if (pinnedBy) console.error(`审批门仍被 ${pinnedBy} 强制开启（off 已写入但未生效）`);
        return effective === (value === "on");
      } catch (error) {
        console.error(`设置未保存: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  );
}
