import type { Message, ModelCaller, ModelConfig } from "../../types.js";
import { combineAbortSignals } from "../../utils/cancellation.js";

/** One bounded, tool-free handoff after the exploration budget is exhausted.
 * Never turn process narration into a successful review, or restart work after
 * cancellation. The caller labels even a successful handoff as incomplete.
 */
export async function collectPartialReport(
  messages: Message[],
  caller: ModelCaller,
  config: ModelConfig,
  systemPrompt: string,
  parentSignal?: AbortSignal,
): Promise<string> {
  if (parentSignal?.aborted) return "";
  const combined = combineAbortSignals(parentSignal, 60_000);
  const history: Message[] = [
    ...messages,
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "The exploration budget has ended. Do not call tools or continue investigating. " +
            "Return a concise partial handoff using only evidence already collected: confirmed findings " +
            "with file references, checks actually performed, and unchecked scope/next steps. " +
            "Explicitly state that the task is incomplete. Do not invent findings or claim tests passed.",
        },
      ],
    },
  ];
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => {
        let text = "";
        let complete = false;
        for await (const event of caller(history, [], systemPrompt, config, combined.signal)) {
          if (combined.signal.aborted) return "";
          if (event.type === "text_delta") text += event.delta;
          if (event.type === "tool_use" || event.type === "error") return "";
          if (event.type === "done") {
            complete = ["stop", "end_turn", "completed", "end"].includes(event.finish_reason);
          }
        }
        return complete ? text.trim() : "";
      })(),
      new Promise<string>((resolve) => {
        onAbort = () => resolve("");
        if (combined.signal.aborted) onAbort();
        else combined.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch {
    return "";
  } finally {
    if (onAbort) combined.signal.removeEventListener("abort", onAbort);
    combined.cleanup();
  }
}
