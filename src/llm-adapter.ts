// ============================================================
// Multi-Provider LLM Client Adapter
// ============================================================

import OpenAI from "openai";
import { anthropicCaller } from "./anthropic-adapter.js";
import { isCloudGateway, resolveGateway } from "./cloud-gateway.js";
import { DEFAULT_MAX_RESULT_CHARS, truncateToolResult } from "./tools/truncation.js";
import {
  getEffort,
  getEffortStrategy,
  modelSupportsReasoningEffort,
  openaiReasoningEffort,
  resolveEffortMaxTokens,
} from "./tui/effort.js";
import type { Message, ModelCaller, ModelConfig, StreamEvent, Tool } from "./types.js";
import { combineAbortSignals } from "./utils/cancellation.js";

// --- Provider Default Configurations ---

const PROVIDER_CONFIGS: Record<string, { baseURL: string; defaultModel: string }> = {
  anthropic: {
    baseURL: "https://api.anthropic.com",
    defaultModel: "claude-opus-4-8",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
  },
  deepseek: {
    baseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
  },
  qwen: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
  },
  moonshot: {
    baseURL: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-128k",
  },
  zhipu: {
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4",
  },
  custom: {
    baseURL: "http://localhost:11434/v1",
    defaultModel: "llama3",
  },
};

/** Exported provider defaults for use by other modules (e.g. /provider command) */
export const PROVIDER_DEFAULTS = PROVIDER_CONFIGS;

// --- Message Conversion (Internal → OpenAI) ---

/**
 * Per-tool model-facing result cap. Looked up from the live tool set on every
 * call so Read's `maxResultSizeChars = Infinity` (never truncate a Read) is
 * honored — previously this resolved through a global registry handle that was
 * never assigned, so every tool silently fell back to the default cap.
 * Falls back to DEFAULT_MAX_RESULT_CHARS for unknown tools.
 */
function getToolMaxChars(toolName: string, tools: Tool[]): number {
  const tool = tools.find((t) => t.name === toolName);
  if (tool?.maxResultSizeChars) return tool.maxResultSizeChars;
  return DEFAULT_MAX_RESULT_CHARS;
}

