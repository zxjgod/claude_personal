// ============================================================
// figures — platform-sensitive UI glyphs (official constants/figures.ts)
// ============================================================
// Mirrors the official Claude Code constants so the transcript chrome uses
// the same shapes on the same platforms. The one platform fork that matters:
// the record circle renders as ⏺ on macOS terminals but falls back to ● on
// Windows/Linux, where font coverage for U+23FA is unreliable.
// ============================================================

/** Tool-use bullet: ⏺ on darwin, ● elsewhere (font coverage). */
export const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

/** Input prompt pointer (PromptInputModeIndicator's figures.pointer). */
export const POINTER = "❯";

/** Tool-result branch prefix (MessageResponse). */
export const TOOL_RESULT = "⎿";

/** Permission-mode symbols shown in the prompt footer. */
export const FAST_FORWARD = "⏵⏵"; // acceptEdits / bypassPermissions
export const PAUSE = "⏸"; // plan mode
