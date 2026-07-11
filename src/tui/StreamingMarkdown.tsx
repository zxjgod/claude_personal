// ============================================================
// StreamingMarkdown — live markdown during streaming, jank-free
// ============================================================
// Renders markdown *as it streams* without re-lexing the whole message every
// frame. The trick (ported from the reference's StreamingMarkdown): split the
// text at the last top-level block boundary.
//   • Everything before the boundary is STABLE — completed blocks that won't
//     change as more text arrives. Rendered through a memoized child so it's
//     parsed once and never re-lexed as the tail grows.
//   • Only the final, in-progress block is re-parsed per frame. It's bounded
//     (one paragraph / list / code fence), so the cost is O(tail), not O(msg).
//
// marked.lexer treats an unclosed ``` code fence as a single token, so the
// boundary never splits inside an open fence — block boundaries are always
// safe. The boundary only ever advances (monotonic), so the ref write during
// render is idempotent; the component unmounts at commit (streamingText → ""),
// resetting it for the next turn.
//
// This is what lets us render markdown live (headers, bold, lists, code) while
// the model streams, instead of waiting until commit — without the per-frame
// whole-block re-lex that earlier milestones avoided by deferring markdown.
// ============================================================

import { Text } from "ink";
import { marked } from "marked";
import { memo, useRef } from "react";
import { renderMarkdown } from "./markdown.js";

// Debug logging is handled by run.tsx via the debugLogger module.
// This component only handles markdown rendering.

/**
 * Renders one settled chunk of markdown. Memoized on `content`: while the
 * unstable tail grows the stable prefix string is unchanged, so React reuses
 * this output and `renderMarkdown` (the lexer) doesn't run again for it.
 */
const MarkdownChunk = memo(function MarkdownChunk({ content }: { content: string }) {
  return <Text>{renderMarkdown(content)}</Text>;
});

export function StreamingMarkdown({ children }: { children: string }) {
  // Monotonic boundary into `children` up to which blocks have settled. Read
  // and written during render by design (idempotent because it only advances).
  const stablePrefixRef = useRef("");
  const renderCountRef = useRef(0);

  // Defensive: if the text was replaced rather than appended (e.g. a reset
  // without unmount), the old prefix is no longer a prefix — start over.
  if (!children.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = "";
    renderCountRef.current = 0;
  }

  // Guard: if children is empty, render nothing and reset
  if (!children) {
    stablePrefixRef.current = "";
    return null;
  }

  // Lex only the unsettled tail — O(tail length), not O(full message).
  const boundary = stablePrefixRef.current.length;
  const tailText = children.substring(boundary);

  // Guard: if tail is empty, render only the stable prefix
  if (!tailText) {
    return stablePrefixRef.current ? <MarkdownChunk content={stablePrefixRef.current} /> : null;
  }

  const tokens = marked.lexer(tailText);
  const tokenCount = tokens.length;

  // The last non-space token is the block still growing; everything before it
  // is final. Advance the boundary past those final tokens' raw text.
  let lastContentIdx = tokens.length - 1;
  while (
    lastContentIdx >= 0 &&
    (tokens[lastContentIdx]!.type === "space" || tokens[lastContentIdx]!.type === "hr")
  ) {
    lastContentIdx--;
  }

  // Guard: if there's only one content token, it's still growing — don't settle.
  // We need at least 2 content tokens to settle the first one.
  if (lastContentIdx <= 0) {
    return (
      <>
        {stablePrefixRef.current ? <MarkdownChunk content={stablePrefixRef.current} /> : null}
        <MarkdownChunk content={tailText} />
      </>
    );
  }

  // Calculate how much of the tail has settled
  let advance = 0;
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]!.raw.length;
  }

  // Advance the stable boundary (monotonic, so this is always safe)
  if (advance > 0) {
    stablePrefixRef.current = children.substring(0, boundary + advance);
  }

  const stableRender = stablePrefixRef.current;
  const unstableSuffix = children.substring(stableRender.length);

  return (
    <>
      {stableRender ? <MarkdownChunk content={stableRender} /> : null}
      {unstableSuffix ? <MarkdownChunk content={unstableSuffix} /> : null}
    </>
  );
}
