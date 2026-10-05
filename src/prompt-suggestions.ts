// ============================================================
// Prompt suggestions — the `--prompt-suggestions` contract
// ------------------------------------------------------------
// Official CLI 2.1.202: `--prompt-suggestions [value]` — "In
// print/SDK mode, emits a prompt_suggestion message after each turn
// with a predicted next user prompt".
//
// The official implementation calls a dedicated suggestion endpoint
// (a small model with its own request id, and a last-emitted dedupe so
// an unchanged prediction is not repeated). There is no such endpoint
// behind a third-party OpenAI-compatible provider, so the prediction is
// made with the SAME model the session is already using: one short,
// tool-free completion whose entire reply is the predicted prompt.
//
// Cost note, deliberately not hidden: this is one extra API call per
// user turn. It is routed through the session's budgeted caller so
// `--max-budget-usd` still covers it, and any failure degrades to "no
// suggestion" rather than failing the turn.
// ============================================================

import type { Message, ModelCaller, ModelConfig } from "./types.js";

/** Upper bound on the reply; a predicted prompt is a sentence, not a paragraph. */
const SUGGESTION_MAX_TOKENS = 120;
/** Only the tail of the conversation is sent — the suggestion needs recency. */
const CONTEXT_MESSAGES = 6;
const CONTEXT_CHARS = 2_000;

const SUGGESTION_SYSTEM_PROMPT = [
  "You predict what the user will ask next in a coding session.",
  "Reply with ONLY the next user message, written as the user would type it.",
  "No preamble, no quotes, no explanation, no markdown fence, one message.",
].join(" ");

export interface PromptSuggestionRequest {
  callModel: ModelCaller;
  config: ModelConfig;
  /** The conversation so far, oldest first. */
  messages: Message[];
  /** The assistant's final answer for the turn that just ended. */
  finalText: string;
  abortSignal?: AbortSignal;
}

/** Flatten a message to plain text, bounded so a huge tool payload cannot dominate. */
function transcriptOf(messages: Message[]): string {
  const lines: string[] = [];
  for (const message of messages.slice(-CONTEXT_MESSAGES)) {
    const raw =
      typeof message.content === "string" ? message.content : blocksToText(message.content);
    const text = raw.trim();
    if (!text) continue;
    lines.push(`${message.role}: ${text.slice(-CONTEXT_CHARS)}`);
  }
  return lines.join("\n");
}

function blocksToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block && typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Strip the decoration a chatty model adds to a one-line answer: quotes,
 * fences, a leading label. A prediction that is itself wrapped in quotes
 * would be inserted into a prompt box verbatim, which is never what the
 * user wants.
 */
export function cleanSuggestion(text: string): string | undefined {
  let value = text.trim();
  if (!value) return undefined;
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(value);
  if (fence?.[1]) value = fence[1].trim();
  value = value.replace(/^\s*(?:next\s+)?(?:user\s+)?(?:prompt|message|question)\s*:\s*/i, "");
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1) ||
    (value.startsWith("`") && value.endsWith("`") && value.length > 1)
  )
    value = value.slice(1, -1).trim();
  // Keep it to one line — a multi-paragraph "prediction" is not a prompt.
  value = value.split("\n")[0]?.trim() ?? "";
  return value || undefined;
}

/**
 * Predict the next user prompt. Returns `undefined` when no usable
 * suggestion was produced — never throws, because a suggestion is an
 * optional extra and must not change the outcome of the turn.
 */
export async function generatePromptSuggestion(
  request: PromptSuggestionRequest,
): Promise<string | undefined> {
  const context = transcriptOf(request.messages);
  if (!context) return undefined;
  const prompt = [
    "Conversation so far:",
    context,
    "",
    "The assistant's last reply:",
    request.finalText.trim().slice(-CONTEXT_CHARS) || "(no reply)",
    "",
    "Write the single next message the user would send.",
  ].join("\n");
  const config: ModelConfig = {
    ...request.config,
    maxTokens: SUGGESTION_MAX_TOKENS,
    // Deterministic by construction: this is a guess, not creative writing.
    temperature: 0,
  };
  let text = "";
  try {
    const events = request.callModel(
      [{ role: "user", content: [{ type: "text", text: prompt }] }],
      [],
      SUGGESTION_SYSTEM_PROMPT,
      config,
      request.abortSignal,
    );
    for await (const event of events) {
      if (event.type === "error") return undefined;
      if (event.type === "text_delta") text += event.delta;
    }
  } catch {
    // An aborted or failed suggestion call is a missing extra, not a turn failure.
    return undefined;
  }
  return cleanSuggestion(text);
}
