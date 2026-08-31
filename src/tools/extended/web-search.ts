// ============================================================
// WebSearch Tool — search the web and return result snippets
// ============================================================
// Provider-agnostic and key-free. Default mode ("auto") queries
// DuckDuckGo's no-key HTML endpoint first and falls back to Bing when
// DDG is unreachable (it is blocked in some regions) or returns an
// empty/anomaly page. Select an engine explicitly with
// WEB_SEARCH_ENGINE=duckduckgo|bing|auto.
// ============================================================

import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Configurable search endpoint so users behind a firewall can point at a
// DuckDuckGo-compatible mirror/proxy (the HTML format parser is DDG-specific).
const DDG_ENDPOINT = process.env.WEB_SEARCH_ENDPOINT || "https://html.duckduckgo.com/html/";
const BING_ENDPOINT = process.env.WEB_SEARCH_BING_ENDPOINT || "https://www.bing.com/search";
// "auto" (DDG → Bing fallback) | "duckduckgo" | "bing"
const ENGINE_PREF = (process.env.WEB_SEARCH_ENGINE || "auto").toLowerCase();
// Bing only serves the parseable result markup to browser-like clients.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Process-level latch: once DuckDuckGo fails at the network level, skip it
// for the rest of the session instead of paying a 15s timeout per query.
let ddgUnavailable = false;

const WebSearchSchema = z.strictObject({
  query: z.string().min(1).describe("The search query"),
});
type WebSearchInput = z.infer<typeof WebSearchSchema>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

type SearchOutcome = { ok: true; results: SearchResult[] } | { ok: false; error: string };

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;|&ensp;|&emsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
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

/** Parse Bing HTML results (<li class="b_algo"> blocks). Exported for testing. */
export function parseBingResults(html: string, limit = MAX_RESULTS): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<li class="b_algo"/);
  // blocks[0] is the page head before the first result — skip it.
  for (let i = 1; i < blocks.length && results.length < limit; i++) {
    const block = blocks[i];
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = link[1];
    const title = decodeEntities(link[2]);
    if (!title || !url) continue;
    const cap = /<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    results.push({ title, url, snippet: cap ? decodeEntities(cap[1]) : "" });
  }
  return results;
}

async function readLimitedBody(response: Response): Promise<{ html?: string; error?: string }> {
  const reader = response.body?.getReader();
  if (!reader) return { error: "Search response body is not readable" };
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return { error: `Search response exceeds ${MAX_BODY_BYTES} bytes` };
    }
    chunks.push(Buffer.from(value));
  }
  return { html: Buffer.concat(chunks).toString("utf8") };
}

async function searchDuckDuckGo(query: string): Promise<SearchOutcome> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(DDG_ENDPOINT, {
      method: "POST",
      headers: {
        "User-Agent":
          "ClaudeCodeReplica/1.0 (AI coding assistant; +https://github.com/claude-code-replica)",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText}` };
    }
    const body = await readLimitedBody(response);
    if (body.error) return { ok: false, error: body.error };
    return { ok: true, results: parseSearchResults(body.html!) };
  } catch (err: any) {
    if (err.name === "AbortError")
      return { ok: false, error: `timed out after ${TIMEOUT_MS / 1000}s` };
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function searchBing(query: string): Promise<SearchOutcome> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${BING_ENDPOINT}?${new URLSearchParams({ q: query })}`;
    const response = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText}` };
    }
    const body = await readLimitedBody(response);
    if (body.error) return { ok: false, error: body.error };
    return { ok: true, results: parseBingResults(body.html!) };
  } catch (err: any) {
    if (err.name === "AbortError")
      return { ok: false, error: `timed out after ${TIMEOUT_MS / 1000}s` };
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatResults(query: string, results: SearchResult[]): ToolResult {
  if (results.length === 0) {
    return { content: `No results found for "${query}".` };
  }
  const body = results
    .map((r, idx) => `${idx + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
    .join("\n\n");
  return {
    content: `Search results for "${query}":\n\n${body}`,
    metadata: { linesRead: results.length },
  };
}

export const WebSearchTool: Tool = buildTool({
  name: "web_search",
  description: "Search the web and return result snippets",
  promptDescription:
    "Search the web for current information. " +
    "Parameters: query (required, the search terms). " +
    "Returns up to 10 ranked results with titles, URLs, and snippets. " +
    "Use this to find documentation, recent events, or facts beyond your training data, " +
    "then optionally follow up with web_fetch to read a specific result in full. " +
    "No API key required — queries DuckDuckGo with automatic fallback to Bing " +
    "(set WEB_SEARCH_ENGINE=duckduckgo|bing|auto to control this).",
  schema: WebSearchSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: "search web internet find information",
  aliases: ["search"],

  async call(input): Promise<ToolResult> {
    const errors: string[] = [];

    // DuckDuckGo first, unless disabled or already known to be unreachable.
    if (ENGINE_PREF !== "bing" && !ddgUnavailable) {
      const ddg = await searchDuckDuckGo(input.query);
      if (!ddg.ok) {
        ddgUnavailable = true; // blocked/down — don't keep timing out per query
        errors.push(`DuckDuckGo: ${ddg.error}`);
      } else if (ddg.results.length > 0 || ENGINE_PREF === "duckduckgo") {
        return formatResults(input.query, ddg.results);
      }
      // auto mode + empty DDG page (anomaly challenge etc.) → try Bing below
    }

    if (ENGINE_PREF !== "duckduckgo") {
      const bing = await searchBing(input.query);
      if (!bing.ok) {
        errors.push(`Bing: ${bing.error}`);
      } else {
        return formatResults(input.query, bing.results);
      }
    }

    return {
      content: "",
      error:
        `Search failed — ${errors.join("; ")}\n` +
        `Network unreachable. Check your connection, or set HTTPS_PROXY/HTTP_PROXY ` +
        `(with NODE_USE_ENV_PROXY=1), or override WEB_SEARCH_ENDPOINT / WEB_SEARCH_ENGINE.`,
    };
  },

  async checkPermissions() {
    return { allowed: true }; // Read-only — auto-approved
  },
});