function convertToOpenAIMessage(
  msg: Message,
  tools: Tool[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (msg.role) {
    case "user":
      return {
        role: "user",
        content: msg.content.map((block) => {
          if (block.type === "text") {
            return { type: "text", text: block.text } as const;
          }
          if (block.type === "image") {
            const url =
              block.source.type === "base64"
                ? `data:${block.source.media_type};base64,${block.source.data}`
                : block.source.url!;
            return {
              type: "image_url",
              image_url: { url },
            } as const;
          }
          throw new Error(`Unknown content type: ${(block as { type: string }).type}`);
        }),
      };

    case "assistant":
      return {
        role: "assistant",
        content: msg.content,
        tool_calls: msg.tool_calls,
      };

    case "tool": {
      // P0-1 Fix: truncate tool result at API-call time, not in message history.
      // The full result is preserved in messages[] for session snapshot / resume.
      const maxChars = getToolMaxChars(msg.name ?? "", tools);
      const truncated = truncateToolResult(msg.content, maxChars);
      const apiContent = truncated.truncated ? truncated.preview : msg.content;
      return {
        role: "tool",
        tool_call_id: msg.tool_call_id,
        content: apiContent,
      };
    }

    case "system":
      return {
        role: "system",
        content: msg.content,
      };
  }
}

// --- OpenAI-Compatible Streaming Caller ---

async function* openAICompatibleCaller(
  messages: Message[],
  tools: Tool[],
  systemPrompt: string,
  config: ModelConfig,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL:
      config.baseURL || PROVIDER_CONFIGS[config.provider]?.baseURL || "https://api.openai.com/v1",
  });

  const model = config.model || PROVIDER_CONFIGS[config.provider]?.defaultModel || "gpt-4o";

  const requestMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => convertToOpenAIMessage(m, tools)),
  ];

  // Reasoning effort (/effort). Only reasoning-capable models accept
  // `reasoning_effort`; sending it to a plain chat model can 400 on strict
  // providers, so gate it behind a model-capability check. The same gate
  // suppresses `temperature` — reasoning models (DeepSeek R1, o1/o3, QwQ)
  // reject it, so we must omit it rather than default it.
  const isReasoningModel = modelSupportsReasoningEffort(config.provider, model);
  const reasoningEffort = isReasoningModel
    ? openaiReasoningEffort(getEffort(config.options))
    : undefined;
  const effort = getEffortStrategy(config.options);

  // Compose the caller's AbortSignal (Ctrl+C / turn abort) with a safety
  // timeout so a hung provider stream can't pin the loop indefinitely. The
  // OpenAI SDK forwards `signal` to fetch, aborting the in-flight request.
  const STREAM_TIMEOUT_MS = 5 * 60 * 1000;
  const combined = combineAbortSignals(abortSignal, STREAM_TIMEOUT_MS);
  const combinedSignal = combined.signal;

  try {
    const stream = await client.chat.completions.create(
      {
        model,
        messages: requestMessages,
        tools: tools.length > 0 ? formatToolsForOpenAI(tools) : undefined,
        tool_choice: tools.length > 0 ? "auto" : undefined,
        max_tokens: resolveEffortMaxTokens(getEffort(config.options), config.maxTokens),
        temperature: isReasoningModel ? undefined : (config.temperature ?? effort.temperature),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        stream: true,
        // Ask the provider to emit a final usage chunk. Without this, streamed
        // responses carry no token counts and usage stays at zero — breaking
        // both the CLI token display and the auto-compaction threshold.
        stream_options: { include_usage: true },
      },
      { signal: combinedSignal },
    );

    // Parse streaming response
    const toolCallBuffers: Map<number, { id: string; name: string; arguments: string }> = new Map();

    let usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } = {
      input_tokens: 0,
      output_tokens: 0,
    };
    let finishReason = "stop";
    let toolCallsEmitted = false;

    const emitToolCalls = function* (): Generator<StreamEvent> {
      if (toolCallsEmitted) return;
      toolCallsEmitted = true;
      for (const [, buf] of toolCallBuffers) {
        try {
          const input = JSON.parse(buf.arguments);
          yield { type: "tool_use", id: buf.id, name: buf.name, input };
        } catch {
          // A truncated stream (finish_reason === "length") leaves tool-call
          // arguments incomplete. That is recoverable — drop the partial call and
          // let the loop continue from the accumulated text — not a fatal error.
          if (finishReason === "length") {
            continue;
          }
          // Preserve malformed JSON for a paired error result; the next model
          // call can correct its arguments without losing the whole response.
          yield {
            type: "tool_use",
            id: buf.id,
            name: buf.name,
            input: {},
            rawArguments: buf.arguments,
          };
        }
      }
    };

    for await (const chunk of stream) {
      if (abortSignal?.aborted) break;
      const delta = chunk.choices[0]?.delta;

      // Text delta
      if (delta?.content) {
        yield { type: "text_delta", delta: delta.content };
      }

      // Tool call delta
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallBuffers.has(tc.index)) {
            toolCallBuffers.set(tc.index, {
              id: tc.id || "",
              name: tc.function?.name || "",
              arguments: "",
            });
          }
          const buf = toolCallBuffers.get(tc.index)!;
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name = tc.function.name;
          if (tc.function?.arguments) buf.arguments += tc.function.arguments;
        }
      }

      // Usage — with stream_options.include_usage this arrives in a final
      // chunk whose `choices` array is empty, AFTER the finish_reason chunk.
      // OpenAI's prompt_tokens is the total input billed for the call; when the
      // provider serves a prompt-cache hit it reports `prompt_tokens_details.
      // cached_tokens` separately. We keep input_tokens == prompt_tokens (the
      // non-cached + cached total billed) and surface cached_tokens as
      // cache_read so /cost and autoCompact see a cache breakdown consistent
      // with the Anthropic path. (input_tokens here is NOT double-counted:
      // prompt_tokens already includes cached tokens, so we do not add
      // cache_read on top — unlike Anthropic where input_tokens excludes them.)
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage = {
          input_tokens: chunk.usage.prompt_tokens || 0,
          output_tokens: chunk.usage.completion_tokens || 0,
          cache_read_input_tokens: cached,
        };
      }

      // Finish reason — emit completed tool calls now, but defer the `done`
      // event until the stream fully drains so the usage chunk is included.
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
        yield* emitToolCalls();
      }
    }

    // Stream drained — emit tool calls if finish_reason never fired, then done.
    // If the caller aborted mid-stream, surface a recoverable error so the loop
    // can stop cleanly instead of committing partial tool calls.
    if (abortSignal?.aborted) {
      yield { type: "error", error: new Error("Aborted") };
      return;
    }
    yield* emitToolCalls();
    yield { type: "done", usage, finish_reason: finishReason };
  } catch (error) {
    // The SDK may normalize an AbortController timeout to a generic
    // AbortError. Preserve a distinct TimeoutError so the agent loop retries a
    // transient provider timeout instead of treating it as Ctrl+C.
    if (combinedSignal.aborted && !abortSignal?.aborted) {
      const timeoutError = new Error("Request timed out");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw error;
  } finally {
    combined.cleanup();
  }
}

