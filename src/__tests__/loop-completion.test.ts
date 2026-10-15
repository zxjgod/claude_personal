import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateLoopCompletion } from "../loop-completion.js";
import { withLoopExecution } from "../loop-execution-context.js";
import {
  beginLoopRound,
  type LoopScope,
  resetLoopsForTests,
  startLoop,
  takeDueLoop,
} from "../loop-runtime.js";
import { defaultLoopConfig, type LoopConfig } from "../loop-settings.js";
import { runLoopTurn } from "../loop-turn.js";
import { loopVerificationTools } from "../loop-verification-tools.js";
import { ReadTool } from "../tools/core/read.js";
import {
  listWakeupJobs,
  resetWakeupJobs,
  ScheduleWakeupTool,
} from "../tools/extended/schedule-wakeup.js";
import { createJob, settleJob } from "../tools/job-store.js";
import type { Message, ModelCaller, ModelConfig } from "../types.js";
import { makePdf } from "./fixtures/pdf.js";

let scope: LoopScope;
const config: ModelConfig = { provider: "openai", model: "test", apiKey: "test", maxTokens: 64 };
beforeEach(() => {
  scope = { workspaceRoot: mkdtempSync(join(tmpdir(), "ccr-loop-checks-")), sessionId: "verify" };
  resetLoopsForTests();
  resetWakeupJobs();
});
afterEach(() => {
  resetLoopsForTests();
  resetWakeupJobs();
  vi.restoreAllMocks();
  rmSync(scope.workspaceRoot, { recursive: true, force: true });
});
const evaluator: ModelCaller = async function* () {
  yield { type: "text_delta", delta: '{"complete":true,"reason":"The objective is verified."}' };
  yield { type: "done", usage: { input_tokens: 40, output_tokens: 10 }, finish_reason: "stop" };
};
function setup(partial: Partial<LoopConfig> = {}) {
  const record = startLoop(scope, "Finish the task", { ...defaultLoopConfig(), ...partial });
  const prompt = takeDueLoop(scope) ?? "";
  const controller = new AbortController();
  const ticket = beginLoopRound(scope, prompt, controller);
  if (!ticket) throw new Error("Missing ticket");
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: prompt }] },
    { role: "assistant", content: "Implemented and tested." },
  ];
  return { record, ticket, controller, messages };
}

describe("loop completion", () => {
  it("checks commands and files before declaring a checks-only task complete", async () => {
    const { ticket, controller, messages } = setup({
      completion: "checks",
      commands: ["npm test"],
      files: ["result.txt"],
    });
    writeFileSync(join(scope.workspaceRoot, "result.txt"), "done");
    const runCheck = vi.fn(async (name: string) => ({
      name,
      passed: true,
      output: "Tests passed",
    }));
    const callModel = vi.fn(evaluator);
    const result = await evaluateLoopCompletion(ticket, {
      messages,
      modelConfig: config,
      callModel,
      signal: controller.signal,
      runCheck,
    });
    expect(result.complete).toBe(true);
    expect(result.evidenceHash).not.toBe("");
    expect(runCheck).toHaveBeenCalledWith("npm test");
    expect(callModel).not.toHaveBeenCalled();
  });
  it("keeps failing test output for the next iteration rather than marking completion", async () => {
    const { ticket, controller, messages } = setup({
      completion: "hybrid",
      commands: ["npm test"],
    });
    const callModel = vi.fn(evaluator);
    const result = await evaluateLoopCompletion(ticket, {
      messages,
      modelConfig: config,
      callModel,
      signal: controller.signal,
      runCheck: async (name) => ({ name, passed: false, output: "Expected 2, received 1" }),
    });
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("Expected 2, received 1");
    expect(callModel).not.toHaveBeenCalled();
  });
  it("requires an independent model verdict and accounts its tokens", async () => {
    const { ticket, controller, messages, record } = setup();
    const result = await evaluateLoopCompletion(ticket, {
      messages,
      modelConfig: config,
      callModel: evaluator,
      signal: controller.signal,
      runCheck: vi.fn(),
    });
    expect(result.complete).toBe(true);
    expect(record.inputTokens).toBe(40);
    expect(record.outputTokens).toBe(10);
  });
  it("does not accept an invalid completion verdict", async () => {
    const { ticket, controller, messages } = setup();
    const invalid: ModelCaller = async function* () {
      yield { type: "text_delta", delta: "all done" };
    };
    await expect(
      evaluateLoopCompletion(ticket, {
        messages,
        modelConfig: config,
        callModel: invalid,
        signal: controller.signal,
        runCheck: vi.fn(),
      }),
    ).rejects.toThrow();
  });
  it("scheduled mode continues after healthy checks and detects structured changes", async () => {
    const { ticket, controller, messages } = setup({
      ...defaultLoopConfig("scheduled"),
      commands: ["check status"],
    });
    const deps = {
      messages,
      modelConfig: config,
      callModel: vi.fn(evaluator),
      signal: controller.signal,
      runCheck: async (name: string) => ({ name, passed: true, output: "green" }),
    };
    const first = await evaluateLoopCompletion(ticket, deps);
    const same = await evaluateLoopCompletion(ticket, deps);
    const changed = await evaluateLoopCompletion(ticket, {
      ...deps,
      runCheck: async (name) => ({ name, passed: false, output: "red" }),
    });
    expect(first.complete).toBe(false);
    expect(first.evidenceHash).toBe(same.evidenceHash);
    expect(changed.evidenceHash).not.toBe(first.evidenceHash);
    expect(deps.callModel).not.toHaveBeenCalled();
  });
  it("refuses completion file conditions outside the workspace", async () => {
    const { ticket, controller, messages } = setup({
      completion: "checks",
      files: ["../outside.txt"],
    });
    await expect(
      evaluateLoopCompletion(ticket, {
        messages,
        modelConfig: config,
        callModel: evaluator,
        signal: controller.signal,
        runCheck: vi.fn(),
      }),
    ).rejects.toThrow("Access denied");
  });
  it("waits for background agents instead of claiming early completion", async () => {
    const { ticket, controller, messages } = setup();
    const job = createJob(scope.sessionId, { kind: "agent", command: "background" });
    try {
      const callModel = vi.fn(evaluator);
      const result = await evaluateLoopCompletion(ticket, {
        messages,
        modelConfig: config,
        callModel,
        signal: controller.signal,
        runCheck: vi.fn(),
      });
      expect(result.complete).toBe(false);
      expect(result.reason).toContain("background agents");
      expect(callModel).not.toHaveBeenCalled();
    } finally {
      settleJob(job, "done", 0);
    }
  });
  it("ScheduleWakeup inside a managed loop records suggestions without creating another timer", async () => {
    const { ticket, controller, record } = setup();
    await withLoopExecution(ticket, async () => {
      const context = {
        ...scope,
        permissionMode: "default" as const,
        modelConfig: config,
        abortSignal: controller.signal,
      };
      await ScheduleWakeupTool.call(
        { delaySeconds: 900, prompt: "continue", reason: "waiting" },
        context,
      );
      await ScheduleWakeupTool.call({ stop: true }, context);
    });
    expect(record.suggestedMinutes).toBe(15);
    expect(record.completionRequested).toBe(true);
    expect(record.status).toBe("running");
    expect(listWakeupJobs()).toEqual([]);
  });
});

