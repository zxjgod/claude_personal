// ============================================================
// StatusBar — bottom status bar, shared by App and FullScreenApp (P1-6)
// ============================================================
// One row of session facts that used to be scattered or missing entirely:
//
//   deepseek/chat-v3 · accept edits · ↑72k ↓3.1k · ctx ███████░ 88% · $0.42
//
//   • model label   — which provider/model is answering (survives scrolling
//                     past the welcome banner)
//   • permission    — friendly mode badge, colored via theme
//   • tokens        — session totals, k-formatted (formatTokens)
//   • ctx gauge     — how full the context window is after the last call;
//                     green < 75%, yellow ≥ 75% (agent-loop's auto-compact
//                     trigger ratio), red ≥ 90%
//   • cost          — best-effort USD from session-stats pricing
//
// Narrow terminals degrade segment-by-segment (drop cost → shrink the gauge
// to a bare percent → drop the model label) instead of wrapping and pushing
// the input box off-screen. The busy/idle hint and mode badge always stay.
// ============================================================

import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { t } from "./i18n.js";
import { estimateCost, formatUsd } from "./session-stats.js";
import { formatTokens } from "./spinner-core.js";
import { CTX_CRITICAL_PCT, CTX_WARN_PCT, type StoreState, type TuiStore } from "./store.js";
import { terminalColumns, visualWidth } from "./terminal-width.js";
import { modeColor, modeLabel, palette } from "./theme.js";
import { useStoreSelector } from "./useStoreSelector.js";

const GAUGE_CELLS = 8;
const SEPARATOR = " · ";

function selectStatusBar(s: StoreState) {
  return {
    busy: s.busy,
    permissionMode: s.permissionMode,
    modelLabel: s.modelLabel,
    modelId: s.modelId,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    contextUsed: s.contextUsed,
    contextLimit: s.contextLimit,
    queuedInputs: s.queuedInputs,
  };
}

/** Gauge color by fill fraction. Thresholds mirror store.ts's crossing toasts
 *  (and agent-loop's 150k-on-200k compact default = 75%). */
export function gaugeColor(fraction: number): string {
  if (fraction >= CTX_CRITICAL_PCT) return palette.error;
  if (fraction >= CTX_WARN_PCT) return "#e0af68";
  return palette.success;
}

/** The 8-cell gauge string for a fill fraction, e.g. 0.5 → "████░░░░". */
export function gaugeBar(fraction: number): string {
  const filled = Math.max(0, Math.min(GAUGE_CELLS, Math.round(fraction * GAUGE_CELLS)));
  return "█".repeat(filled) + "░".repeat(GAUGE_CELLS - filled);
}

/** One droppable status-bar segment: the plain text (for width measurement),
 *  its visual width, and the styled node to render. */
interface Segment {
  text: string;
  width: number;
  node: ReactNode;
}

function segment(text: string, node: ReactNode): Segment {
  return { text, width: visualWidth(text), node };
}

/** Total rendered width of a segment list, separators included. */
function rowWidth(segments: Segment[]): number {
  let w = 0;
  for (let i = 0; i < segments.length; i++)
    w += segments[i]!.width + (i > 0 ? SEPARATOR.length : 0);
  return w;
}

export function StatusBar({
  store,
  idleHint,
}: {
  store: TuiStore;
  /** Idle-state hint text; defaults to the i18n idle hint (P3-13: one source,
   *  follows LANG/CCR_LANGUAGE). The full-screen app passes its own variant. */
  idleHint?: string;
}) {
  const s = useStoreSelector(store, selectStatusBar);
  const fraction = s.contextLimit > 0 ? Math.min(1, s.contextUsed / s.contextLimit) : 0;
  const pct = Math.floor(fraction * 100);

  // --- Build every segment, then drop the least-important ones until the row
  // fits one line. Drop order: cost, gauge bar (keep the percent), model.
  // Mode + tokens always stay — they're short and load-bearing.

  const hintText = s.busy ? t("ui.status.busy") : (idleHint ?? t("ui.status.idle"));
  const hint = segment(hintText, <Text dimColor>{hintText}</Text>);

  const modeText = modeLabel(s.permissionMode);
  const mode = segment(
    modeText,
    <Text color={modeColor(s.permissionMode)} bold>
      {modeText}
    </Text>,
  );

  const tokensText = `↑${formatTokens(s.tokensIn)} ↓${formatTokens(s.tokensOut)} tokens`;
  const tokens = segment(tokensText, <Text dimColor>{tokensText}</Text>);

  const costValue = s.modelId ? estimateCost(s.modelId, s.tokensIn, s.tokensOut) : null;
  const costText = costValue !== null ? formatUsd(costValue) : "";
  const cost = costText ? segment(costText, <Text dimColor>{costText}</Text>) : null;

  let ctx: Segment | null = null;
  let ctxCompact: Segment | null = null;
  if (s.contextLimit > 0) {
    const full = `ctx ${gaugeBar(fraction)} ${pct}%`;
    ctx = segment(full, <Text color={gaugeColor(fraction)}>{full}</Text>);
    const bare = `ctx ${pct}%`;
    ctxCompact = segment(bare, <Text color={gaugeColor(fraction)}>{bare}</Text>);
  } else if (s.contextUsed > 0) {
    // Unknown window size: show the absolute estimate without a gauge.
    const bare = `ctx ${formatTokens(s.contextUsed)}`;
    ctx = segment(bare, <Text dimColor>{bare}</Text>);
  }
  const model = s.modelLabel ? segment(s.modelLabel, <Text dimColor>{s.modelLabel}</Text>) : null;

  // Type-ahead badge: messages queued while busy (short, high-value — the user
  // just typed them and wants confirmation they were captured).
  const queuedText = s.busy && s.queuedInputs > 0 ? `queued ${s.queuedInputs}` : "";
  const queued = queuedText
    ? segment(queuedText, <Text color={palette.accentBright}>{queuedText}</Text>)
    : null;

  const fits = (segs: Segment[]): boolean => rowWidth(segs) <= terminalColumns() - 1;
  const join = (segs: Array<Segment | null>): Segment[] =>
    segs.filter((x): x is Segment => x !== null);

  let parts = join([hint, model, mode, tokens, ctx, cost, queued]);
  if (!fits(parts)) {
    parts = join([hint, model, mode, tokens, ctxCompact ?? ctx, null, queued]);
    if (!fits(parts)) {
      parts = join([hint, null, mode, tokens, ctxCompact ?? ctx, null, queued]);
      if (!fits(parts)) {
        // Last resort: hint + mode + queued only.
        parts = join([hint, mode, queued]);
      }
    }
  }

  return (
    <Box>
      {parts.map((seg, i) => (
        <Text key={i}>
          {i > 0 ? <Text dimColor>{SEPARATOR}</Text> : null}
          {seg.node}
        </Text>
      ))}
    </Box>
  );
}
