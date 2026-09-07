// ============================================================
// paste-chip — large-paste folding primitives (batch D5)
// ============================================================
// Pure helpers shared by the runner (registration + submit-time expansion)
// and the tests. A paste above the fold threshold collapses into a
// "[Pasted text #N +L lines]" chip; the full content lives in the runner's
// session store and expands back into the submitted text — the model always
// sees the whole paste, the UI only ever shows the one-line chip.
// ============================================================

/** Official fold threshold: pastes above this many CHARACTERS fold. */
export const PASTE_FOLD_CHARS = 1024;

/** Matches "[Pasted text #3 +120 lines]" (the "+N lines" suffix optional). */
export const PASTE_CHIP_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;

/** Build the chip line for a registered paste. */
export function makePasteChip(n: number, lines: number): string {
  return `[Pasted text #${n} +${lines} lines]`;
}

/**
 * Replace every paste chip in `text` with its stored content. Unknown ids
 * (hand-typed chips, cross-session leftovers) stay literal — never invent
 * content. The store is a plain Map<number, string>.
 */
export function expandPastedChips(text: string, store: Map<number, string>): string {
  return text.replace(PASTE_CHIP_RE, (chip, n: string) => store.get(Number(n)) ?? chip);
}
