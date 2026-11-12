import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { agentLoop } from "../agent-loop.js";
import { parseCliArgs } from "../cli-args.js";
import { runHeadless } from "../headless.js";
import { consumeSubagentLoop } from "../subagent-outcome.js";
import { WriteTool } from "../tools/core/write.js";
import { deriveSubContext, type Message, type ModelCaller, type Tool } from "../types.js";
import { createSubAgentApprover } from "../utils/subagent-security.js";

function caller(name: string, input: Record<string, unknown>): ModelCaller {
  let calls = 0;
  return async function* () {
    if (calls++ === 0) {
      yield {
        type: "tool_use",
        id: `call-${name}`,
        name,
        input,
        rawArguments: JSON.stringify(input),
      };
      yield {
        type: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: "tool_calls",
      };
    } else {
      yield { type: "text_delta", delta: "finished" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    }
  };
}
it.each([
  false,
  true,
])("rechecks delegated rewritten input against child deny rules, blocked=%s", async (blocked) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-headless-child-policy-"));
  const childRoot = path.join(root, "child");
  fs.mkdirSync(childRoot);
  const original = path.join(childRoot, "original.txt");
  const rewritten = path.join(childRoot, blocked ? "blocked.txt" : "approved.txt");
  const config = { provider: "custom" as const, model: "fixture", apiKey: "unused" };
  let childError = false;
  const delegate: Tool = {
    name: "delegate_write",
    description: "delegate",
    promptDescription: "delegate",
    inputSchema: { type: "object", properties: {}, required: [] },
    isEnabled: () => true,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    requiresApproval: () => false,
    checkPermissions: async () => ({ allowed: true }),
    formatResult: (result) => result.content,
    call: async (_input, context) => {
      const askUser = createSubAgentApprover(createSubAgentApprover(context.askUser));
      const child = deriveSubContext(context, {
        workspaceRoot: childRoot,
        askUser,
        abortSignal: context.abortSignal,
      });
      child.permissionPolicy = { allow: [], ask: [], deny: ["Write(blocked.txt)"] };
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "write" }] }];
      await consumeSubagentLoop(
        agentLoop(
          messages,
          [WriteTool],
          caller("write", { filePath: original, content: "original" }),
          config,
          {
            systemPrompt: "",
            maxTurns: 2,
            toolContext: child,
            askUser,
          },
        ),
        (event) => {
          if (event.type === "tool_result") childError = event.result.isError === true;
        },
      );
      return { content: "worker finished" };
    },
  };
  const input = new PassThrough();
  let approvals = 0;
  try {
    const run = runHeadless({
      args: parseCliArgs([
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
      ]),
      input,
      messages: [],
      config,
      tools: [delegate],
      callModel: caller("delegate_write", {}),
      systemPrompt: "",
      save: async () => {},
      context: {
        workspaceRoot: root,
        sessionId: `child-policy-${path.basename(root)}`,
        permissionMode: "default",
      },
      emit: (line) => {
        const frame = JSON.parse(line);
        if (frame.type === "control_request") {
          approvals++;
          input.write(
            `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { behavior: "allow", updatedInput: { filePath: rewritten, content: "approved" } } } })}\n`,
          );
        }
        if (frame.type === "result") input.end();
      },
    });
    input.write(`${JSON.stringify({ type: "user", content: "delegate" })}\n`);
    await run;
    expect(approvals).toBe(1);
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.existsSync(rewritten)).toBe(!blocked);
    expect(childError).toBe(blocked);
  } finally {
    input.end();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
