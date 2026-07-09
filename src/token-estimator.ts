// ============================================================
// Token Estimation — Improved accuracy for code-heavy content
// ============================================================
// The naive "chars / 4" heuristic underestimates tokens for code because:
//   - Code has higher token density (keywords, symbols, nested brackets)
//   - Long identifiers count as multiple tokens
//   - JSON/structured data is token-heavy
//
// This module provides tiered estimation:
//   - Natural language: ~3.5 chars/token
//   - Code: ~3.0 chars/token (closer to GPT tokenizers)
//   - Structured data (JSON, config): ~2.5 chars/token
// ============================================================

import type { ContentBlock, Message } from "./types.js";

// Code-like file extensions
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".lua",
  ".pl",
  ".sh",
  ".sql",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".json",
  ".xml",
  ".md",
]);

// Structured data patterns (JSON-like)
const STRUCTURED_PATTERNS = [/^\s*[{[]/, /^\s*"\w+":/, /^\s*\d+:.*\n/];

/** Detect if content is likely code based on heuristics. */
function isLikelyCode(content: string, sourceFile?: string): boolean {
  // Check file extension first
  if (sourceFile) {
    const ext = sourceFile.slice(sourceFile.lastIndexOf("."));
    if (CODE_EXTENSIONS.has(ext.toLowerCase())) return true;
  }

  // Check content patterns
  const lines = content.split("\n");
  if (lines.length < 3) return false;

  // Code indicators
  const codeIndicators = [
    /^(export|import|const|let|var|function|class|interface|type|enum)\s/m,
    /^(def|class|import|from|async|await)\s/m,
    /^(public|private|protected|static|void|int|string|bool)\s/m,
    /\{[\s\S]*\}/, // Braces
    /^\s*(if|for|while|switch|try|catch)\s*\(/m, // Control flow
    /=>/, // Arrow functions
    /^\s{2,}\S/m, // Indented code
  ];

  let score = 0;
  for (const pattern of codeIndicators) {
    if (pattern.test(content)) score++;
  }

  return score >= 2;
}

/** Detect if content is structured data. */
function isStructuredData(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  return STRUCTURED_PATTERNS.some((p) => p.test(content));
}

/**
 * Estimate tokens in a single content block.
 * Uses different ratios based on content type detection.
 */
function estimateBlockTokens(block: ContentBlock, sourceFile?: string): number {
  let text: string;

  switch (block.type) {
    case "text":
      text = block.text;
      break;
    case "tool_result":
      text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      break;
    case "tool_use":
      text = block.input ? JSON.stringify(block.input) : "";
      break;
    case "image":
      // Images are expensive: 85 tokens base + pixels/750
      return 85 + Math.ceil((block.source.data.length * 4) / 750);
    default:
      return 0;
  }

  if (!text) return 0;

  // Determine content type and apply appropriate ratio
  if (isStructuredData(text)) {
    return Math.ceil(text.length / 2.5); // Structured data: ~2.5 chars/token
  }

  if (isLikelyCode(text, sourceFile)) {
    return Math.ceil(text.length / 3.0); // Code: ~3.0 chars/token
  }

  // Natural language: ~3.5 chars/token
  return Math.ceil(text.length / 3.5);
}

/**
 * Estimate tokens in a full message.
 */
function estimateMessageTokens(msg: Message): number {
  switch (msg.role) {
    case "user":
      return msg.content.reduce((sum, block) => sum + estimateBlockTokens(block), 0);

    case "assistant": {
      let total = 0;
      if (msg.content) {
        if (typeof msg.content === "string") {
          total += Math.ceil(msg.content.length / 3.5);
        } else {
          for (const block of msg.content) {
            total += estimateBlockTokens(block);
          }
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          // Tool call overhead: name + arguments
          total += Math.ceil(tc.function.name.length / 3.0);
          total += Math.ceil(tc.function.arguments.length / 2.5);
        }
      }
      return total;
    }

    case "tool": {
      // Tool results often contain mixed content (text + code)
      const text = msg.content || "";
      if (isLikelyCode(text)) {
        return Math.ceil(text.length / 3.0);
      }
      return Math.ceil(text.length / 3.5);
    }

    case "system":
      return Math.ceil(msg.content.length / 3.5);

    default:
      return 0;
  }
}

/**
 * Estimate total tokens for a message array.
 * This is the main export for use in agent-loop.ts and context-pipeline.ts.
 */
export function estimateTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * Lightweight estimation for quick checks (e.g., UI display).
 * Uses the original simple heuristic.
 */
export function estimateTokensQuick(text: string): number {
  return Math.ceil(text.length / 4);
}
