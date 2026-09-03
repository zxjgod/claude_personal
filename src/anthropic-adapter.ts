// ============================================================
// Native Anthropic Messages API Adapter
// ============================================================
// Converts the project's OpenAI-like internal message/tool format to the
// official Anthropic Messages API shape. Keeps the rest of the agent loop
// provider-agnostic while enabling native Claude features such as prompt
// caching and accurate streaming usage.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { checkResponseForCacheBreak, recordPromptState } from "./prompt-cache.js";
import { DYNAMIC_BOUNDARY } from "./system-prompt.js";
import { DEFAULT_MAX_RESULT_CHARS, truncateToolResult } from "./tools/truncation.js";
import { anthropicEffort, getEffort, resolveEffortMaxTokens } from "./tui/effort.js";
import type {
  Message,
  ModelCaller,
  ModelConfig,
  RedactedThinkingBlock,
  StreamEvent,
  ThinkingBlock,
  Tool,
} from "./types.js";
import { combineAbortSignals } from "./utils/cancellation.js";

// --- Types kept intentionally local ---

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Tool["inputSchema"];
  cache_control?: { type: "ephemeral" };
};

// --- System prompt with cache_control ---

export function formatSystemForAnthropic(
  systemPrompt: string,
): string | Anthropic.TextBlockParam[] {
  const boundaryIndex = systemPrompt.indexOf(DYNAMIC_BOUNDARY);
  if (boundaryIndex === -1) {
    return [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  const stable = systemPrompt.slice(0, boundaryIndex).trimEnd();
  const dynamic = systemPrompt.slice(boundaryIndex).trimStart();
  const blocks: Anthropic.TextBlockParam[] = [];

  if (stable) {
    blocks.push({
      type: "text",
      text: stable,
      cache_control: { type: "ephemeral" },
    });
  }
  if (dynamic) {
    blocks.push({ type: "text", text: dynamic });
  }

  return blocks.length === 1 && !stable ? systemPrompt : blocks;
}

// --- Message conversion ---

/** Get the max chars cap for a tool. Returns DEFAULT_MAX_RESULT_CHARS as fallback. */
function getToolMaxChars(toolName: string, tools: Tool[]): number {
  const tool = tools.find((t) => t.name === toolName);
  if (tool?.maxResultSizeChars) return tool.maxResultSizeChars;
  return DEFAULT_MAX_RESULT_CHARS;
}

export function convertMessagesToAnthropic(
  messages: Message[],
  tools: Tool[] = [],
): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        // Anthropic's top-level `system` handles initial system context. If a
        // compacted summary was injected into message history, preserve it as a
        // user-side context block so all Claude models accept the transcript.
        out.push({
          role: "user",
          content: [{ type: "text", text: msg.content }],
        });
        break;

      case "user":
        out.push({
          role: "user",
          content: msg.content.map((block) => {
            if (block.type === "text") {
              return { type: "text", text: block.text };
            }
            if (block.type === "image") {
              if (block.source.type === "base64") {
                // Anthropic represents PDFs as `document` blocks, images as `image`.
                const isPdf = block.source.media_type === "application/pdf";
                return {
                  type: isPdf ? "document" : "image",
                  source: {
                    type: "base64",
                    media_type: block.source.media_type,
                    data: block.source.data,
                  },
                };
              }
              return {
                type: "image",
                source: { type: "url", url: block.source.url },
              };
            }
            throw new Error(`Unknown user content block: ${(block as { type: string }).type}`);
          }),
        });
        break;

      case "assistant": {
        const content: Array<Record<string, unknown>> = [];
        // Interleaved thinking invariant: thinking blocks (signature included)
        // must come FIRST in the assistant content and be passed back verbatim —
        // spread-copy, never rebuild — or the API 400s the follow-up request.
        for (const tb of msg.thinking ?? []) {
          content.push({ ...tb });
        }
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const call of msg.tool_calls ?? []) {
          // Tool-call arguments are model-generated JSON strings; a truncated or
          // malformed payload (rare but possible mid-stream / after a provider
          // hiccup) must not crash the whole adapter. Degrade to an empty input
          // so the loop can surface a tool error instead of dying — mirrors the
          // guarded parse in llm-adapter.ts.
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(call.function.arguments || "{}");
          } catch {
            parsedInput = {};
          }
          content.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: parsedInput,
          });
        }
        out.push({
          role: "assistant",
          content: content.length > 0 ? content : "",
        });
        break;
      }

      case "tool": {
        // P0-1 Fix: truncate tool result at API-call time, not in message history.
        // The full result is preserved in messages[] for session snapshot / resume.
        const maxChars = getToolMaxChars(msg.name ?? "", tools);
        const truncated = truncateToolResult(msg.content, maxChars);
        const apiContent = truncated.truncated ? truncated.preview : msg.content;
        // Anthropic requires tool results in a user message.
        out.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id,
              content: apiContent,
            },
          ],
        });
        break;
      }
    }
  }

  return mergeAdjacentSameRoleMessages(out);
}

function mergeAdjacentSameRoleMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  // Note: if two assistant messages were ever merged, the second's thinking
  // blocks would land mid-content and violate the thinking-first ordering rule.
  // In practice tool_result user messages always separate assistant turns, so
  // this path only merges same-role user/tool runs.
  const merged: AnthropicMessage[] = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (!prev || prev.role !== msg.role) {
      merged.push(msg);
      continue;
    }

    const prevBlocks = toContentBlocks(prev.content);
    const nextBlocks = toContentBlocks(msg.content);
    prev.content = [...prevBlocks, ...nextBlocks];
  }
  return merged;
}

function toContentBlocks(
  content: string | Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return content;
}

// --- Tool conversion ---

export function formatToolsForAnthropic(tools: Tool[]): AnthropicTool[] {
  const formatted: AnthropicTool[] = tools
    .filter((t) => t.isEnabled())
    .map((t) => ({
      name: t.name,
      description: t.promptDescription,
      input_schema: t.inputSchema,
    }));
  // 12.3: Cache the tool definitions too. A cache_control breakpoint on the
  // LAST tool tells Anthropic to cache the whole tools prefix (which is stable
  // across a session), so subsequent turns read it from cache.
  if (formatted.length > 0) {
    formatted[formatted.length - 1].cache_control = { type: "ephemeral" };
  }
  return formatted;
}

/**
 * Add a cache_control breakpoint to the last block of the last message (12.3).
 * Anthropic caches everything up to the breakpoint, so marking the tail of the
 * conversation lets the growing message history be reused turn-over-turn.
 * Returns a shallow-copied message array; never mutates the input.
 */
export function withMessageCacheBreakpoint(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const blocks = toContentBlocks(last.content);
  if (blocks.length === 0) return out;
  const newBlocks = blocks.map((b, i) =>
    i === blocks.length - 1 ? { ...b, cache_control: { type: "ephemeral" } } : b,
  );
  out[out.length - 1] = { ...last, content: newBlocks };
  return out;
}

// --- Native Anthropic streaming caller ---

