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
//
// CJK text is counted SEPARATELY at ~1 token/char: Chinese/Japanese/Korean
// characters tokenize at roughly one token each on mainstream tokenizers
// (cl100k, DeepSeek, Qwen), so applying the natural-language ratio to them
// underestimates by ~3x. Underestimation is the dangerous direction here — it
// delays auto-compaction until the provider hard-rejects with context_length.
// Overestimating CJK slightly (newer tokenizers reach ~1.2 chars/token) only
// compacts a bit earlier; safe.
// ============================================================

import type { ContentBlock, Message } from "./types.js";

/**
 * CJK + fullwidth code points: CJK radicals/symbols/kana/ideographs
 * (U+2E80–U+9FFF), compatibility ideographs (U+F900–U+FAFF), fullwidth forms
 * (U+FF00–U+FFEF), Hangul syllables (U+AC00–U+D7AF).
 */
const CJK_PATTERN = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g;

/**
 * Split-based estimate: CJK chars at ~1 token each, everything else at the
 * caller-supplied ratio (by content type). Without the split, a Chinese-heavy
 * conversation or CLAUDE.md is underestimated ~3x and blows the context window
 * before auto-compaction ever triggers.
 */
function estimateMixedTextTokens(text: string, nonCjkCharsPerToken: number): number {
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  const nonCjk = text.length - cjkCount;
  return Math.ceil(cjkCount + nonCjk / nonCjkCharsPerToken);
}

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
  if (block.type === "image") {
    // Images are expensive: 85 tokens base + pixels/750
    const data = block.source.data ?? "";
    return 85 + Math.ceil((data.length * 4) / 750);
  }

  // block.type === "text"
  const text = block.text ?? "";

  if (!text) return 0;

  // Determine content type and apply appropriate ratio
  if (isStructuredData(text)) {
    return estimateMixedTextTokens(text, 2.5); // Structured data: ~2.5 chars/token
  }

  if (isLikelyCode(text, sourceFile)) {
    return estimateMixedTextTokens(text, 3.0); // Code: ~3.0 chars/token
  }

  // Natural language: ~3.5 chars/token
  return estimateMixedTextTokens(text, 3.5);
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
          total += estimateMixedTextTokens(msg.content, 3.5);
        } else {
          for (const block of msg.content as ContentBlock[]) {
            total += estimateBlockTokens(block);
          }
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          // Tool call overhead: name + arguments (arguments can carry CJK,
          // e.g. Write tool file content in a Chinese document)
          total += Math.ceil(tc.function.name.length / 3.0);
          total += estimateMixedTextTokens(tc.function.arguments, 2.5);
        }
      }
      return total;
    }

    case "tool": {
      // Tool results often contain mixed content (text + code)
      const text = msg.content || "";
      if (isLikelyCode(text)) {
        return estimateMixedTextTokens(text, 3.0);
      }
      return estimateMixedTextTokens(text, 3.5);
    }

    case "system":
      return estimateMixedTextTokens(msg.content, 3.5);

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
