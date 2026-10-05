import { modelPricing } from "./model-metadata.js";
import { estimateTokens } from "./token-estimator.js";
import type { ModelCaller, ModelConfig } from "./types.js";
export interface ModelBudget {
  limit: number;
  spent: number;
  reserved: number;
}
export function configBudget(config: ModelConfig): ModelBudget | undefined {
  const budget = config.options?.ccrBudget as ModelBudget | undefined;
  return budget && Number.isFinite(budget.limit) ? budget : undefined;
}
/** Shared reservation state prevents concurrent workers from each spending the entire remainder. */
export function withModelBudget(caller: ModelCaller): ModelCaller {
  return async function* (messages, tools, prompt, config, signal) {
    const budget = configBudget(config);
    if (!budget || config.options?.ccrBudgetHandled) {
      yield* caller(messages, tools, prompt, config, signal);
      return;
    }
    const pricing = modelPricing(config.model);
    if (!pricing) throw new Error("Budget enforcement requires known pricing for this model");
    const inputTokens =
      (estimateTokens(messages) +
        Math.ceil(prompt.length / 2) +
        Math.ceil(JSON.stringify(tools.map((tool) => tool.inputSchema)).length / 2)) *
      1.25;
    const remaining = budget.limit - budget.spent - budget.reserved;
    // A non-finite remaining means the accumulator was poisoned by an earlier
    // invalid usage report — fail closed instead of letting NaN comparisons
    // silently disable the budget for every subsequent request.
    if (!Number.isFinite(remaining))
      throw new Error("Budget accounting is corrupted (non-finite spent/reserved)");
    const outputPrice = pricing.output > 0 ? pricing.output : 0;
    const maxOutput =
      outputPrice > 0
        ? Math.min(
            config.maxTokens ?? 4096,
            Math.floor((remaining * 1e6 - inputTokens * pricing.input) / outputPrice),
          )
        : (config.maxTokens ?? 4096);
    if (!Number.isFinite(maxOutput) || maxOutput < 1)
      throw new Error("Remaining budget cannot cover this request");
    const reservation = (inputTokens * pricing.input + maxOutput * pricing.output) / 1e6;
    budget.reserved += reservation;
    const limited = {
      ...config,
      maxTokens: maxOutput,
      options: { ...config.options, ccrBudgetHandled: true },
    };
    let usageReported = false;
    try {
      for await (const event of caller(messages, tools, prompt, limited, signal)) {
        if (event.type === "done") {
          usageReported = true;
          const inTok = event.usage.input_tokens;
          const outTok = event.usage.output_tokens;
          // An adapter that omits usage fields would otherwise poison `spent`
          // with NaN; charge the full reservation instead (conservative).
          budget.spent +=
            Number.isFinite(inTok) && Number.isFinite(outTok)
              ? (inTok * pricing.input + outTok * pricing.output) / 1e6
              : reservation;
        }
        yield event;
      }
    } finally {
      if (!usageReported) budget.spent += reservation;
      budget.reserved = Math.max(0, budget.reserved - reservation);
    }
  };
}
