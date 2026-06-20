// ============================================================
// Multi-Provider LLM Client Adapter
// ============================================================

import OpenAI from "openai";
import { anthropicCaller } from "./anthropic-adapter.js";
import { isCloudGateway, resolveGateway } from "./cloud-gateway.js";
import type {
  Message,
  ModelCaller,
  ModelConfig,
  StreamEvent,
  Tool,
} from "./types.js";

// --- Provider Default Configurations ---

const PROVIDER_CONFIGS: Record<
  string,
  { baseURL: string; defaultModel: string }
> = {
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

// --- Message Conversion (Internal → OpenAI) ---

function convertToOpenAIMessage(
  msg: Message,
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
          throw new Error(`Unknown content type: ${(block as any).type}`);
        }),
      };

    case "assistant":
      return {
        role: "assistant",
        content: msg.content,
        tool_calls: msg.tool_calls as any,
      };

    case "tool":
      return {
        role: "tool",
        tool_call_id: msg.tool_call_id,
        content: msg.content,
      };

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
): AsyncGenerator<StreamEvent> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL:
      config.baseURL ||
      PROVIDER_CONFIGS[config.provider]?.baseURL ||
      "https://api.openai.com/v1",
  });

  const model =
    config.model || PROVIDER_CONFIGS[config.provider]?.defaultModel || "gpt-4o";

  const requestMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    [
      { role: "system", content: systemPrompt },
      ...messages.map(convertToOpenAIMessage),
    ];

  const stream = await client.chat.completions.create({
    model,
    messages: requestMessages,
    tools: tools.length > 0 ? formatToolsForOpenAI(tools) : undefined,
    tool_choice: tools.length > 0 ? "auto" : undefined,
    max_tokens: config.maxTokens,
    temperature: config.temperature ?? 0.1,
    stream: true,
    // Ask the provider to emit a final usage chunk. Without this, streamed
    // responses carry no token counts and usage stays at zero — breaking
    // both the CLI token display and the auto-compaction threshold.
    stream_options: { include_usage: true },
  });

  // Parse streaming response
  const toolCallBuffers: Map<
    number,
    { id: string; name: string; arguments: string }
  > = new Map();

  let usage = { input_tokens: 0, output_tokens: 0 };
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
        yield {
          type: "error",
          error: new Error(
            `Failed to parse tool arguments for "${buf.name}"`,
          ),
        };
      }
    }
  };

  for await (const chunk of stream) {
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
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens || 0,
        output_tokens: chunk.usage.completion_tokens || 0,
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
  yield* emitToolCalls();
  yield { type: "done", usage, finish_reason: finishReason };
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

export function isRateLimitError(error: any): boolean {
  return error?.status === 429;
}

export function isContextLengthError(error: any): boolean {
  return (
    error?.status === 400 &&
    (error?.message?.includes("context_length") ||
      error?.message?.includes("maximum context"))
  );
}

export function isAuthError(error: any): boolean {
  return error?.status === 401 || error?.status === 403;
}

export function isProviderError(error: any): boolean {
  return error?.status >= 500;
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