// --- Format Tools for OpenAI ---

function formatToolsForOpenAI(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools
    .filter((t) => t.isEnabled())
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.promptDescription,
        parameters: t.inputSchema,
      },
    }));
}

// --- Model Caller Factory ---

export function createModelCaller(cfg: ModelConfig): ModelCaller {
  if (cfg.provider === "anthropic") {
    return anthropicCaller;
  }
  // All non-Anthropic providers use OpenAI-compatible API for now.
  return openAICompatibleCaller;
}

// --- Error Detection Helpers ---

/**
 * Minimal structural view of provider/SDK errors for status/message probing.
 * Errors arrive as `unknown` from catch sites; only these two fields are read.
 */
type ApiErrorShape = { status?: number; message?: string } | null;

export function isRateLimitError(error: unknown): boolean {
  return (error as ApiErrorShape)?.status === 429;
}

// NOTE: context-length detection lives ONLY in error-recovery.ts
// (isContextLengthError, shared CONTEXT_LENGTH_RE covering both the OpenAI and
// Anthropic wordings). A duplicate copy here drifted out of sync and was
// dead code — removed under Top10 #3. Import it from error-recovery.js.

export function isAuthError(error: unknown): boolean {
  const status = (error as ApiErrorShape)?.status;
  return status === 401 || status === 403;
}

export function isProviderError(error: unknown): boolean {
  return ((error as ApiErrorShape)?.status ?? 0) >= 500;
}

// --- Provider Resolution ---

export function resolveProviderConfig(
  partial: Partial<ModelConfig> & { apiKey: string },
): ModelConfig {
  const provider = partial.provider || "openai";
  const defaults = PROVIDER_CONFIGS[provider] || PROVIDER_CONFIGS.custom;

  // Cloud gateway routing (11.3). When `options.gateway` names a managed
  // gateway, resolve its OpenAI-compatible base URL from region/project. An
  // explicit baseURL still wins so users can point at a private proxy.
  let baseURL = partial.baseURL || defaults.baseURL;
  let model = partial.model || defaults.defaultModel;
  const gateway = partial.options?.gateway as string | undefined;
  if (isCloudGateway(gateway)) {
    const resolved = resolveGateway(gateway, {
      region: partial.options?.gatewayRegion as string | undefined,
      project: partial.options?.gatewayProject as string | undefined,
    });
    if (!partial.baseURL) baseURL = resolved.baseURL;
    if (!partial.model) model = resolved.defaultModel;
  }

  return {
    provider,
    model,
    apiKey: partial.apiKey,
    baseURL,
    maxTokens: partial.maxTokens,
    temperature: partial.temperature,
    options: partial.options,
  };
}

export { PROVIDER_CONFIGS };
