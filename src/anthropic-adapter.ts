// ============================================================
// Native Anthropic Messages API Adapter
// ============================================================
// Converts the project's OpenAI-like internal message/tool format to the
// official Anthropic Messages API shape. Keeps the rest of the agent loop
// provider-agnostic while enabling native Claude features such as prompt
// caching and accurate streaming usage.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { BETA_HEADER, betaHeaderValue } from "./api-betas.js";
import { anthropicEffort, getEffort, resolveEffortMaxTokens } from "./effort.js";
import {
  DEFAULT_ANTHROPIC_MODEL,
  modelMaxOutput,
  modelSupportsAdaptiveThinking,
  modelSupportsEffort,
} from "./model-metadata.js";
import { prepareMultimodalMessages } from "./multimodal.js";
import { checkResponseForCacheBreak, recordPromptState } from "./prompt-cache.js";
import { DYNAMIC_BOUNDARY } from "./system-prompt.js";
import { DEFAULT_MAX_RESULT_CHARS, truncateToolResult } from "./tools/truncation.js";
import { resolveTool } from "./tools/utils/official-names.js";
import type {
  Message,
  ModelCaller,
  ModelConfig,
  RedactedThinkingBlock,
  StreamEvent,
  ThinkingBlock,
  Tool,
} from "./types.js";
import { createStallController } from "./utils/cancellation.js";

// --- Types kept intentionally local ---

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Tool["inputSchema"];
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
};

/**
 * Cache breakpoint value. Default 5-minute TTL; `CCR_CACHE_TTL_1H=1` opts
 * into the 1-hour extended TTL (Top10 follow-up A7②, user decision: OFF by
 * default — 1h writes cost 2x vs 1.25x and only pay off for long sessions
 * with >5-minute gaps between calls).
 */
function ephemeralCacheControl(): { type: "ephemeral"; ttl?: "1h" } {
  return process.env.CCR_CACHE_TTL_1H === "1"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

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
        cache_control: ephemeralCacheControl(),
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
      cache_control: ephemeralCacheControl(),
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
  const tool = resolveTool(toolName, tools);
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
    formatted[formatted.length - 1].cache_control = ephemeralCacheControl();
  }
  return formatted;
}

/**
 * Add cache_control breakpoints to the message history (12.3).
 * Anthropic caches everything up to a breakpoint, so marking the tail lets
 * the growing history be reused turn-over-turn.
 *
 * Long-turn insurance (Top10 follow-up A7①): a breakpoint only looks back
 * ~20 content blocks for a prior cache entry — one turn dense with
 * tool_use/tool_result pairs can exceed that and silently miss. When the
 * history is long enough, ONE extra breakpoint is placed 15 blocks before the
 * tail. Budget: tools(1) + system(1) + mid(1) + tail(1) = 4, exactly the API
 * maximum — this function must never add more than two message breakpoints.
 *
 * Returns a shallow-copied message array; never mutates the input.
 */
export function withMessageCacheBreakpoint(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const blocks = toContentBlocks(last.content);
  if (blocks.length === 0) return out;
  const newBlocks = blocks.map((b, i) =>
    i === blocks.length - 1 ? { ...b, cache_control: ephemeralCacheControl() } : b,
  );
  out[out.length - 1] = { ...last, content: newBlocks };

  // Mid-history breakpoint, 15 blocks back from the end (only when the tail
  // breakpoint's 20-block lookback could not reach the previous turn).
  const sizes = out.map((m) =>
    typeof m.content === "string" ? 1 : toContentBlocks(m.content).length,
  );
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total > 20) {
    let target = total - 15; // 1-based ordinal of the block to mark
    for (let mi = 0; mi < out.length; mi++) {
      if (target > sizes[mi]) {
        target -= sizes[mi];
        continue;
      }
      const msg = out[mi];
      if (typeof msg.content === "string") {
        if (mi !== out.length - 1) {
          out[mi] = {
            ...msg,
            content: [{ type: "text", text: msg.content, cache_control: ephemeralCacheControl() }],
          };
        }
      } else {
        // .slice() — toContentBlocks hands back the ORIGINAL array reference
        // for array content, so writing mBlocks[bi] in place would mutate the
        // caller's message (review follow-up #4: this function's contract is
        // "never mutates the input"; the main path only escaped the bug
        // because convertMessagesToAnthropic builds fresh arrays).
        const mBlocks = toContentBlocks(msg.content).slice();
        const bi = target - 1;
        const isTailBlock = mi === out.length - 1 && bi === mBlocks.length - 1;
        if (!isTailBlock && mBlocks[bi]) {
          mBlocks[bi] = { ...mBlocks[bi], cache_control: ephemeralCacheControl() };
          out[mi] = { ...msg, content: mBlocks };
        }
      }
      break;
    }
  }
  return out;
}

