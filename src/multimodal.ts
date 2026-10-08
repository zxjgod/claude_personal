import { MAX_PDF_BYTES, readPdf } from "./pdf.js";
import type { ContentBlock, Message, ModelConfig, UserMessage } from "./types.js";

/** Unknown models keep the vision path; custom deployments can override it. */
export function supportsImageInput(config?: ModelConfig): boolean {
  if (typeof config?.options?.supportsImages === "boolean") return config.options.supportsImages;
  const model = config?.model.toLowerCase() ?? "";
  return !/^(deepseek-chat|deepseek-reasoner|deepseek-r1(?:-|$)|o1-mini(?:-|$)|o3-mini(?:-|$)|gpt-3\.5(?:-|$)|moonshot-v1(?:-|$)|glm-4-plus$|qwen-plus$|qwen-turbo$)/.test(
    model,
  );
}

const preparedCache = new WeakMap<UserMessage, Map<boolean, UserMessage>>();

/** Convert legacy PDF attachments at the API boundary, including resumed sessions. */
export async function prepareMultimodalMessages(
  messages: Message[],
  config: ModelConfig,
  signal?: AbortSignal,
): Promise<Message[]> {
  const vision = supportsImageInput(config);
  const out: Message[] = [];
  for (const message of messages) {
    signal?.throwIfAborted();
    if (
      message.role !== "user" ||
      !message.content.some(
        (block) =>
          block.type === "image" && (!vision || block.source.media_type === "application/pdf"),
      )
    ) {
      out.push(message);
      continue;
    }
    const cached = preparedCache.get(message)?.get(vision);
    if (cached) {
      out.push(cached);
      continue;
    }
    const content: ContentBlock[] = [];
    let cacheable = true;
    for (const block of message.content) {
      if (block.type === "image" && block.source.media_type === "application/pdf") {
        try {
          if (block.source.type !== "base64" || !block.source.data)
            throw new Error(
              "Only embedded PDF data can be converted locally; read the local PDF again.",
            );
          if (block.source.data.length > Math.ceil(MAX_PDF_BYTES / 3) * 4)
            throw new Error("PDF attachment exceeds the local processing limit.");
          const result = await readPdf(Buffer.from(block.source.data, "base64"), {
            renderImages: vision,
            signal,
          });
          content.push(
            { type: "text", text: `Converted PDF attachment:\n${result.content}` },
            ...(result.images ?? []),
          );
        } catch (error) {
          signal?.throwIfAborted();
          cacheable = false;
          content.push({
            type: "text",
            text: `[PDF attachment could not be processed: ${error instanceof Error ? error.message : String(error)}. Its content has not been inspected. Read the local PDF again with a small pages range.]`,
          });
        }
      } else if (block.type === "image" && !vision) {
        content.push({
          type: "text",
          text: "[Image omitted: the current model is configured for text input only. The image has not been inspected; switch to a vision model to read it.]",
        });
      } else content.push(block);
    }
    const prepared: UserMessage = { ...message, content };
    if (cacheable) {
      const cache = preparedCache.get(message) ?? new Map<boolean, UserMessage>();
      cache.set(vision, prepared);
      preparedCache.set(message, cache);
    }
    out.push(prepared);
  }
  return out;
}
