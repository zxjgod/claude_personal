// ============================================================
// Toast — transient notification overlay (mode switch feedback, etc.)
// ============================================================
// Renders above the transcript as a centered notification banner (Ink's
// justifyContent owns centering — CJK-safe). Auto-hides via store.toast null.
// ============================================================

import { Box, Text } from "ink";
import type { TuiStore } from "./store.js";
import { palette } from "./theme.js";
import { useStoreField } from "./useStoreSelector.js";

function CenteredBanner({ text }: { text: string }) {
  // Centering is owned by justifyContent ALONE. The previous manual padding
  // used text.length — half the visual width for CJK — so Chinese toasts
  // overflowed the terminal and wrapped; it also double-centered (padding +
  // justifyContent), making the banner effectively full-width for English.
  return (
    <Box justifyContent="center">
      <Box borderStyle="round" borderColor={palette.promptAccent} paddingX={1}>
        <Text color={palette.promptAccent} bold>
          {text}
        </Text>
      </Box>
    </Box>
  );
}

export function Toast({ store }: { store: TuiStore }) {
  const toast = useStoreField(store, "toast");
  if (!toast) return null;
  return <CenteredBanner text={toast} />;
}
