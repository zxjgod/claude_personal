import { expect, it } from "vitest";
import { agentLoop } from "../agent-loop.js";
import { sessionGoal, setSessionGoal } from "../goal-runtime.js";
import type { Message, ModelCaller } from "../types.js";

it("continues until an independent evaluator confirms the objective", async () => {
  const sid = "goal-fixture";
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "finish" }] }];
  let turns = 0;
  let evaluations = 0;
  const caller: ModelCaller = async function* () {
    turns++;
    yield { type: "text_delta", delta: "working" };
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
  };
  const evaluator: ModelCaller = async function* () {
    evaluations++;
    yield {
      type: "text_delta",
      delta: JSON.stringify({ complete: evaluations === 2, reason: "Check the result" }),
    };
  };
  setSessionGoal(sid, "finish fixture");
  for await (const _event of agentLoop(
    messages,
    [],
    caller,
    { provider: "custom", model: "fixture", apiKey: "unused" },
    {
      systemPrompt: "",
      maxTurns: 4,
      toolContext: { sessionId: sid },
      fastModel: {
        callModel: evaluator,
        modelConfig: { provider: "custom", model: "evaluator", apiKey: "unused" },
      },
    },
  )) {
    /* drain */
  }
  expect(turns).toBe(2);
  expect(sessionGoal(sid)?.complete).toBe(true);
  setSessionGoal(sid, "");
});
