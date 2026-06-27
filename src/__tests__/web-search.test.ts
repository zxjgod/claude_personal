// ============================================================
// Tests: WebSearch result parsing
// ============================================================

import { describe, expect, it } from "vitest";
import { parseSearchResults } from "../web-search.js";

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
