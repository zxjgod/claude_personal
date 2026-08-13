// ============================================================
// WebFetch Tool — Fetch and extract web page content
// ============================================================
// Fetches a URL, strips HTML, and returns plain text content
// for the LLM to analyze based on a user's fetchInfo prompt.
// ============================================================

import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { InputValidator } from "../../utils/input-validator.js";
import { buildTool } from "../registry.js";

// --- Constants ---

const MAX_CONTENT_LENGTH = 100_000; // 100KB output
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB max download
const TIMEOUT_MS = 15_000; // 15 seconds

// --- Schema ---

const WebFetchSchema = z.strictObject({
  url: z.string().url().describe("The URL to fetch (must start with http:// or https://)"),
  fetchInfo: z.string().min(1).describe("What information you want to extract from this page"),
});
type WebFetchInput = z.infer<typeof WebFetchSchema>;

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
    "fetchInfo (required, what you want to extract from the page). " +
    "Returns plain text content with HTML stripped. " +
    "Use this to read documentation, check API responses, or research topics. " +
    "Max content: 100KB. Timeouts after 15s.",
  schema: WebFetchSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: "fetch web page scrape extract URL",
  aliases: ["fetch", "scrape"],

  async call(input, _context): Promise<ToolResult> {
    // P1-1: Use InputValidator for consistent URL validation (SSRF prevention)

    const validation = InputValidator.validateUrl(input.url);
    if (!validation.valid) {
      return {
        content: "",
        error: validation.error ?? "Invalid URL",
      };
    }

    // --- Fetch ---

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(input.url, {
        method: "GET",
        headers: {
          "User-Agent":
            "ClaudeCodeReplica/1.0 (AI coding assistant; +https://github.com/claude-code-replica)",
          Accept: "text/html, text/plain, application/json, */*",
        },
        redirect: "follow",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // `redirect: "follow"` can land on an internal host even when the original
      // URL passed SSRF validation. Re-validate the FINAL url after redirects so a
      // redirect to localhost/private IPs is still blocked.
      if (response.url && response.url !== input.url) {
        const finalCheck = InputValidator.validateUrl(response.url);
        if (!finalCheck.valid) {
          return {
            content: "",
            error: `Blocked redirect target: ${finalCheck.error ?? response.url}`,
          };
        }
      }

      // Check content type
      const contentType = response.headers.get("content-type") || "";

      // Read response (with size limit)
      let rawBody: string;
      try {
        const buf = await readLimited(response, MAX_RESPONSE_SIZE);
        rawBody = new TextDecoder().decode(buf);
      } catch (err: any) {
        if (err.name === "AbortError") {
          return { content: "", error: `Request timed out after ${TIMEOUT_MS / 1000}s` };
        }
        return { content: "", error: `Failed to read response: ${err.message}` };
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

      const header = [
        `URL: ${input.url}`,
        `Status: ${response.status} ${response.statusText}`,
        `Content-Type: ${contentType}`,
        `Content-Length: ${content.length} chars${truncated ? " (truncated)" : ""}`,
        ``,
        `--- Content (extract "${input.fetchInfo}") ---`,
        ``,
      ].join("\n");

      return {
        content: header + content,
        truncated,
        metadata: {
          linesRead: content.split("\n").length,
        },
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        return { content: "", error: `Request timed out after ${TIMEOUT_MS / 1000}s` };
      }
      return { content: "", error: `Fetch failed: ${err.message}` };
    }
  },

  async checkPermissions(_input, _context) {
    return { allowed: true }; // Read-only — auto-approved
  },
});

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
