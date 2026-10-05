import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { agentLoop } from "../agent-loop.js";
import { agentMemoryFile } from "../agent-memory.js";
import { parseCliArgs } from "../cli-args.js";
import { createResumeSession } from "../cli-session.js";
import {
  getCustomCommands,
  loadCommandsDir,
  resetCustomCommands,
} from "../commands/loadCommandsDir.js";
import { evaluateSessionGoal, sessionGoal, setSessionGoal } from "../goal-runtime.js";
import { headlessInputs, runHeadless } from "../headless.js";
import { HookRegistry } from "../hooks.js";
import {
  confirmProjectLspConfig,
  disposeLanguageServers,
  LanguageServer,
  languageServerFor,
} from "../language-servers.js";
import { LspClient } from "../lsp.js";
import { MCPManager } from "../mcp/index.js";
import { setMemoryApproval } from "../memory-approval.js";
import { MemoryStore } from "../memory-extract.js";
import { permissionRuleMatches, policyDecision } from "../permission-policy.js";
import { isBlockedPath } from "../permissions.js";
import { validatePluginManifest } from "../plugins.js";
import { restoreSessionRuntime, saveSessionRuntime } from "../session-runtime.js";
import { estimateTokens } from "../token-estimator.js";
import { executeSingleTool } from "../tool-executor.js";
import { ExitPlanModeTool } from "../tools/breadth/interactive.js";
import { AgentTool } from "../tools/extended/agent.js";
import {
  collectDueCronJobs,
  listScheduledJobs,
  registerScheduledJob,
  resetScheduledJobs,
} from "../tools/extended/cron-shared.js";
import { MemorySaveTool } from "../tools/extended/memory-save.js";
import { buildTool } from "../tools/registry.js";
import { resolveInWorkspace } from "../tools/utils/path.js";
import type { Message, ModelCaller, ToolContext } from "../types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-claim-check-"));
  vi.stubEnv("CCR_USER_CONFIG_DIR", path.join(root, "user"));
});
afterEach(async () => {
  await disposeLanguageServers();
  setSessionGoal("review-goal", "");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(root, { recursive: true, force: true });
});
const config = { provider: "custom" as const, model: "fixture", apiKey: "unused" };
function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: root,
    sessionId: "review-goal",
    permissionMode: "default",
    modelConfig: config,
    ...extra,
  };
}
async function drain(iterator: AsyncGenerator<any, any>) {
  const events = [];
  while (true) {
    const step = await iterator.next();
    if (step.done) return { events, terminal: step.value };
    events.push(step.value);
  }
}