describe("managed turn orchestration", () => {
  it("injects the wrap-up prompt into the final work round and then verifies completion", async () => {
    const record = startLoop(scope, "Finish", {
      ...defaultLoopConfig("conservative"),
      maxRounds: 1,
    });
    const prompt = takeDueLoop(scope) ?? "";
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }] }];
    const execute = vi.fn(async (_ticket, instruction: string) => {
      expect(instruction).toContain("FINAL WRAP-UP ROUND");
      return { completed: true };
    });
    await runLoopTurn(scope, new AbortController(), {
      messages,
      callModel: evaluator,
      modelConfig: config,
      execute,
      runCheck: vi.fn(),
      notice: vi.fn(),
    });
    expect(record.status).toBe("completed");
    expect(record.rounds).toBe(1);
  });
  it("drops a stopped iteration before making any model call", async () => {
    const record = startLoop(scope, "Finish");
    const prompt = takeDueLoop(scope) ?? "";
    pauseLoopLocally();
    const execute = vi.fn(async () => ({ completed: true }));
    await runLoopTurn(scope, new AbortController(), {
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      callModel: evaluator,
      modelConfig: config,
      execute,
      runCheck: vi.fn(),
      notice: vi.fn(),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(record.status).toBe("paused");
    function pauseLoopLocally() {
      record.status = "paused";
      record.deliveryPending = false;
    }
  });
  it("verifies PDF and image completion files even under text-only models (F1)", async () => {
    const pdfPath = join(scope.workspaceRoot, "report.pdf");
    const pngPath = join(scope.workspaceRoot, "chart.png");
    writeFileSync(pdfPath, makePdf(1));
    writeFileSync(
      pngPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const tools = loopVerificationTools(
      [ReadTool],
      {
        ...scope,
        permissionMode: "default",
        modelConfig: { provider: "deepseek", model: "deepseek-chat", apiKey: "test" },
      },
      async () => true,
    );
    const pdfCheck = await tools.runFileCheck(pdfPath);
    const pngCheck = await tools.runFileCheck(pngPath);
    expect(pdfCheck.passed).toBe(true);
    expect(pdfCheck.output).toMatch(/^[0-9a-f]{64}$/);
    expect(pngCheck.passed).toBe(true);
    expect(pngCheck.output).toMatch(/^[0-9a-f]{64}$/);
  });
});