export const anthropicCaller: ModelCaller = async function* (
  messages: Message[],
  tools: Tool[],
  systemPrompt: string,
  config: ModelConfig,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  // Compose the caller's AbortSignal (Ctrl+C / turn abort) with a safety
  // timeout so a hung provider connection can't pin the loop forever. The
  // stream timeout is generous (5 min) because Anthropic streams chunks; the
  // signal also lets the SDK abort the in-flight HTTP request promptly.
  const STREAM_TIMEOUT_MS = 5 * 60 * 1000;
  const combined = combineAbortSignals(abortSignal, STREAM_TIMEOUT_MS);
  const combinedSignal = combined.signal;

  // Phase 1 of cache-break detection: hash the cacheable prefix + tools so the
  // post-call check can attribute a cache miss to the exact cause.
  recordPromptState({
    systemPrompt,
    tools,
    model: config.model || "claude-opus-4-8",
    effort: getEffort(config.options),
  });

  // Claude 4.8 benefits from adaptive thinking; harmlessly omitted when the
  // caller uses a non-Claude provider because this adapter only runs for
  // provider="anthropic". An explicit options.thinking still wins.
  const thinking = (config.options?.thinking ?? {
    type: "adaptive",
  }) as Anthropic.ThinkingConfigParam;
  const thinkingEnabled =
    typeof thinking === "object" && (thinking as { type?: string }).type !== "disabled";

  const stream = client.messages.stream(
    {
      model: config.model || "claude-opus-4-8",
      max_tokens: resolveEffortMaxTokens(getEffort(config.options), config.maxTokens),
      system: formatSystemForAnthropic(systemPrompt),
      messages: withMessageCacheBreakpoint(
        convertMessagesToAnthropic(messages, tools),
      ) as unknown as Anthropic.MessageParam[],
      tools: tools.length > 0 ? formatToolsForAnthropic(tools) : undefined,
      thinking,
      // The /effort tier drives reasoning depth. An explicit output_config in
      // options still wins; otherwise map the tier (default "high").
      output_config: (config.options?.output_config ?? {
        effort: anthropicEffort(getEffort(config.options)),
      }) as Anthropic.OutputConfig,
    },
    {
      signal: combinedSignal,
      // Interleaved thinking beta (SDK 0.105 has no `betas` request param, so
      // go through RequestOptions.headers). Lets thinking blocks appear between
      // tool_use rounds in one turn; required for the passback invariant below.
      ...(thinkingEnabled
        ? { headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" } }
        : {}),
    },
  );

  // If the caller aborts (Ctrl+C), ask the SDK to stop the stream immediately
  // rather than waiting for the next chunk. Without this the in-flight HTTP
  // request keeps streaming until the provider finishes its turn.
  const onAbort = () => {
    try {
      stream.controller.abort();
    } catch {
      /* already aborted / finalized */
    }
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    stream.on("text", (text) => {
      void text;
    });

    for await (const event of stream) {
      if (abortSignal?.aborted) break;
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text_delta", delta: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          // Live reasoning content for the UI. `signature_delta` has no live
          // consumer — finalMessage() carries the complete signed block.
          yield { type: "thinking", delta: event.delta.thinking };
        }
        // `input_json_delta` is accumulated by the SDK finalMessage helper;
        // no partial tool input event is needed by the current agent loop.
      }
    }

    if (abortSignal?.aborted) {
      yield {
        type: "error",
        error: new Error("Aborted"),
      };
      return;
    }

    const final = await stream.finalMessage();

    // Collect signed thinking blocks alongside tool_use. They are attached to
    // the `done` event (atomic handoff: the signature only exists here, never
    // in deltas) and the agent loop stores them on the assistant message for
    // verbatim passback in convertMessagesToAnthropic above.
    const thinkingBlocks: Array<ThinkingBlock | RedactedThinkingBlock> = [];
    for (const block of final.content) {
      if (block.type === "tool_use") {
        yield {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        };
      } else if (block.type === "thinking") {
        thinkingBlocks.push({
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        });
      } else if (block.type === "redacted_thinking") {
        thinkingBlocks.push({ type: "redacted_thinking", data: block.data });
      }
    }

    // Anthropic's `input_tokens` already EXCLUDES cache tokens (those are billed
    // and reported separately as cache_creation_input_tokens / cache_read_input_tokens).
    // Previously we summed all three into `input_tokens`, double-counting cached
    // content (the same segment was counted at creation AND at read), inflating
    // /cost and autoCompact estimates, and diverging from the OpenAI path which
    // only counts prompt_tokens. Now `input_tokens` mirrors Anthropic's own
    // field (non-cached input only); the cache breakdown is carried alongside
    // so /cost can show hit rate and the loop can estimate "live" context size
    // as input + cache_read (the tokens actually occupying the context window).
    const u = final.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheCreation = u.cache_creation_input_tokens ?? 0;

    // Phase 2 of cache-break detection: surface a break with its root cause.
    const cacheBreak = checkResponseForCacheBreak(cacheRead, cacheCreation);
    if (cacheBreak) {
      console.warn(
        `[prompt cache break] ${cacheBreak.reason} ` +
          `(cache read ${cacheRead} tokens, creation ${cacheCreation})`,
      );
    }

    // M40: Anthropic reports output truncation as stop_reason "max_tokens",
    // but the agent loop's truncation recovery keys off the OpenAI-style
    // finish_reason "length". Normalize here so a truncated Anthropic stream
    // triggers the same continue-and-recover path instead of silently
    // returning a half answer as if complete.
    const stopReason = final.stop_reason;
    const finishReason = stopReason === "max_tokens" ? "length" : (stopReason ?? "end_turn");

    yield {
      type: "done",
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
      finish_reason: finishReason,
      ...(thinkingBlocks.length > 0 ? { thinking: thinkingBlocks } : {}),
    };
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    combined.cleanup();
  }
};