it("#1 disproves persistent allow/deny: consecutive executor calls leave parent policy unchanged", async () => {
  const call = vi.fn(async () => ({ content: "safe simulated write" }));
  const tool = buildTool({
    name: "review_write",
    schema: z.strictObject({ value: z.string() }),
    description: "fixture",
    promptDescription: "fixture",
    isReadOnly: false,
    call,
  });
  const context = ctx({ permissionPolicy: { allow: [], ask: [], deny: [] } });
  const request = {
    id: "fixture",
    type: "function" as const,
    function: { name: tool.name, arguments: '{"value":"first"}' },
  };
  const once = {
    runPre: async () => ({ permissionDecision: "allow" as const }),
    runPost: async () => ({}),
  };
  expect((await executeSingleTool(request, [tool], context, async () => false, once)).isError).toBe(
    false,
  );
  expect((await executeSingleTool(request, [tool], context, async () => false)).isError).toBe(true);
  const deny = { ...once, runPre: async () => ({ permissionDecision: "deny" as const }) };
  expect((await executeSingleTool(request, [tool], context, async () => true, deny)).isError).toBe(
    true,
  );
  expect((await executeSingleTool(request, [tool], context, async () => true)).isError).toBe(false);
  expect(context.permissionPolicy).toEqual({ allow: [], ask: [], deny: [] });
  expect(call).toHaveBeenCalledTimes(2);
});
it("host deny rules handle userinfo, casing and default ports", () => {
  expect(
    permissionRuleMatches("WebFetch(evil.com:*)", "webfetch", { url: "https://evil.com/x" }),
  ).toBe(true);
  for (const url of ["https://attacker@evil.com/x", "HTTPS://EVIL.COM/x", "https://evil.com:443/x"])
    expect(
      policyDecision({ deny: ["WebFetch(evil.com:*)"], allow: [], ask: [] }, "webfetch", { url }),
    ).toBe("deny");
});
it("project LSP refuses untrusted config and starts only after explicit trust", async () => {
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(path.join(root, "fixture.py"), "pass");
  const marker = path.join(root, "spawn-marker");
  const script = path.join(root, "server.mjs");
  fs.writeFileSync(
    script,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'started'); ${fs.readFileSync("src/__tests__/fixtures/mock-lsp-server.mjs", "utf8")}`,
  );
  fs.writeFileSync(
    path.join(root, ".claude", "lsp.json"),
    JSON.stringify({
      fixture: {
        command: process.execPath,
        args: [script],
        extensionToLanguage: { ".py": "python" },
      },
    }),
  );
  expect(await languageServerFor(root, "fixture.py")).toBeUndefined();
  expect(fs.existsSync(marker)).toBe(false);
  await confirmProjectLspConfig(root, async () => true);
  expect(await languageServerFor(root, "fixture.py")).toBeDefined();
  expect(fs.readFileSync(marker, "utf8")).toBe("started");
});

it("gate ON: user memory requires approval and scope storage/output are consistent", async () => {
  // The gate defaults OFF (user decision 2026-10-04); this test covers the
  // strict (T2) posture, so enable it explicitly.
  setMemoryApproval(true);
  try {
    const approval = vi.fn(async () => false);
    const result = await executeSingleTool(
      {
        id: "fixture",
        type: "function",
        function: {
          name: "MemorySave",
          arguments:
            '{"content":"Harmless review fixture","scope":"user","agent_type":"review-agent"}',
        },
      },
      [MemorySaveTool],
      ctx(),
      approval,
    );
    expect(result.isError).toBe(true);
    expect(new MemoryStore(root, "user").list()).toHaveLength(0);
    const approved = await MemorySaveTool.call(
      { content: "Harmless review fixture", scope: "user", agent_type: "review-agent" },
      ctx({ askUser: async () => true }),
    );
    expect(approved.content).toContain("user scope");
    expect(new MemoryStore(root, "user").list()).toHaveLength(1);
    await MemorySaveTool.call(
      { content: "Local review fixture", scope: "local", agent_type: "review-local" },
      ctx({ askUser: async () => true }),
    );
    expect(new MemoryStore(root).list()).toHaveLength(0);
    expect(new MemoryStore(root, "local").list()).toHaveLength(1);
    expect(fs.existsSync(agentMemoryFile("local", "review-local", root))).toBe(true);
  } finally {
    setMemoryApproval(false);
  }
});
it("#6 normal plan execution denies Agent before calling its implementation", async () => {
  const implementation = vi.spyOn(AgentTool, "call");
  const result = await executeSingleTool(
    {
      id: "fixture",
      type: "function",
      function: { name: "Agent", arguments: '{"prompt":"fixture","subagent_type":"general"}' },
    },
    [AgentTool],
    ctx({ permissionMode: "plan" }),
    async () => true,
  );
  expect(result.isError).toBe(true);
  expect(implementation).not.toHaveBeenCalled();
});
it("headless classifies the final terminal rather than a recoverable error", async () => {
  let messages: Message[] = [];
  for (let count = 400; count < 2000; count += 20) {
    messages = Array.from({ length: 25 }, (_, index) =>
      index % 2
        ? { role: "assistant", content: "x ".repeat(count) }
        : { role: "user", content: [{ type: "text", text: "x ".repeat(count) }] },
    );
    if (estimateTokens(messages) >= 7200) break;
  }
  expect(estimateTokens(messages)).toBeLessThan(8000);
  const caller: ModelCaller = async function* (_messages, _tools, prompt) {
    if (prompt.includes("summarizes conversations")) {
      yield { type: "error", error: new Error("fixture compaction failure") };
      return;
    }
    yield { type: "text_delta", delta: "success after recovery" };
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
  };
  const output: string[] = [];
  await runHeadless({
    args: parseCliArgs(["-p", "fixture", "--output-format", "json"]),
    input: new PassThrough(),
    emit: (value) => output.push(value),
    messages,
    tools: [],
    callModel: caller,
    config: { ...config, model: "gpt-4" },
    context: ctx(),
    systemPrompt: "task",
    save: async () => {},
  });
  expect(JSON.parse(output.at(-1)!)).toMatchObject({
    result: "success after recovery",
    is_error: false,
  });
});
it("plan exit cannot switch permission without a real approval channel", async () => {
  let mode = "plan";
  const context = ctx({
    permissionMode: "plan",
    getPermissionMode: () => mode as any,
    setPermissionMode: (value) => {
      mode = value;
    },
  });
  const request = {
    id: "fixture",
    type: "function" as const,
    function: { name: "exit_plan_mode", arguments: '{"plan":"fixture"}' },
  };
  await executeSingleTool(request, [ExitPlanModeTool], context, async () => false);
  expect(mode).toBe("plan");
  const headlessContext = ctx({ permissionMode: "plan" });
  await executeSingleTool(request, [ExitPlanModeTool], headlessContext, async () => false);
  expect(headlessContext.permissionMode).toBe("plan");
});
it("completed goals stay completed after restart", async () => {
  setSessionGoal("review-goal", "finish fixture");
  await evaluateSessionGoal(
    "review-goal",
    [],
    async function* () {
      yield { type: "text_delta", delta: '{"complete":true,"reason":"done"}' };
    },
    config,
  );
  expect(sessionGoal("review-goal")!.complete).toBe(true);
  saveSessionRuntime(root, "review-goal");
  setSessionGoal("review-goal", "");
  restoreSessionRuntime(root, "review-goal");
  expect(sessionGoal("review-goal")!.complete).toBe(true);
});
it("goal evaluator failure suspends automatic work and cancellation remains cancellation", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    setSessionGoal("review-goal", "fixture");
    const main: ModelCaller = async function* () {
      yield { type: "text_delta", delta: "done" };
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
    };
    const evaluator: ModelCaller = async function* () {
      if (cancel) {
        controller.abort();
        throw new Error("cancelled evaluator");
      }
      yield { type: "text_delta", delta: "not JSON" };
    };
    const result = await drain(
      agentLoop([], [], main, config, {
        systemPrompt: "",
        toolContext: ctx(),
        abortSignal: controller.signal,
        fastModel: { callModel: evaluator, modelConfig: config },
      }),
    );
    expect(
      cancel
        ? result.terminal.reason.startsWith("aborted_")
        : result.terminal.reason === "completed",
    ).toBe(true);
    if (!cancel) expect(sessionGoal("review-goal")?.suspended).toBe(true);
  }
});
it("resume refreshes the caller goal holder", async () => {
  setSessionGoal("review-goal", "New goal");
  saveSessionRuntime(root, "review-goal");
  setSessionGoal("review-goal", "");
  const session = { id: "old-session" };
  const holder = { value: "Old goal" };
  const messages: Message[] = [];
  const persistence = {
    workspaceRoot: root,
    searchSessions: async () => [{ sessionId: "review-goal" }],
    load: async () => ({
      sessionId: "review-goal",
      messages: [],
      updatedAt: new Date().toISOString(),
    }),
  };
  await createResumeSession({
    persistence: persistence as any,
    session,
    messages,
    onResume: () => {
      holder.value = sessionGoal(session.id)?.objective ?? "";
    },
  })("review-goal");
  expect(sessionGoal(session.id)?.objective).toBe("New goal");
  expect(holder.value).toBe("New goal");
});
it("resume does not consume the next option", () => {
  expect(parseCliArgs(["--resume", "--print"])).toMatchObject({
    resume: undefined,
    continue: true,
    print: true,
  });
});
it("malformed MCP shape is diagnosed and isolated before connection", async () => {
  const manager = new MCPManager();
  const file = path.join(root, "mcp.json");
  fs.writeFileSync(file, "{}");
  await expect(manager.loadConfig(file, { requireTrust: true })).resolves.toBeUndefined();
  await expect(manager.loadConfig(file)).resolves.toBeUndefined();
  expect(manager.serverCount).toBe(0);
});
it("TTY stream-json input is rejected with a clear diagnostic", async () => {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true });
  const iterator = headlessInputs(
    parseCliArgs(["-p", "first", "--input-format", "stream-json"]),
    input,
  );
  await expect(iterator.next()).rejects.toThrow("requires a pipe");
  input.end();
});
it("MCP definition changes invalidate the previous approval", async () => {
  const manager = new MCPManager();
  try {
    await manager.connectServer("review", {
      type: "stdio",
      command: process.execPath,
      args: [path.resolve("src/__tests__/fixtures/mock-mcp-stdio-server.mjs")],
    });
    const tool = manager.getAllTools().find((candidate) => candidate.name.endsWith("__echo"))!;
    const approval = vi.fn(async () => true);
    expect((await tool.checkPermissions({}, ctx({ askUser: approval }))).allowed).toBe(true);
    const entry = (manager as any).servers.get("review");
    vi.spyOn(entry.client, "listTools").mockResolvedValue({
      tools: [
        {
          name: "echo",
          description: "A changed destructive definition",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ],
    });
    await manager.refreshServerTools("review");
    const changed = manager.getAllTools()[0];
    expect((await changed.checkPermissions({}, ctx({ askUser: approval }))).allowed).toBe(true);
    expect(approval).toHaveBeenCalledTimes(2);
  } finally {
    await manager.disconnectAll();
  }
});
it("generic LSP initialization rejection is cleaned up and retried", async () => {
  const marker = path.join(root, "initialize-marker");
  const script = path.join(root, "rejecting-server.mjs");
  fs.writeFileSync(
    script,
    `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)},'launch\\n'); let b=Buffer.alloc(0); process.stdin.on('data',c=>{b=Buffer.concat([b,c]);const n=b.indexOf('\\r\\n\\r\\n');if(n<0)return;const l=Number(/Content-Length:\\s*(\\d+)/i.exec(b.subarray(0,n).toString())[1]);if(b.length<n+4+l)return;const q=JSON.parse(b.subarray(n+4,n+4+l));b=b.subarray(n+4+l);const s=JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32603,message:'fixture initialize rejection'}});process.stdout.write('Content-Length: '+Buffer.byteLength(s)+'\\r\\n\\r\\n'+s);});`,
  );
  const client = new LanguageServer(root, {
    command: process.execPath,
    args: [script],
    extensionToLanguage: { ".py": "python" },
  });
  try {
    await expect(client.start()).rejects.toThrow("fixture initialize rejection");
    await expect(client.start()).rejects.toThrow("fixture initialize rejection");
    expect(fs.readFileSync(marker, "utf8")).toBe("launch\nlaunch\n");
  } finally {
    await client.dispose();
  }
});
it("tsserver initialization exit is cleaned up and retried", async () => {
  const marker = path.join(root, "ts-marker");
  const script = path.join(root, "early-exit.mjs");
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'launch\\n');process.exit(1);`,
  );
  const client = new LspClient(root, script);
  try {
    await expect(client.ensureInitialized()).rejects.toThrow("before ready");
    await expect(client.ensureInitialized()).rejects.toThrow("before ready");
    expect(fs.readFileSync(marker, "utf8")).toBe("launch\nlaunch\n");
  } finally {
    await client.dispose();
  }
});
it("tsserver ready state is reset after exit and the next request respawns", async () => {
  const script = path.join(root, "ready-exit.mjs");
  fs.writeFileSync(
    script,
    `let b=Buffer.alloc(0);process.stdin.on('data',c=>{b=Buffer.concat([b,c]);const n=b.indexOf('\\r\\n\\r\\n');if(n<0)return;const l=Number(/Content-Length:\\s*(\\d+)/i.exec(b.subarray(0,n).toString())[1]);if(b.length<n+4+l)return;const q=JSON.parse(b.subarray(n+4,n+4+l));const s=JSON.stringify({seq:1,type:'response',request_seq:q.seq,command:q.command,success:true,body:{}});process.stdout.write('Content-Length: '+(Buffer.byteLength(s)+1)+'\\r\\n\\r\\n'+s+'\\n');setTimeout(()=>process.exit(0),25);});`,
  );
  const client = new LspClient(root, script);
  try {
    await client.ensureInitialized();
    const child = (client as any).proc;
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
    expect((client as any).ready).toBe(false);
    await client.ensureInitialized();
    expect((client as any).proc).not.toBe(child);
  } finally {
    await client.dispose();
  }
});
it("MCP permission fallback without a caller approval channel is deny", async () => {
  const manager = new MCPManager();
  try {
    await manager.connectServer("review-fallback", {
      type: "stdio",
      command: process.execPath,
      args: [path.resolve("src/__tests__/fixtures/mock-mcp-stdio-server.mjs")],
    });
    const tools = manager.getAllTools();
    expect((await tools[0].checkPermissions({}, ctx())).allowed).toBe(false);
    expect((await tools[1].checkPermissions({}, ctx({ askUser: async () => false }))).allowed).toBe(
      false,
    );
  } finally {
    await manager.disconnectAll();
  }
});
it("duplicate nested command registrations have deterministic precedence and diagnostics", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetCustomCommands();
  for (const name of ["a", "b"]) {
    const directory = path.join(root, ".claude", "commands", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "fixture.md"), name);
  }
  expect(loadCommandsDir(root)).toEqual(["fixture", "fixture"]);
  expect(getCustomCommands().get("fixture")).toBeDefined();
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("Duplicate extension name fixture"));
  resetCustomCommands();
});
it("owned cron stays isolated and ownerless cron is never adopted", () => {
  resetScheduledJobs();
  registerScheduledJob({
    cron: "* * * * *",
    prompt: "old",
    recurring: true,
    durable: false,
    workspaceRoot: root,
    sessionId: "old-session",
  });
  registerScheduledJob({
    cron: "* * * * *",
    prompt: "ownerless",
    recurring: true,
    durable: false,
    workspaceRoot: root,
  });
  const jobs = collectDueCronJobs(new Date(), { workspaceRoot: root, sessionId: "new-session" });
  expect(jobs).toHaveLength(0);
  expect(listScheduledJobs()).toHaveLength(2);
  resetScheduledJobs();
});
it("invalid max-turns is reported instead of silently changing the loop bound", async () => {
  expect(() => parseCliArgs(["--max-turns", "abc"])).toThrow("positive integer");
});
it("empty numeric limits are rejected and explicit URL ports remain restrictive", () => {
  expect(() => parseCliArgs(["--max-turns="])).toThrow("requires a value");
  expect(() => parseCliArgs(["--max-budget-usd="])).toThrow("requires a value");
  expect(
    permissionRuleMatches("WebFetch(evil.com:443:*)", "webfetch", { url: "https://EVIL.COM/x" }),
  ).toBe(true);
  expect(
    permissionRuleMatches("WebFetch(evil.com:443:*)", "webfetch", {
      url: "https://evil.com:444/x",
    }),
  ).toBe(false);
  expect(
    permissionRuleMatches("WebFetch(evil.com:*)", "webfetch", { url: "https://evil.com./x" }),
  ).toBe(true);
  expect(
    permissionRuleMatches("WebFetch(evil.com/private:*)", "webfetch", {
      url: "https://evil.com/public",
    }),
  ).toBe(false);
});
it("official WebFetch spelling denies real web_fetch URLs including normalized absolute patterns", () => {
  for (const rule of [
    "WebFetch(evil.com:*)",
    "WebFetch(https://evil.com:*)",
    "WebFetch(https://evil.com/*)",
  ]) {
    expect(
      policyDecision({ allow: [], ask: [], deny: [rule] }, "web_fetch", {
        url: "HTTPS://user@EVIL.COM.:443/x",
      }),
    ).toBe("deny");
  }
  expect(
    permissionRuleMatches("WebFetch(https://evil.com/private:*)", "web_fetch", {
      url: "https://evil.com/private-other",
    }),
  ).toBe(false);
  expect(
    permissionRuleMatches("WebFetch(https://evil.com/private:*)", "web_fetch", {
      url: "https://evil.com/private/child",
    }),
  ).toBe(true);
});
it("model file tools cannot rewrite executable trust stores", () => {
  expect(
    isBlockedPath(path.join(root, ".claude-code-replica", "trusted-executable-configs.json")),
  ).toBe(true);
  expect(isBlockedPath(path.join(root, "custom-user", "trusted-executable-configs.json"))).toBe(
    true,
  );
});
it("plugin server paths are validated and legal YAML separators remain supported", () => {
  expect(() =>
    validatePluginManifest({
      name: "fixture",
      version: "1.0.0",
      mcpServers: "../../outside.json",
      lspServers: "C:/outside.json",
    }),
  ).toThrow();
  const parsed = parseFrontmatter("---\ndescription: |\n  first\n  ---\n  last\n---\nbody");
  expect(parsed.frontmatter.description).toContain("---");
  expect(parsed.body).toBe("body");
});
it("programmatic hook deny cannot be overwritten by a later allow", async () => {
  const hooks = new HookRegistry();
  hooks.register({ matcher: "*", pre: async () => ({ permissionDecision: "deny" }) });
  hooks.register({ matcher: "*", pre: async () => ({ permissionDecision: "allow" }) });
  expect((await hooks.runPre({ toolName: "read", input: {} })).block).toBe(true);
});
it("allowed junctions and filesystem roots contain their descendants correctly", () => {
  const target = path.join(root, "target");
  const workspace = path.join(root, "workspace");
  const alias = path.join(root, "alias");
  fs.mkdirSync(target);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(target, "fixture.txt"), "fixture");
  fs.symlinkSync(target, alias, "junction");
  expect(resolveInWorkspace(path.join(alias, "fixture.txt"), workspace, [alias]).ok).toBe(true);
  expect(resolveInWorkspace(path.join(workspace, "fixture.txt"), path.parse(root).root).ok).toBe(
    true,
  );
});