// --- True token counting (Top10 follow-up A8) ---

/**
 * Exact prompt token count via Anthropic's count_tokens API. Char-ratio
 * estimates drift from the real tokenizer by 15-35% depending on content
 * (and the Opus 4.7+ tokenizer shifted counts further); this is the ground
 * truth for the /context gauge and compaction-decision calibration.
 * Best-effort: short timeout, null on ANY failure (missing key, non-Anthropic
 * provider, network) — callers fall back to the estimator. Never call it per
 * turn on the hot path.
 */
export async function countTokensAnthropic(
  config: ModelConfig,
  systemPrompt: string,
  messages: Message[],
  tools: Tool[],
): Promise<number | null> {
  if (config.provider !== "anthropic" || !config.apiKey) return null;
  try {
    const client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 0,
      timeout: 8_000,
    });
    const res = await client.messages.countTokens({
      model: config.model || DEFAULT_ANTHROPIC_MODEL,
      system: systemPrompt,
      messages: convertMessagesToAnthropic(messages, tools) as unknown as Anthropic.MessageParam[],
      tools:
        tools.length > 0
          ? (formatToolsForAnthropic(tools) as unknown as Anthropic.Tool[])
          : undefined,
    });
    return typeof res.input_tokens === "number" ? res.input_tokens : null;
  } catch {
    return null;
  }
}

// --- Native Anthropic streaming caller ---

