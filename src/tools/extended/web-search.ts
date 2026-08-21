// ============================================================
// WebSearch Tool — search the web and return result snippets
// ============================================================
// Provider-agnostic: by default it queries DuckDuckGo's no-key HTML
// endpoint and parses the result list into title/url/snippet rows for
// the LLM to synthesize. No API key required.
// ============================================================

import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Configurable search endpoint so users behind a firewall can point at a
// DuckDuckGo-compatible mirror/proxy (the HTML format parser is DDG-specific).
const SEARCH_ENDPOINT = process.env.WEB_SEARCH_ENDPOINT || "https://html.duckduckgo.com/html/";

const WebSearchSchema = z.strictObject({
  query: z.string().min(1).describe("The search query"),
});
type WebSearchInput = z.infer<typeof WebSearchSchema>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .trim();
}

// DuckDuckGo wraps real URLs in a redirect like
// //duckduckgo.com/l/?uddg=<encoded>. Unwrap it when present.
function unwrapUrl(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}

/** Parse DuckDuckGo HTML results. Exported for testing. */
export function parseSearchResults(html: string, limit = MAX_RESULTS): SearchResult[] {
  const results: SearchResult[] = [];
  // Each result link: <a ... class="result__a" href="...">Title</a>
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Snippets: <a ... class="result__snippet" ...>snippet</a>
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(decodeEntities(sm[1]));
  }

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) !== null && results.length < limit) {
    const url = unwrapUrl(lm[1]);
    const title = decodeEntities(lm[2]);
    if (!title || !url) {
      i++;
      continue;
    }
    results.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return results;
}

export const WebSearchTool: Tool = buildTool({
  name: "web_search",
  description: "Search the web and return result snippets",
  promptDescription:
    "Search the web for current information using DuckDuckGo. " +
    "Parameters: query (required, the search terms). " +
    "Returns up to 10 ranked results with titles, URLs, and snippets. " +
    "Use this to find documentation, recent events, or facts beyond your training data, " +
    "then optionally follow up with web_fetch to read a specific result in full. " +
    "No API key required — uses DuckDuckGo HTML endpoint.",
  schema: WebSearchSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: "search web internet find information",
  aliases: ["search"],

  async call(input): Promise<ToolResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          "User-Agent":
            "ClaudeCodeReplica/1.0 (AI coding assistant; +https://github.com/claude-code-replica)",
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html",
        },
        body: new URLSearchParams({ q: input.query }).toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        clearTimeout(timeoutId);
        return {
          content: "",
          error: `Search failed: ${response.status} ${response.statusText}`,
        };
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Search response body is not readable");
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          await reader.cancel();
          return { content: "", error: `Search response exceeds ${MAX_BODY_BYTES} bytes` };
        }
        chunks.push(Buffer.from(value));
      }
      const html = Buffer.concat(chunks).toString("utf8");
      clearTimeout(timeoutId);
      const results = parseSearchResults(html);

      if (results.length === 0) {
        return { content: `No results found for "${input.query}".` };
      }

      const body = results
        .map(
          (r, idx) => `${idx + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
        )
        .join("\n\n");

      return {
        content: `Search results for "${input.query}":\n\n${body}`,
        metadata: { linesRead: results.length },
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        return { content: "", error: `Search timed out after ${TIMEOUT_MS / 1000}s` };
      }
      return {
        content: "",
        error:
          `Search failed: ${err.message}\n` +
          `Network unreachable. Check your connection, or set HTTPS_PROXY/HTTP_PROXY ` +
          `(with NODE_USE_ENV_PROXY=1), or override WEB_SEARCH_ENDPOINT.`,
      };
    }
  },

  async checkPermissions() {
    return { allowed: true }; // Read-only — auto-approved
  },
});
