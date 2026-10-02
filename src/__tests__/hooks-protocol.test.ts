import * as http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { agentLoop } from "../agent-loop.js";
import { HookRegistry } from "../hooks.js";
import {
  configureHookServices,
  parseHooksConfig,
  registerHooksFromConfig,
} from "../hooks-config.js";
import { executeSingleTool } from "../tool-executor.js";
import { buildTool } from "../tools/registry.js";

afterEach(() => configureHookServices({}));
it("checks hard tool policy again after PermissionRequest rewrites input", async () => {
  const execute = vi.fn(async () => ({ content: "executed" }));
  const tool = buildTool({
    name: "fixture_write",
    description: "fixture",
    promptDescription: "fixture",
    schema: z.strictObject({ value: z.string() }),
    isReadOnly: false,
    call: execute,
    checkPermissions: async (input) => ({
      allowed: input.value !== "forbidden",
      reason: "hard policy",
    }),
  });
  const hooks = {
    runPre: async () => ({}),
    runPost: async () => ({}),
    runEvent: async () => ({ permissionDecision: "allow" as const, input: { value: "forbidden" } }),
  };
  const result = await executeSingleTool(
    {
      id: "fixture",
      type: "function",
      function: { name: tool.name, arguments: '{"value":"allowed"}' },
    },
    [tool],
    { workspaceRoot: process.cwd(), sessionId: "hook-rewrite", permissionMode: "default", hooks },
    async () => true,
  );
  expect(result.isError).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});
it("HTTP PreToolUse rewrites inputs, requests approval, and preserves extra context", async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "ask",
          updatedInput: { value: "new" },
          additionalContext: "review this",
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const hooks = new HookRegistry();
    const address = server.address() as { port: number };
    registerHooksFromConfig(
      hooks,
      parseHooksConfig({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "http", url: `http://127.0.0.1:${address.port}` }] }],
        },
      }),
    );
    expect(await hooks.runPre({ toolName: "read", input: { value: "old" } })).toMatchObject({
      permissionDecision: "ask",
      input: { value: "new" },
      additionalContext: "review this",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("model hook blocks a prompt before any model invocation", async () => {
  configureHookServices({ evaluate: async () => ({ ok: false, reason: "prompt rejected" }) });
  const hooks = new HookRegistry();
  registerHooksFromConfig(
    hooks,
    parseHooksConfig({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "prompt", prompt: "check input" }] }] },
    }),
  );
  const caller = vi.fn(async function* () {
    yield { type: "text_delta" as const, delta: "unexpected" };
  });
  const events = [];
  for await (const event of agentLoop(
    [{ role: "user", content: [{ type: "text", text: "blocked" }] }],
    [],
    caller,
    { provider: "custom", model: "fixture", apiKey: "unused" },
    { systemPrompt: "", hooks },
  ))
    events.push(event);
  expect(caller).not.toHaveBeenCalled();
  expect(events).toContainEqual({ type: "aborted", reason: "prompt rejected" });
});
it("MCP hook expands the input fields and lifecycle context propagates", async () => {
  const call = vi.fn(async () => ({ hookSpecificOutput: { additionalContext: "context" } }));
  configureHookServices({ callMcpTool: call });
  const hooks = new HookRegistry();
  registerHooksFromConfig(
    hooks,
    parseHooksConfig({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "mcp_tool",
                server: "fixture",
                tool: "check",
                input: { file: "${tool_input.file_path}" },
              },
            ],
          },
        ],
      },
    }),
  );
  expect(
    await hooks.runEvent("SessionStart", { tool_input: { file_path: "fixture.ts" } }),
  ).toMatchObject({ additionalContext: "context" });
  expect(call).toHaveBeenCalledWith("mcp__fixture__check", { file: "fixture.ts" });
});
