// ============================================================
// Micro-Compact Configuration
// ============================================================
// Time-based tool result clearing configuration. Triggers when the gap since
// the last assistant message exceeds a threshold — the conversation has been
// idle long enough that old tool results are likely stale and can be safely
// cleared to reclaim context space.

export interface MicroCompactConfig {
  /** Master switch. When false, micro-compact is a no-op. */
  enabled: boolean;
  /** Trigger when (now - last assistant timestamp) exceeds this many minutes. */
  gapThresholdMinutes: number;
  /** Keep this many most-recent compactable tool results. Older ones are cleared. */
  keepRecent: number;
  /** Set of tool names whose results are eligible for clearing. */
  compactableTools: Set<string>;
}

const DEFAULT_COMPACTABLE_TOOLS = new Set([
  "read",
  "bash",
  "powershell",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
  "edit",
  "write",
  "lsp_diagnostics",
]);

const DEFAULT_CONFIG: MicroCompactConfig = {
  enabled: true,
  gapThresholdMinutes: 60, // 1 hour - safe default, cache TTL expired
  keepRecent: 5,
  compactableTools: DEFAULT_COMPACTABLE_TOOLS,
};

/**
 * Get the micro-compact configuration, with environment variable overrides.
 *
 * Environment variables:
 * - CCR_MICROCOMPACT_ENABLED: "1" or "0" to enable/disable
 * - CCR_MICROCOMPACT_GAP_MINUTES: integer threshold in minutes
 * - CCR_MICROCOMPACT_KEEP_RECENT: integer count of recent results to keep
 */
export function getMicroCompactConfig(): MicroCompactConfig {
  const envEnabled = process.env.CCR_MICROCOMPACT_ENABLED;
  const envGap = process.env.CCR_MICROCOMPACT_GAP_MINUTES;
  const envKeep = process.env.CCR_MICROCOMPACT_KEEP_RECENT;

  return {
    ...DEFAULT_CONFIG,
    enabled: envEnabled
      ? envEnabled === "1" || envEnabled.toLowerCase() === "true"
      : DEFAULT_CONFIG.enabled,
    gapThresholdMinutes:
      envGap && !Number.isNaN(Number.parseInt(envGap, 10))
        ? Math.max(1, Number.parseInt(envGap, 10)) // Floor at 1 — review fix
        : // ("负阈值"): keepRecent had the floor but gap did not, so
          // CCR_MICROCOMPACT_GAP_MINUTES=-5 made EVERY result eligible for
          // immediate compaction.
          DEFAULT_CONFIG.gapThresholdMinutes,
    keepRecent:
      envKeep && !Number.isNaN(Number.parseInt(envKeep, 10))
        ? Math.max(1, Number.parseInt(envKeep, 10)) // Floor at 1
        : DEFAULT_CONFIG.keepRecent,
  };
}
