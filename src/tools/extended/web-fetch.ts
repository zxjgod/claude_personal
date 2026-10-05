// ============================================================
// WebFetch Tool — Fetch and extract web page content
// ============================================================
// Fetches a URL, strips HTML, and returns plain text content
// for the LLM to analyze based on a user's fetchInfo prompt.
// ============================================================

import { z } from "zod";
import { createModelCaller } from "../../llm-adapter.js";
import { resolveFastModelConfig } from "../../provider-profiles.js";
import type { Tool, ToolResult } from "../../types.js";
import { InputValidator } from "../../utils/input-validator.js";
import { buildTool } from "../registry.js";
import { publicHttpGet } from "../utils/public-http.js";

// --- Constants ---

const MAX_CONTENT_LENGTH = 100_000; // 100KB output
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB max download
const TIMEOUT_MS = 15_000; // 15 seconds
/** S6: fetchInfo extraction input cap and its own model-call timeout. */
const EXTRACT_INPUT_CHARS = 20_000;
const EXTRACT_TIMEOUT_MS = 15_000;

// --- Schema ---

const WebFetchSchema = z.strictObject({
  url: z.string().url().describe("The URL to fetch (must start with http:// or https://)"),
  fetchInfo: z.string().min(1).describe("What information you want to extract from this page"),
});

// --- Helpers ---

function stripHtml(html: string): string {
  // Remove scripts and styles completely
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // Replace block elements with newlines
  text = text.replace(
    /<\/(div|p|h[1-6]|li|tr|article|section|header|footer|main|nav|aside|table|br|hr)[^>]*>/gi,
    "\n",
  );
  text = text.replace(/<br[^>]*\/?>/gi, "\n");
  text = text.replace(/<hr[^>]*\/?>/gi, "\n---\n");

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

  // Collapse whitespace
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  return text;
}

// --- Tool ---

