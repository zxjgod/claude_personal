// ============================================================
// QueuedMessages — dim queued-input list above the input box (B6)
// ============================================================
// Official PromptInputQueuedCommands: messages typed while the agent works
// render as dim user messages ABOVE the input box (non-fullscreen), so the
// user sees exactly what was captured and can Up-recall it for editing. The
// list caps at MAX_SHOWN rows with a "+N more" overflow marker; bash-queue
// lines keep their "!" marker.
// ============================================================

import { Box, Text } from "ink";
import { t } from "./i18n.js";

/** Rows shown before the "+N more" overflow marker. */
const MAX_SHOWN = 3;

export function QueuedMessages({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  const visible = messages.slice(0, MAX_SHOWN);
  const hidden = messages.length - visible.length;
  return (
    <Box flexDirection="column">
      {visible.map((msg, i) => (
        <Box key={`${i}:${msg}`}>
          {msg.startsWith("!") ? (
            <>
              <Text dimColor>{"  "}</Text>
              <Text color="#ff0087">{"! "}</Text>
              <Text dimColor>{msg.slice(1)}</Text>
            </>
          ) : (
            <Text dimColor>{`> ${msg}`}</Text>
          )}
        </Box>
      ))}
      {hidden > 0 ? <Text dimColor>{`  … +${hidden} ${t("ui.queue.moreQueued")}`}</Text> : null}
    </Box>
  );
}
