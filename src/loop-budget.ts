import { loopExecution } from "./loop-execution-context.js";
import { type LoopTicket, loopAccountingRecord, saveLoop } from "./loop-runtime.js";
import { modelPricing } from "./model-metadata.js";
import { estimateTokens, providerPromptTokens } from "./token-estimator.js";
import type { ModelCaller, ModelConfig } from "./types.js";

export class LoopBudgetError extends Error {
  constructor(reason: string) {
    super(`Loop budget: ${reason}`);
    this.name = "LoopBudgetError";
  }
}
const accountedCall = Symbol("loop-budget-call");
export function executionForConfig(config: ModelConfig): LoopTicket | undefined {
  return (config.options?.ccrLoopExecution as LoopTicket | undefined) ?? loopExecution();
}
/** All descendant callers share reservations, including child agents and evaluators. */
export function withLoopBudget(caller: ModelCaller): ModelCaller {
  return async function* (messages, tools, prompt, config, signal) {
    const ticket = executionForConfig(config);
    if (
      !ticket ||
      (config as ModelConfig & { [accountedCall]?: LoopTicket })[accountedCall] === ticket
    ) {
      yield* caller(messages, tools, prompt, config, signal);
      return;
    }
    if (signal?.aborted) throw signal.reason ?? new Error("Loop execution cancelled.");
    const record = loopAccountingRecord(ticket);
    if (
      !record ||
      record.generation !== ticket.generation ||
      !["running", "waiting"].includes(record.status)
    )
      throw new Error("Loop execution is no longer active.");
    const estimate =
      64 +
      Math.ceil(
        (estimateTokens(messages) +
          prompt.length / 2 +
          JSON.stringify(tools.map((tool) => tool.inputSchema)).length / 2) *
          1.25,
      );
    if (!record.priceModel) record.priceModel = `${config.provider}/${config.model}`;
    const prices =
      `${config.provider}/${config.model}` === record.priceModel &&
      record.config.inputPrice !== null &&
      record.config.outputPrice !== null
        ? { input: record.config.inputPrice, output: record.config.outputPrice }
        : modelPricing(config.model);
    if (record.config.usdBudget > 0 && !prices)
      throw new LoopBudgetError(
        "USD enforcement requires model prices. Configure input/output prices or use a token budget.",
      );
    let maxTokens = config.maxTokens ?? 4096;
    if (record.config.tokenBudget > 0)
      maxTokens = Math.min(
        maxTokens,
        Math.floor(
          record.config.tokenBudget -
            record.inputTokens -
            record.outputTokens -
            record.reservedTokens -
            estimate,
        ),
      );
    if (record.config.usdBudget > 0 && prices) {
      const available =
        record.config.usdBudget -
        record.estimatedUsd -
        record.reservedUsd -
        (estimate * prices.input) / 1e6;
      if (available < 0)
        throw new LoopBudgetError("The remaining amount cannot cover the request.");
      if (prices.output > 0)
        maxTokens = Math.min(maxTokens, Math.floor((available * 1e6) / prices.output));
    }
    if (!Number.isFinite(maxTokens) || maxTokens < 1)
      throw new LoopBudgetError(
        "The remaining tokens cannot cover the request. Increase the limit before resuming.",
      );
    const reservedTokens = estimate + maxTokens;
    const reservedUsd = prices ? (estimate * prices.input + maxTokens * prices.output) / 1e6 : 0;
    record.reservedTokens += reservedTokens;
    record.reservedUsd += reservedUsd;
    if (!prices) record.costKnown = false;
    saveLoop(ticket.scope);
    if (!["running", "waiting"].includes(record.status) || record.generation !== ticket.generation)
      throw new Error("Loop execution is no longer active.");
    let accounted = false;
    let sawOutput = false;
    let sawDone = false;
    let outputChars = 0;
    const limited = {
      ...config,
      [accountedCall]: ticket,
      maxTokens,
      options: { ...config.options, ccrLoopExecution: ticket, ccrLoopBudgetHandled: true },
    };
    try {
      for await (const event of caller(messages, tools, prompt, limited, signal)) {
        if (event.type === "text_delta") {
          sawOutput = true;
          outputChars += event.delta.length;
        } else if (event.type === "thinking") {
          sawOutput = true;
          outputChars += event.delta?.length ?? 0;
        } else if (event.type === "tool_use") {
          sawOutput = true;
          outputChars += (event.rawArguments ?? JSON.stringify(event.input)).length;
        } else if (event.type === "done" && !accounted) {
          sawDone = true;
          const input = providerPromptTokens(event.usage, config.provider);
          const output = event.usage.output_tokens;
          if (Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) {
            record.inputTokens += input;
            record.outputTokens += output;
            if (prices)
              record.estimatedUsd += (input * prices.input + output * prices.output) / 1e6;
            accounted = true;
          }
        }
        yield event;
      }
    } finally {
      if (!accounted && (sawDone || sawOutput)) {
        const fallbackOutput = sawDone
          ? maxTokens
          : Math.min(maxTokens, Math.max(1, Math.ceil(outputChars / 3)));
        record.inputTokens += estimate;
        record.outputTokens += fallbackOutput;
        if (prices)
          record.estimatedUsd += (estimate * prices.input + fallbackOutput * prices.output) / 1e6;
      }
      record.reservedTokens = Math.max(0, record.reservedTokens - reservedTokens);
      record.reservedUsd = Math.max(0, record.reservedUsd - reservedUsd);
      saveLoop(ticket.scope);
    }
  };
}
