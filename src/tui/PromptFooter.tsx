// ============================================================
// PromptFooter — the official hint row under the input box
// ============================================================
// Mirrors the official PromptInputFooter: one row, two columns.
//
//   ⏸ plan mode on (shift+tab to cycle)        claude-opus-4-5 · 14% until auto-compact
//
// Left column is a priority chain (only the highest-priority item shows):
//   busy → "esc to interrupt"
//   non-default permission mode → "⏸ plan mode on (shift+tab to cycle)"
//   fallback → "? for shortcuts"
// Right column carries the session facts worth a constant glance: the model
// label, the context-REMAINING percent, and — while the turn is running —
// the type-ahead queue depth ("queued N") so captured messages stay visible
// until batch B lands the full dim-message queue UI. (The official client
// delegates model/ctx to a user /statusline command; per project decision
// 2026-09-06 we render a built-in minimal version instead — tokens/cost stay
// on /cost and /tokens.)
//
// Narrow terminals drop the right column (then the percent) before wrapping.
// ============================================================

import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { t } from "./i18n.js";
import { CTX_CRITICAL_PCT, CTX_WARN_PCT, type StoreState, type TuiStore } from "./store.js";
import { terminalColumns, visualWidth } from "./terminal-width.js";
import { modeColor, modeFooterText, palette } from "./theme.js";
import { useStoreSelector } from "./useStoreSelector.js";

function selectFooter(s: StoreState) {
  return {
    busy: s.busy,
    permissionMode: s.permissionMode,
    modelLabel: s.modelLabel,
    contextUsed: s.contextUsed,
    contextLimit: s.contextLimit,
    queuedInputs: s.queuedInputs,
    showExitHint: s.showExitHint,
    effortOverlay: s.overlay?.kind === "effort",
  };
}

/** Context-percent color by used fraction (same thresholds as the old gauge). */
export function ctxColor(usedFraction: number): string {
  if (usedFraction >= CTX_CRITICAL_PCT) return palette.error;
  if (usedFraction >= CTX_WARN_PCT) return palette.warning;
  return palette.success;
}

/** "14% until auto-compact" — the official context-REMAINING phrasing. Takes
 *  the USED fraction and reports what's LEFT, matching the official
 *  statusline's remaining_percentage semantics (zh 距自动压缩还有 likewise
 *  counts what remains). Color still keys off the used fraction. */
export function ctxRemainingText(usedFraction: number): string {
  const remaining = Math.max(0, 100 - Math.floor(Math.max(0, usedFraction) * 100));
  return t("ui.footer.untilAutoCompact", { pct: remaining });
}

export function PromptFooter({ store }: { store: TuiStore }) {
  const s = useStoreSelector(store, selectFooter);
  const columns = terminalColumns();
  if (s.effortOverlay) return null;

  // --- Left column: first match in the priority chain wins ---
  let leftNode: ReactNode;
  let leftWidth: number;
  if (s.showExitHint) {
    // B5: armed by the first idle Ctrl+C/Ctrl+D — the official exit message
    // outranks every other hint while it's live.
    const hint = t("ui.footer.exitHint");
    leftNode = <Text dimColor>{hint}</Text>;
    leftWidth = visualWidth(hint);
  } else {
    const modeText = modeFooterText(s.permissionMode);
    const busyHint = s.busy ? t("ui.footer.interrupt") : null;
    if (modeText && busyHint) {
      // Busy + non-default mode: BOTH show. The official ModeIndicator keeps
      // the mode part while loading (its hint is a part OF the indicator), so
      // a mid-turn Shift+Tab is visibly acknowledged — permission checks read
      // the mode live, and the user must see what they switched to.
      const sep = " · ";
      leftNode = (
        <Text>
          <Text color={modeColor(s.permissionMode)}>{modeText}</Text>
          <Text dimColor>{sep + busyHint}</Text>
        </Text>
      );
      leftWidth = visualWidth(modeText + sep + busyHint);
    } else if (busyHint) {
      leftNode = <Text dimColor>{busyHint}</Text>;
      leftWidth = visualWidth(busyHint);
    } else if (modeText) {
      const cycle = ` ${t("ui.footer.modeCycle")}`;
      leftNode = (
        <Text>
          <Text color={modeColor(s.permissionMode)}>{modeText}</Text>
          <Text dimColor>{cycle}</Text>
        </Text>
      );
      leftWidth = visualWidth(modeText + cycle);
    } else {
      const hint = t("ui.footer.shortcuts");
      leftNode = <Text dimColor>{hint}</Text>;
      leftWidth = visualWidth(hint);
    }
  }

  // --- Right column: queued N · model · context% (droppable, in that order
  //     of least-to-most important when width runs out) ---
  const fraction = s.contextLimit > 0 ? Math.min(1, s.contextUsed / s.contextLimit) : 0;
  // Hide the percent until the first usage lands: a fresh session would
  // otherwise read "100% until auto-compact", which looks like a full window.
  const ctxText = s.contextLimit > 0 && s.contextUsed > 0 ? ctxRemainingText(fraction) : "";
  const modelText = s.modelLabel || "";
  const queuedText = s.busy && s.queuedInputs > 0 ? `queued ${s.queuedInputs}` : "";
  // paddingX 2 each side of the footer; keep one column of slack (same
  // DECAWM rationale as the input box).
  const usable = columns - 1 - 4;

  /** One <Text> with CONDITIONAL children only — never an array of nodes,
   *  which React would flag as list children missing keys. */
  const renderRight = (
    withModel: boolean,
    withCtx: boolean,
  ): { node: ReactNode; width: number } => {
    const showModel = withModel && modelText.length > 0;
    const showCtx = withCtx && ctxText.length > 0;
    const showQueued = queuedText.length > 0;
    if (!showModel && !showCtx && !showQueued) return { node: null, width: 0 };
    let width =
      (showModel ? visualWidth(modelText) : 0) +
      (showCtx ? visualWidth(ctxText) : 0) +
      (showQueued ? visualWidth(queuedText) : 0);
    width += ([showModel, showCtx, showQueued].filter(Boolean).length - 1) * 3;
    const node = (
      <Text>
        {showModel ? <Text dimColor>{modelText}</Text> : null}
        {showModel && (showCtx || showQueued) ? <Text dimColor>{" · "}</Text> : null}
        {showCtx ? <Text color={ctxColor(fraction)}>{ctxText}</Text> : null}
        {showCtx && showQueued ? <Text dimColor>{" · "}</Text> : null}
        {showQueued ? <Text color={palette.accentBright}>{queuedText}</Text> : null}
      </Text>
    );
    return { node, width };
  };

  const fits = (w: number) => leftWidth + w + 3 <= usable;
  let right = renderRight(true, true);
  if (right.node && !fits(right.width)) right = renderRight(false, true);
  if (right.node && !fits(right.width)) right = renderRight(false, false);
  // Note: renderRight(false,false) still carries the queued badge alone —
  // a width-fitting fallback that never fully empties while messages wait.

  return (
    <Box paddingX={2} justifyContent={right.node ? "space-between" : undefined}>
      {leftNode}
      {right.node}
    </Box>
  );
}
