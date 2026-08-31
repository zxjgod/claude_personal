// ============================================================
// Tests: WebSearch result parsing
// ============================================================

import { describe, expect, it } from "vitest";
import { parseBingResults, parseSearchResults } from "../tools/extended/web-search.js";

const SAMPLE = `
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example Docs</a>
  <a class="result__snippet" href="...">The official documentation for Example.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="https://plain.example.org/page">Plain &amp; Simple</a>
  <a class="result__snippet" href="...">A snippet with &quot;quotes&quot; in it.</a>
</div>
`;

describe("parseSearchResults", () => {
  it("extracts title, url, and snippet", () => {
    const results = parseSearchResults(SAMPLE);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Example Docs");
    expect(results[0].snippet).toContain("official documentation");
  });

  it("unwraps DuckDuckGo redirect URLs", () => {
    const results = parseSearchResults(SAMPLE);
    expect(results[0].url).toBe("https://example.com/docs");
  });

  it("keeps plain URLs as-is and decodes entities in titles", () => {
    const results = parseSearchResults(SAMPLE);
    expect(results[1].url).toBe("https://plain.example.org/page");
    expect(results[1].title).toBe("Plain & Simple");
    expect(results[1].snippet).toContain('"quotes"');
  });

  it("respects the limit", () => {
    const results = parseSearchResults(SAMPLE, 1);
    expect(results).toHaveLength(1);
  });

  it("returns empty for HTML with no results", () => {
    expect(parseSearchResults("<div>nothing here</div>")).toHaveLength(0);
  });
});

const BING_SAMPLE = `
<html><body><ol id="b_results">
<li class="b_algo" data-id iid=SERP.123>
  <h2 class=""><a target="_blank" href="https://nodejs.org/en" h="ID=SERP,1.1"><strong>Node</strong>.js Official</a></h2>
  <div class="b_caption"><p class="b_lineclamp2" data-rslinkclamp-iid="">Node.js&#174; is a free, open-source JavaScript runtime.</p></div>
</li>
<li class="b_algo" data-id iid=SERP.124>
  <h2><a href="https://example.com/docs">Example &amp; Docs</a></h2>
  <div class="b_caption"><p>Read the docs &quot;carefully&quot;.</p></div>
</li>
<li class="b_algo"><div class="no-h2-here">no result link</div></li>
</ol></body></html>
`;

describe("parseBingResults", () => {
  it("extracts title, url, and snippet from b_algo blocks", () => {
    const results = parseBingResults(BING_SAMPLE);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Node.js Official");
    expect(results[0].url).toBe("https://nodejs.org/en");
    expect(results[0].snippet).toContain("open-source JavaScript runtime");
  });

  it("decodes entities and strips tags", () => {
    const results = parseBingResults(BING_SAMPLE);
    expect(results[1].title).toBe("Example & Docs");
    expect(results[1].snippet).toContain('"carefully"');
  });

  it("skips blocks without an h2 link and respects the limit", () => {
    expect(parseBingResults(BING_SAMPLE, 1)).toHaveLength(1);
    expect(parseBingResults("<div>nothing here</div>")).toHaveLength(0);
  });
});