export const anthropicCaller: ModelCaller = async function* (
  messages: Message[],
  tools: Tool[],
  systemPrompt: string,
  config: ModelConfig,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const preparedMessages = await prepareMultimodalMessages(messages, config, abortSignal);
  // Official `--betas`: already allowlist-filtered in cli.ts, so this only
  // ever forwards headers the user was actually allowed to request.
  const betaHeader = betaHeaderValue(
    Array.isArray(config.options?.betas) ? (config.options.betas as string[]) : [],
  );

  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    // The agent loop owns retry policy (error-recovery.ts budgets + backoff).
    // The SDK default maxRetries:2 multiplied with it — a sustained 429 could
    // fire ~12 requests for one logical call (Top10 follow-up A4).
    maxRetries: 0,
    // Official `--betas`. Only allowlisted headers ever reach here (api-betas.ts
    // drops the rest with a warning), so this can't be used to smuggle an
    // arbitrary beta onto the wire.
    ...(betaHeader ? { defaultHeaders: { [BETA_HEADER]: betaHeader } } : {}),
  });

  // Compose the caller's AbortSignal (Ctrl+C / turn abort) with a STALL
  // timeout so a hung provider connection can't pin the loop forever — but a
  // long turn that keeps streaming is never killed (review follow-up #3: the
  // old wall-clock 5min cap died mid-generation on 128K-output turns). The
  // loop below calls touch() per event (pings included); the signal also lets
  // the SDK abort the in-flight HTTP request promptly.
  const STREAM_STALL_TIMEOUT_MS = 5 * 60 * 1000;
  const combined = createStallController(abortSignal, STREAM_STALL_TIMEOUT_MS);
  const combinedSignal = combined.signal;

  const model = config.model || DEFAULT_ANTHROPIC_MODEL;

  // Phase 1 of cache-break detection: hash the cacheable prefix + tools so the
  // post-call check can attribute a cache miss to the exact cause.
  recordPromptState(
    {
      systemPrompt,
      tools,
      model,
      effort: getEffort(config.options),
    },
    preparedMessages,
  );
  // Adaptive thinking is an Opus 4.6+ / Sonnet 4.6+ / Sonnet 5 / Fable 5
  // feature; sending `thinking: {type:"adaptive"}` to a model without it
  // (Sonnet 4.5, Haiku 4.5, legacy) is a 400. The default is now gated on the
  // capability table; an explicit options.thinking still wins (caller's call).
  const thinking = (config.options?.thinking ??
    (modelSupportsAdaptiveThinking(model) ? { type: "adaptive" } : undefined)) as
    | Anthropic.ThinkingConfigParam
    | undefined;

  // Per-model output cap from the metadata table (e.g. Haiku 4.5 streams to
  // 64K, not the 128K raise ceiling) — an explicit LLM_MAX_TOKENS override
  // must never exceed what the model accepts.
  const maxTokens = Math.min(
    resolveEffortMaxTokens(getEffort(config.options), config.maxTokens),
    modelMaxOutput(model) ?? Number.POSITIVE_INFINITY,
  );

  // output_config.effort is a documented 400 on Sonnet 4.5 / Haiku 4.5 —
  // gate on the capability table (Top10 follow-up A5). An explicit
  // options.output_config still wins.
  const outputConfig =
    config.options?.output_config ??
    (modelSupportsEffort(model)
      ? { effort: anthropicEffort(getEffort(config.options)) }
      : undefined);

  const stream = client.messages.stream(
    {
      model,
      max_tokens: maxTokens,
      system: formatSystemForAnthropic(systemPrompt),
      messages: withMessageCacheBreakpoint(
        convertMessagesToAnthropic(preparedMessages, tools),
      ) as unknown as Anthropic.MessageParam[],
      tools: tools.length > 0 ? formatToolsForAnthropic(tools) : undefined,
      ...(thinking ? { thinking } : {}),
      ...(outputConfig ? { output_config: outputConfig as Anthropic.OutputConfig } : {}),
    },
    {
      signal: combinedSignal,
      // The old `interleaved-thinking-2025-05-14` beta header is GONE:
      // adaptive thinking enables interleaving automatically, and the header
      // is on the API's remove-list (Top10 follow-up #28).
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

    // P1 early-start: a tool_use block's arguments stream as input_json_delta
    // and are COMPLETE at that block's content_block_stop — no need to wait
    // for finalMessage(). Emitting tool_use at the block boundary lets the
    // agent loop's StreamingToolExecutor start safe tools (Read/Grep/…) while
    // the model is still generating the rest of the turn. Blocks are tracked
    // by stream index (interleaved thinking can open blocks out of order).
    const pendingToolUseByIndex = new Map<
      number,
      { id: string; name: string; jsonBuf: string; startInput: unknown }
    >();
    const emittedToolUseIds = new Set<string>();

    for await (const event of stream) {
      combined.touch(); // stall watchdog: any stream activity rearms the timer
      if (abortSignal?.aborted) break;
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          pendingToolUseByIndex.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            jsonBuf: "",
            // The official API always sends input:{} here and streams the
            // arguments as input_json_delta. Buffered Anthropic-COMPATIBLE
            // relays may instead put the COMPLETE arguments in the start
            // block and emit no deltas — keep it as the boundary fallback so
            // such a stream doesn't execute the tool with empty input.
            startInput: event.content_block.input,
          });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text_delta", delta: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          // Live reasoning content for the UI. `signature_delta` has no live
          // consumer — finalMessage() carries the complete signed block.
          yield { type: "thinking", delta: event.delta.thinking };
        } else if (event.delta.type === "input_json_delta") {
          // Accumulated here for boundary emission; the SDK's finalMessage
          // helper keeps its own copy for the fallback path below.
          const pending = pendingToolUseByIndex.get(event.index);
          if (pending) pending.jsonBuf += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        const pending = pendingToolUseByIndex.get(event.index);
        if (pending) {
          pendingToolUseByIndex.delete(event.index);
          let input: Record<string, unknown>;
          const isPlainObject = (v: unknown): v is Record<string, unknown> =>
            !!v && typeof v === "object" && !Array.isArray(v);
          if (!pending.jsonBuf) {
            // No deltas arrived for this block: fall back to the start
            // block's complete input (relay case) instead of parsing an
            // empty buffer into {}.
            input = isPlainObject(pending.startInput) ? pending.startInput : {};
          } else {
            try {
              const parsed = JSON.parse(pending.jsonBuf);
              input = isPlainObject(parsed) ? parsed : {};
            } catch {
              // Malformed/fragmented stream — skip; finalMessage() below is
              // the authoritative fallback and still emits this block.
              continue;
            }
          }
          emittedToolUseIds.add(pending.id);
          yield { type: "tool_use", id: pending.id, name: pending.name, input };
        }
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
        // Blocks already emitted at their content_block_stop boundary are
        // skipped — re-emitting would double-fire the loop's early-start
        // executor. Blocks that only exist here (malformed stream, or the
        // loop broke early on a boundary parse failure) still emit.
        if (emittedToolUseIds.has(block.id)) continue;
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
    const cacheBreak = checkResponseForCacheBreak(cacheRead, cacheCreation, messages);
    if (cacheBreak && process.env.DEBUG_PROMPT_CACHE === "1") {
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
  } catch (error) {
    if (combinedSignal.aborted && !abortSignal?.aborted) {
      const timeoutError = new Error("Request timed out");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    combined.cleanup();
  }
};
