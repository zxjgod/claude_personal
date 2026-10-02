import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import Ajv from "ajv";
import { agentLoop } from "./agent-loop.js";
import { beginUserTurn } from "./checkpoint.js";
import type { parseCliArgs } from "./cli-args.js";
import { sessionGoal } from "./goal-runtime.js";
import { configBudget, withModelBudget } from "./model-budget.js";
import { modelPricing } from "./model-metadata.js";
import type { HookRunner, Message, ModelCaller, ModelConfig, Tool, ToolContext } from "./types.js";

export async function* headlessInputs(
  args: ReturnType<typeof parseCliArgs>,
  input: NodeJS.ReadableStream,
): AsyncGenerator<string> {
  if (args.inputFormat === "stream-json" && (input as { isTTY?: boolean }).isTTY)
    throw new Error(
      "stream-json input requires a pipe or file; interactive terminal input is unsupported",
    );
  if (args.prompt) yield args.prompt;
  if (args.inputFormat === "stream-json") {
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const value = JSON.parse(line) as {
          type?: string;
          prompt?: unknown;
          content?: unknown;
          message?: { role?: string; content?: unknown };
        };
        if (value.type && value.type !== "user")
          throw new Error(`Unsupported input message: ${value.type}`);
        const content = value.message?.content ?? value.prompt ?? value.content;
        if (typeof content === "string") yield content;
        else if (Array.isArray(content))
          yield content
            .filter((block) => block?.type === "text")
            .map((block) => block.text)
            .join("\n");
        else throw new Error("Expected a user message with text content");
      }
    } finally {
      lines.close();
    }
  } else if (!args.prompt) {
    let text = "";
    for await (const chunk of input) text += chunk;
    if (text.trim()) yield text.trim();
  }
}
export async function runHeadless(deps: {
  args: ReturnType<typeof parseCliArgs>;
  input: NodeJS.ReadableStream;
  emit(value: string): void;
  messages: Message[];
  tools: Tool[];
  callModel: ModelCaller;
  config: ModelConfig;
  context: ToolContext;
  hooks?: HookRunner;
  systemPrompt: string;
  save(messages: Message[]): Promise<void>;
}): Promise<void> {
  const { args, context } = deps;
  if (
    args.maxBudgetUsd !== undefined &&
    (!Number.isFinite(args.maxBudgetUsd) || args.maxBudgetUsd <= 0)
  )
    throw new Error("--max-budget-usd must be positive");
  const price = modelPricing(deps.config.model);
  if (args.maxBudgetUsd && !price)
    throw new Error(
      "Budget enforcement requires configured model pricing; this model has no known price",
    );
  const validator = args.jsonSchema
    ? new Ajv.default({ allErrors: true, strict: false }).compile(JSON.parse(args.jsonSchema))
    : undefined;
  if (args.maxBudgetUsd)
    deps.config.options = {
      ...deps.config.options,
      ccrBudget: { limit: args.maxBudgetUsd, spent: 0, reserved: 0 },
    };
  const spent = () => configBudget(deps.config)?.spent ?? 0;
  let estimatedCost = 0;
  const json = (value: unknown) => deps.emit(`${JSON.stringify(value)}\n`);
  if (args.outputFormat === "stream-json")
    json({
      type: "system",
      subtype: "init",
      session_id: context.sessionId,
      cwd: context.workspaceRoot,
      model: deps.config.model,
      tools: deps.tools.map((tool) => tool.name),
      uuid: randomUUID(),
    });
  const budgetCaller = withModelBudget(deps.callModel);
  for await (const prompt of headlessInputs(args, deps.input)) {
    const started = Date.now();
    const message: Message = { role: "user", content: [{ type: "text", text: prompt }] };
    beginUserTurn(context.sessionId, message);
    deps.messages.push(message);
    const inheritedMessages = new Set(deps.messages);
    if (args.outputFormat === "stream-json" && args.replayUserMessages)
      json({
        type: "user",
        message: { role: "user", content: message.content },
        session_id: context.sessionId,
        uuid: randomUUID(),
      });
    let text = "";
    let error: string | undefined;
    let turns = 0;
    const usage = { input_tokens: 0, output_tokens: 0 };
    const systemPrompt = `${args.systemPrompt ?? deps.systemPrompt}${args.appendSystemPrompt ? `\n\n${args.appendSystemPrompt}` : ""}${args.jsonSchema ? `\n\nReturn the final answer as JSON satisfying this schema: ${args.jsonSchema}` : ""}`;
    try {
      const loop = agentLoop(deps.messages, deps.tools, budgetCaller, deps.config, {
        systemPrompt,
        maxTurns: args.maxTurns,
        askUser: async () => false,
        hooks: deps.hooks,
        toolContext: context,
      });
      while (true) {
        const step = await loop.next();
        if (step.done) {
          turns = step.value.turns;
          error =
            step.value.reason === "completed" || step.value.reason === "stop_hook_prevented"
              ? undefined
              : `${step.value.reason}${step.value.error ? `: ${String(step.value.error)}` : ""}`;
          break;
        }
        const event = step.value;
        if (event.type === "text_delta") {
          text += event.delta;
          if (args.outputFormat === "stream-json" && args.includePartialMessages)
            json({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: event.delta },
              },
              session_id: context.sessionId,
              uuid: randomUUID(),
            });
        }
        if (event.type === "error") error = String(event.error);
        if (event.type === "aborted") error = event.reason;
        if (event.type === "done") {
          turns = event.turns;
          if (event.finishReason !== "end_turn") error = event.message || event.finishReason;
        }
        if (event.type === "usage") {
          if (price)
            estimatedCost +=
              (event.usage.input_tokens * price.input + event.usage.output_tokens * price.output) /
              1e6;
          usage.input_tokens += event.usage.input_tokens;
          usage.output_tokens += event.usage.output_tokens;
        }
        if (args.outputFormat === "stream-json" && event.type === "tool_use")
          json({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: event.id, name: event.name, input: event.input }],
            },
            session_id: context.sessionId,
            uuid: randomUUID(),
          });
        if (args.outputFormat === "stream-json" && event.type === "tool_result")
          json({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: event.id,
                  content: event.result.formatted,
                  is_error: event.result.isError,
                },
              ],
            },
            session_id: context.sessionId,
            uuid: randomUUID(),
          });
      }
    } catch (failure) {
      error = String(failure);
    }
    const final = deps.messages
      .filter((entry) => !inheritedMessages.has(entry))
      .reverse()
      .find((entry) => entry.role === "assistant" && typeof entry.content === "string");
    if (final?.role === "assistant" && typeof final.content === "string") text = final.content;
    let structured: unknown;
    if (validator && !error) {
      try {
        structured = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        if (!validator(structured))
          error = `Structured output invalid: ${JSON.stringify(validator.errors)}`;
      } catch (failure) {
        error = `Structured output invalid: ${String(failure)}`;
      }
    }
    if (!args.noSessionPersistence) await deps.save(deps.messages);
    const result = {
      type: "result",
      subtype: error ? "error_during_execution" : "success",
      is_error: !!error,
      result: text,
      ...(error && { errors: [error] }),
      ...(structured !== undefined && !error && { structured_output: structured }),
      session_id: context.sessionId,
      duration_ms: Date.now() - started,
      num_turns: turns,
      usage,
      ...(sessionGoal(context.sessionId) && { goal_state: sessionGoal(context.sessionId) }),
      total_cost_usd: args.maxBudgetUsd ? spent() : price ? estimatedCost : null,
      uuid: randomUUID(),
    };
    if (args.outputFormat === "stream-json")
      json({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
        session_id: context.sessionId,
        uuid: randomUUID(),
      });
    if (args.outputFormat === "text") deps.emit(`${text}${text ? "\n" : ""}`);
    else json(result);
    if (error) process.exitCode = 1;
  }
}