export const WebFetchTool: Tool = buildTool({
  name: "web_fetch",
  description: "Fetch a web page and extract its content",
  promptDescription:
    "Fetch content from a URL and extract information. " +
    "Parameters: url (required, must be http/https, blocked: localhost, private IPs), " +
    "prompt (required, what you want to extract from the page; `fetchInfo` " +
    "is also accepted). " +
    "Returns plain text content with HTML stripped. " +
    "Use this to read documentation, check API responses, or research topics. " +
    "Max content: 100KB. Timeouts after 15s.",
  schema: WebFetchSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    // P1-1: Use InputValidator for consistent URL validation (SSRF prevention)

    const validation = InputValidator.validateUrl(input.url);
    if (!validation.valid) {
      return {
        content: "",
        error: validation.error ?? "Invalid URL",
      };
    }

    // --- Fetch (manual redirects so every hop is SSRF-checked) ---

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const headers = {
      "User-Agent":
        "ClaudeCodeReplica/1.0 (AI coding assistant; +https://github.com/claude-code-replica)",
      Accept: "text/html, text/plain, application/json, */*",
    };

    try {
      // `redirect: "follow"` only exposes the FINAL url, so a chain that hops
      // through an internal host (public → 169.254.169.254 → public) would pass
      // the final-URL check while still touching the internal host. Follow
      // manually and validate EVERY hop instead, bounding the chain length.
      const fetched = await fetchWithManualRedirects(input.url, headers, controller.signal);
      if (!fetched.ok) {
        clearTimeout(timeoutId);
        return { content: "", error: fetched.error };
      }
      const response = fetched.response;

      // NOTE: the timeout stays ARMED through the body read. Clearing it after
      // the headers arrive (the old behavior) let a slow-drip server — headers
      // instantly, body byte-by-byte — hang the tool forever. The abort signal
      // propagates to the body stream, so readLimited() rejects with
      // AbortError when the timer fires.

      // Check content type
      const contentType = response.headers.get("content-type") || "";

      // Read response (with size limit)
      let rawBody: string;
      try {
        const buf = await readLimited(response, MAX_RESPONSE_SIZE);
        rawBody = new TextDecoder().decode(buf);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return { content: "", error: `Request timed out after ${TIMEOUT_MS / 1000}s` };
        }
        return { content: "", error: `Failed to read response: ${(err as Error).message}` };
      } finally {
        clearTimeout(timeoutId);
      }

      let content: string;

      if (contentType.includes("text/html")) {
        content = stripHtml(rawBody);
      } else if (
        contentType.includes("text/") ||
        contentType.includes("application/json") ||
        contentType.includes("application/xml")
      ) {
        // For non-HTML text content, use as-is (but strip potential HTML)
        content = rawBody;
      } else {
        return {
          content: "",
          error: `Unsupported content type: "${contentType}". Only text formats are supported.`,
        };
      }

      // Truncate
      const truncated = content.length > MAX_CONTENT_LENGTH;
      if (truncated) {
        content = content.slice(0, MAX_CONTENT_LENGTH);
      }

      // S6: actually execute the fetchInfo instruction — a bounded model pass
      // over the page text (fast model when configured, M5). Success replaces
      // the raw dump with a focused extract plus a short raw preview; any
      // failure (or no modelConfig — tests/sub-agents) degrades to the raw
      // content, exactly the old behavior.
      let extracted: string | undefined;
      if (context.modelConfig) {
        const fastConfig = resolveFastModelConfig(context.modelConfig) ?? context.modelConfig;
        const caller = createModelCaller(fastConfig);
        const extractController = new AbortController();
        const extractTimer = setTimeout(() => extractController.abort(), EXTRACT_TIMEOUT_MS);
        try {
          let text = "";
          for await (const event of caller(
            [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text:
                      `From the page content below, extract: ${input.fetchInfo}\n\n` +
                      `Answer concisely using only the page. If the page does not contain ` +
                      `the answer, say so explicitly.\n\n<page>\n${content.slice(0, EXTRACT_INPUT_CHARS)}\n</page>`,
                  },
                ],
              },
            ],
            [],
            "",
            fastConfig,
            extractController.signal,
          )) {
            if (event.type === "text_delta") text += event.delta;
          }
          if (text.trim()) extracted = text.trim();
        } catch {
          /* degrade to raw content */
        } finally {
          clearTimeout(extractTimer);
        }
      }

      const header = [
        `URL: ${input.url}`,
        `Status: ${response.status} ${response.statusText}`,
        `Content-Type: ${contentType}`,
        `Content-Length: ${content.length} chars${truncated ? " (truncated)" : ""}`,
        ``,
        `--- Content (extract "${input.fetchInfo}") ---`,
        ``,
      ].join("\n");

      if (extracted) {
        const preview = content.slice(0, 1500);
        return {
          content:
            `${header}${extracted}\n\n` +
            `--- Raw preview (first ${preview.length} of ${content.length} chars) ---\n${preview}`,
          truncated,
          metadata: {
            linesRead: extracted.split("\n").length,
            summary: "Extracted per fetchInfo",
          },
        };
      }

      return {
        content: header + content,
        truncated,
        metadata: {
          linesRead: content.split("\n").length,
        },
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === "AbortError") {
        return { content: "", error: `Request timed out after ${TIMEOUT_MS / 1000}s` };
      }
      return {
        content: "",
        error:
          `Fetch failed: ${(err as Error).message}\n` +
          `Check direct network access. WebFetch uses validated direct connections for SSRF protection.`,
      };
    }
  },

  async checkPermissions(_input, _context) {
    return { allowed: true }; // Read-only — auto-approved
  },
});

// --- Helper: manual redirect following with per-hop SSRF validation ---

type FetchResult = { ok: true; response: Response } | { ok: false; error: string };

const MAX_REDIRECTS = 5;

/**
 * Follow redirects manually so EVERY hop is SSRF-validated (not just the final
 * URL, which is all `redirect: "follow"` reveals). The chain length is bounded
 * so a redirect loop cannot run forever under the single fetch timeout.
 */
async function fetchWithManualRedirects(
  startUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<FetchResult> {
  let currentUrl = startUrl;
  let hops = 0;
  for (;;) {
    // Validate THIS hop's target before requesting it. The original URL already
    // passed validation at the call site; intermediate hops are checked here.
    const check = InputValidator.validateUrl(currentUrl);
    if (!check.valid) {
      return { ok: false, error: `Blocked redirect target: ${check.error ?? currentUrl}` };
    }

    const response = await publicHttpGet(currentUrl, headers, signal, MAX_RESPONSE_SIZE);

    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get("location");
      if (!location) return { ok: true, response }; // 3xx without Location → final
      if (++hops > MAX_REDIRECTS) {
        return { ok: false, error: `Too many redirects (over ${MAX_REDIRECTS})` };
      }
      currentUrl = new URL(location, currentUrl).toString();
      await response.body?.cancel(); // release the connection before the next hop
      continue;
    }

    return { ok: true, response };
  }
}

// --- Helper: Read response body with size limit ---

async function readLimited(response: Response, maxSize: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is not readable");
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalSize += value.length;
    if (totalSize > maxSize) {
      reader.cancel();
      throw new Error(`Response exceeds maximum size of ${maxSize} bytes`);
    }
    chunks.push(value);
  }

  // Combine chunks
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
