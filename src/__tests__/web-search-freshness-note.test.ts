// ============================================================
// Tests: WebSearch freshness note on the Bing fallback
// ============================================================
// The freshness enum only maps to DDG's `df` POST parameter; the Bing
// fallback used to silently ignore it, letting the model believe the results
// were recency-filtered. When Bing serves the results and freshness was
// requested, the output must carry an explicit note.
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";

const BING_HTML = `<html><body><ol id="b_results">
<li class="b_algo" data-id iid=SERP.1>
  <h2><a href="https://example.com/page">Example Page</a></h2>
</li>
</ol></body></html>`;

async function callWebSearch(input: Record<string, unknown>) {
  const { WebSearchTool } = await import("../tools/extended/web-search.js");
  return WebSearchTool.call(input as never, {} as never);
}

describe("WebSearch freshness note on Bing fallback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("warns in the output when freshness was requested but Bing served the results", async () => {
    vi.stubEnv("WEB_SEARCH_ENGINE", "bing");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(BING_HTML, { status: 200 })),
    );
    const out = await callWebSearch({ query: "q", freshness: "week" });
    expect(out.content).toContain("NOT recency-filtered");
    expect(out.content).toContain("freshness");
    expect(out.content).toContain("https://example.com/page");
  });

  it("adds no note when freshness was not requested", async () => {
    vi.stubEnv("WEB_SEARCH_ENGINE", "bing");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(BING_HTML, { status: 200 })),
    );
    const out = await callWebSearch({ query: "q" });
    expect(out.content).not.toContain("recency-filtered");
    expect(out.content).toContain("https://example.com/page");
  });
});
