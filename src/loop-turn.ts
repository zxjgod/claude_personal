import { redactSecrets } from "./audit-log.js";
import { evaluateLoopCompletion, type LoopCheckResult } from "./loop-completion.js";
import { withLoopExecution } from "./loop-execution-context.js";
import {
  beginLoopRound,
  detachLoopController,
  type LoopScope,
  type LoopTicket,
  loopSystemInstruction,
  pauseLoop,
  settleLoopRound,
  ticketRecord,
} from "./loop-runtime.js";
import type { Message, ModelCaller, ModelConfig } from "./types.js";

export interface LoopTurnOutcome {
  error?: unknown;
  aborted?: boolean;
  completed?: boolean;
}
export function lastLoopInput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user")
      return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
  }
  return "";
}
export function loopRetryable(error: unknown): boolean {
  const value = error as { status?: number; code?: string; message?: string } | null;
  const status = value?.status;
  return (
    status === 408 ||
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|rate.?limit|\b429\b|\b50[0234]\b/i.test(
      String(value?.message ?? value?.code ?? error),
    )
  );
}
export async function runLoopTurn(
  scope: LoopScope,
  controller: AbortController,
  deps: {
    messages: Message[];
    callModel: ModelCaller;
    modelConfig: ModelConfig;
    execute: (ticket: LoopTicket | null, instruction: string) => Promise<LoopTurnOutcome>;
    runCheck: (command: string) => Promise<LoopCheckResult>;
    runFileCheck?: (file: string) => Promise<LoopCheckResult>;
    verifying?: () => void;
    notice: (message: string) => void;
  },
): Promise<void> {
  const input = lastLoopInput(deps.messages);
  const ticket = beginLoopRound(scope, input, controller);
  if (!ticket) {
    if (input.startsWith("[Managed loop ")) return;
    await deps.execute(null, "");
    return;
  }
  await withLoopExecution(ticket, async () => {
    try {
      const record = ticketRecord(ticket);
      if (record && !record.priceModel)
        record.priceModel = `${deps.modelConfig.provider}/${deps.modelConfig.model}`;
      const outcome = await deps.execute(ticket, loopSystemInstruction(ticket));
      if (!ticketRecord(ticket)) return;
      if (controller.signal.aborted || outcome.aborted) {
        pauseLoop(scope, true);
        return;
      }
      if (outcome.error) throw outcome.error;
      if (!outcome.completed) throw new Error("The model iteration did not finish normally.");
      deps.verifying?.();
      const completion = await evaluateLoopCompletion(ticket, {
        ...deps,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        pauseLoop(scope, true);
        return;
      }
      const settled = settleLoopRound(ticket, completion);
      if (settled.notice && settled.record)
        deps.notice(`Loop ${settled.record.status}: ${settled.record.reason}`);
    } catch (error) {
      if (controller.signal.aborted && ticketRecord(ticket)) {
        pauseLoop(scope, true);
        return;
      }
      const raw = error instanceof Error ? error.message : String(error);
      const message = redactSecrets(
        deps.modelConfig.apiKey?.length > 7
          ? raw.replaceAll(deps.modelConfig.apiKey, "<redacted>")
          : raw,
      );
      const settled = settleLoopRound(ticket, {
        complete: false,
        reason: message,
        error: message,
        retryable: loopRetryable(error),
      });
      if (settled.notice && settled.record)
        deps.notice(`Loop ${settled.record.status}: ${settled.record.reason}`);
    } finally {
      detachLoopController(ticket);
    }
  });
}
