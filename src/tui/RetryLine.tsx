// ============================================================
// RetryLine — shared live retry-countdown row (P0-4)
// ============================================================
// One styled line ("⚠ API 429 rate limit — retrying in 8s (attempt 2/10)")
// rendered by BOTH layouts (App.tsx live region and FullScreenApp), so the
// two paths can't drift apart — same pattern as the shared TodoList.
// ============================================================

import { Text } from "ink";
import { t } from "./i18n.js";
import type { RetryStatus } from "./store.js";
import { palette } from "./theme.js";

export function RetryLine({ retry }: { retry: RetryStatus }) {
  return (
    <Text color={palette.error} bold>
      {`⚠ ${t("ui.retry.status", {
        reason: retry.reason,
        s: retry.secondsLeft,
        a: retry.attempt,
        m: retry.max,
      })}`}
    </Text>
  );
}
