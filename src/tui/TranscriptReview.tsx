// ============================================================
// TranscriptReview — in-app scrollable pager for the default TUI path
// ============================================================
// The default TUI renders committed content into Ink <Static>, which is
// write-once: scrolling belongs to the TERMINAL's scrollback, and on consoles
// with scroll-on-output snap (classic Windows console) every streamed frame
// yanks the viewport back to the bottom — the user effectively cannot scroll
// while the model streams. This pager moves scrolling into the app: PgUp opens
// it, and the existing windowed ScrollView renders transcript + in-flight
// stream under full keyboard control, immune to terminal snap.
//
// Opens pinned to the BOTTOM (latest content) with sticky OFF: new lines that
// arrive while reviewing extend the content but never drag the viewport.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { bottomScrollTop, clampScrollTop, ScrollView } from "./ScrollView.js";
import type { TuiStore } from "./store.js";
import { transcriptToLines } from "./transcript-lines.js";
import { useStoreSelector } from "./useStoreSelector.js";
import { useTerminalSize } from "./useTerminalSize.js";

/** Rows reserved for the pager's own chrome (title + hint) and the app status bar. */
const CHROME_ROWS = 4;

function selectContent(s: ReturnType<TuiStore["getSnapshot"]>) {
  return {
    transcript: s.transcript,
    streamingText: s.streamingText,
    streamingThinking: s.streamingThinking,
    busy: s.busy,
  };
}

export function TranscriptReview({ store }: { store: TuiStore }) {
  const { transcript, streamingText, streamingThinking, busy } = useStoreSelector(
    store,
    selectContent,
  );
  const { rows } = useTerminalSize();
  const viewportHeight = Math.max(3, rows - CHROME_ROWS);

  const lines = transcriptToLines(transcript, streamingText, streamingThinking);

  // Open at the bottom (most recent content). Sticky stays OFF: streaming
  // appends must not yank the reader — new content only re-clamps the offset.
  const [scrollTop, setScrollTop] = useState(() => bottomScrollTop(lines.length, viewportHeight));
  const scrollTopRef = useRef(scrollTop);
  scrollTopRef.current = scrollTop;

  useEffect(() => {
    setScrollTop((t) => clampScrollTop(lines.length, viewportHeight, t));
  }, [lines.length, viewportHeight]);

  const scrollTo = (desired: number) => {
    setScrollTop(clampScrollTop(lines.length, viewportHeight, desired));
  };

  useInput((input, key) => {
    if (key.escape || input === "q") {
      store.setReviewing(false);
      return;
    }
    const lineStep = 1;
    const halfPage = Math.max(1, Math.floor(viewportHeight * 0.5));
    const fullPage = Math.max(1, Math.floor(viewportHeight * 0.95));
    if (key.upArrow) return scrollTo(scrollTopRef.current - lineStep);
    if (key.downArrow) return scrollTo(scrollTopRef.current + lineStep);
    if (key.pageUp || (key.ctrl && input === "u")) return scrollTo(scrollTopRef.current - halfPage);
    if (key.pageDown || (key.ctrl && input === "d"))
      return scrollTo(scrollTopRef.current + halfPage);
    if (key.ctrl && input === "b") return scrollTo(scrollTopRef.current - fullPage);
    if (key.ctrl && input === "f") return scrollTo(scrollTopRef.current + fullPage);
    if (key.home) return scrollTo(0);
    if (key.end || input === "G") return scrollTo(bottomScrollTop(lines.length, viewportHeight));
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {`  Transcript — ${lines.length} lines${busy ? " · still streaming" : ""}`}
      </Text>
      {/* Fixed-height wrapper: the default App root has no height constraint,
          so without it ScrollView's measured height would follow the CONTENT
          (breaking the windowing math) instead of the viewport. */}
      <Box height={viewportHeight} flexShrink={0}>
        <ScrollView lines={lines} scrollTop={scrollTop} fallbackHeight={viewportHeight} />
      </Box>
      <Text dimColor>{"  ↑/↓ 行 · PgUp/PgDn 翻页 · Home/G 顶/底 · Esc 返回"}</Text>
    </Box>
  );
}
