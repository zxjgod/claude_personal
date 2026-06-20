// ============================================================
// WebFetch Tool — Fetch and extract web page content
// ============================================================
// Fetches a URL, strips HTML, and returns plain text content
// for the LLM to analyze based on a user's fetchInfo prompt.
// ============================================================

import type { Tool, ToolContext, ToolResult } from "./types.js";
import { createTool } from "./tool-registry.js";

// --- Constants ---

const MAX_CONTENT_LENGTH = 100_000; // 100KB output
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB max download
const TIMEOUT_MS = 15_000; // 15 seconds
const MAX_REDIRECTS = 5;

// Private/internal network patterns to block (SSRF prevention)
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

// --- Input ---

interface WebFetchInput {
  url: string;
  fetchInfo: string;
  [key: string]: unknown;
}

// --- Helpers ---

function isBlockedHost(hostname: string): boolean {
  // Strip brackets from IPv6 addresses
  const host = hostname.replace(/^\[|\]$/g, "");
  return BLOCKED_HOSTS.some((pattern) => pattern.test(host));
}

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

export const WebFetchTool: Tool = createTool<WebFetchInput>({
  name: "web_fetch",
  description: "Fetch a web page and extract its content",
  promptDescription:
    "Fetch content from a URL and analyze it. " +
    "Provide url (must be http/https) and fetchInfo (what you want to extract from the page). " +
    "The tool returns plain text content (HTML tags stripped). " +
    "Use this to read documentation, check API responses, or research topics.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (must start with http:// or https://)",
      },
      fetchInfo: {
        type: "string",
        description: "What information you want to extract from this page",
      },
    },
    required: ["url", "fetchInfo"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, _context): Promise<ToolResult> {
    const url = input.url?.trim();
    const fetchInfo = input.fetchInfo?.trim();

    if (!url) {
      return { content: "", error: "url is required" };
    }
    if (!fetchInfo) {
      return { content: "", error: "fetchInfo is required" };
    }

    // --- Validate URL ---

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        content: "",
        error: `Invalid URL: "${url}". Must be a valid http/https URL.`,
      };
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return {
        content: "",
        error: `Unsupported protocol: "${parsed.protocol}". Only http and https are allowed.`,
      };
    }

    // --- SSRF check ---

    if (isBlockedHost(parsed.hostname)) {
      return {
        content: "",
        error: `Access denied: "${parsed.hostname}" is an internal/private address.`,
      };
    }

    // --- Fetch ---

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
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
        `URL: ${url}`,
        `Status: ${response.status} ${response.statusText}`,
        `Content-Type: ${contentType}`,
        `Content-Length: ${content.length} chars${truncated ? " (truncated)" : ""}`,
        ``,
        `--- Content (extract "${fetchInfo}") ---`,
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

async function readLimited(
  response: Response,
  maxSize: number,
): Promise<Uint8Array> {
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
