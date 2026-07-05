// ============================================================
// Toast — transient notification overlay (mode switch feedback, etc.)
// ============================================================
// Renders above the transcript as a centered notification banner. Uses
// useTerminalSize to center horizontally. Auto-hides via store.toast null.
// ============================================================

import { Box, Text } from "ink";
import type { TuiStore } from "./store.js";
import { palette } from "./theme.js";
import { useStoreField } from "./useStoreSelector.js";
import { useTerminalSize } from "./useTerminalSize.js";

function CenteredBanner({ text }: { text: string }) {
  const { columns } = useTerminalSize();
  const padding = Math.max(0, Math.floor((columns - text.length - 4) / 2));
  return (
    <Box justifyContent="center">
      <Box borderStyle="round" borderColor={palette.accent} paddingX={1}>
        <Text color={palette.accent}>{" ".repeat(padding)}</Text>
        <Text color={palette.accent} bold>
          {text}
        </Text>
        <Text color={palette.accent}>{" ".repeat(padding)}</Text>
      </Box>
    </Box>
  );
}

export function Toast({ store }: { store: TuiStore }) {
  const toast = useStoreField(store, "toast");
  if (!toast) return null;
  return <CenteredBanner text={toast} />;
}
