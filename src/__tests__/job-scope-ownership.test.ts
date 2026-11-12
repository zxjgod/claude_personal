import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionIdentity } from "../cli-session.js";
import { saveBackgroundJobRuntime, saveSessionRuntime } from "../session-runtime.js";
import { runForkSkill } from "../skills/forkSkill.js";
import { registerSubagentType, setCoreToolsForSubagents } from "../subagents.js";
import { createAgents, resetTeams } from "../team.js";
import { SendMessageTool } from "../tools/breadth/team.js";
import { BashTool } from "../tools/core/bash.js";
import { AgentTool } from "../tools/extended/agent.js";
import { JobKillTool, JobListTool, JobOutputTool } from "../tools/extended/jobs.js";
import { TaskTool } from "../tools/extended/task.js";
import {
  clearJobs,
  createJob,
  getJob,
  killOwnedSessionJobs,
  killRunningJobs,
  settleJob,
} from "../tools/job-store.js";
import { resetNotifications } from "../tools/notifications.js";
import {
  deriveSubContext,
  type Message,
  type ModelConfig,
  type ToolContext,
  type ToolResult,
} from "../types.js";
import { runWorkerAgent } from "../workflow.js";

const state = vi.hoisted(() => ({ command: "", collectJobId: "" }));
vi.mock("../llm-adapter.js", () => ({
  createModelCaller: () =>
    async function* (messages: Message[]) {
      if (state.collectJobId) {
        const collected = messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "collect-job",
        );
        if (!collected) {
          yield {
            type: "tool_use",
            id: "collect-job",
            name: "job_output",
            input: { job_id: state.collectJobId },
          };
          yield {
            type: "done",
            usage: { input_tokens: 1, output_tokens: 1 },
            finish_reason: "tool_calls",
          };
        } else {
          yield { type: "text_delta", delta: `collected: ${JSON.stringify(collected.content)}` };
          yield {
            type: "done",
            usage: { input_tokens: 1, output_tokens: 1 },
            finish_reason: "stop",
          };
        }
        return;
      }
      const result = messages.find((message) => message.role === "tool");
      if (!result) {
        yield {
          type: "tool_use",
          id: "start-background",
          name: "bash",
          input: {
            command: state.command,
            description: "worker background job",
            run_in_background: true,
          },
        };
        yield {
          type: "done",
          usage: { input_tokens: 1, output_tokens: 1 },
          finish_reason: "tool_calls",
        };
      } else {
        const id = JSON.stringify(result.content).match(/job-\d+/)?.[0];
        yield { type: "text_delta", delta: `worker launched ${id ?? "missing job handle"}` };
        yield { type: "done", usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "stop" };
      }
    },
}));

let root: string;
let context: ToolContext & { modelConfig: ModelConfig };
let observed: ToolContext[];
const roles = ["parent", "child", "grandchild"];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quote = (value: string) =>
  process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
function pids() {
  return roles.flatMap((role) => {
    const file = path.join(root, `${role}.pid`);
    return fs.existsSync(file) ? [Number(fs.readFileSync(file, "utf8"))] : [];
  });
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux" && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")))
      return false;
    return true;
  } catch {
    return false;
  }
}
async function ready() {
  const deadline = Date.now() + 5000;
  while (
    pids().length < 3 ||
    !roles.every((role) => fs.existsSync(path.join(root, `${role}.beat`)))
  ) {
    if (Date.now() > deadline) throw new Error("worker process tree did not start");
    await delay(20);
  }
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-job-scope-"));
  context = {
    workspaceRoot: root,
    sessionId: `owner-${path.basename(root)}`,
    permissionMode: "bypassPermissions",
    modelConfig: { provider: "custom", model: "fixture", apiKey: "fixture-unused" },
  };
  observed = [];
  state.collectJobId = "";
  vi.stubEnv("CCR_USER_CONFIG_DIR", path.join(root, "user"));
  resetTeams();
  registerSubagentType({
    name: "owner-worker",
    description: "start background work",
    systemPrompt: "start one background task",
    toolNames: ["bash", "job_output"],
    maxTurns: 3,
    omitClaudeMd: true,
  });
  setCoreToolsForSubagents([
    {
      ...BashTool,
      call: async (input, ctx) => {
        observed.push(ctx);
        return BashTool.call(input, ctx);
      },
    },
    {
      ...JobOutputTool,
      call: async (input, ctx) => {
        observed.push(ctx);
        return JobOutputTool.call(input, ctx);
      },
    },
  ]);
  state.command = [
    process.execPath,
    path.resolve("src/__tests__/fixtures/job-tree.mjs"),
    root,
    "parent",
  ]
    .map(quote)
    .join(" ");
});
afterEach(async () => {
  for (const sessionId of new Set([context.sessionId, ...observed.map((ctx) => ctx.sessionId)]))
    await killRunningJobs(sessionId, "fixture cleanup");
  for (const pid of pids())
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  await delay(150);
  for (const sessionId of new Set([context.sessionId, ...observed.map((ctx) => ctx.sessionId)]))
    clearJobs(sessionId);
  resetTeams();
  resetNotifications();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const runners: Array<[string, (ctx: ToolContext) => Promise<ToolResult>]> = [
  [
    "Agent",
    (ctx) =>
      AgentTool.call({ prompt: "start background work", subagent_type: "owner-worker" }, ctx),
  ],
  [
    "Task",
    (ctx) =>
      TaskTool.call(
        { description: "start", prompt: "start background work", subagent_name: "owner-worker" },
        ctx,
      ),
  ],
  [
    "Team",
    async (ctx) => {
      createAgents(ctx.sessionId, [{ role: "owner-worker", name: "worker" }]);
      return SendMessageTool.call({ agent_id: "worker", message: "start background work" }, ctx);
    },
  ],
  ["Workflow", async (ctx) => ({ content: await runWorkerAgent("start background work", ctx) })],
  [
    "Fork Skill",
    (ctx) =>
      runForkSkill(
        {
          name: "owner-skill",
          description: "start",
          context: "fork",
          agent: "owner-worker",
          getPromptForCommand: async () => "start background work",
        },
        "start background work",
        ctx,
      ),
  ],
];

it.each(
  runners,
)("%s background jobs remain reachable by the owner and isolated from sibling workers", async (_kind, run) => {
  const result = await run(context);
  expect(result.error).toBeUndefined();
  const id = result.content.match(/job-\d+/)?.[0];
  if (!id) throw new Error(`worker returned no handle: ${result.content}`);
  await ready();
  const output = await JobOutputTool.call({ job_id: id }, context);
  expect(output.error).toBeUndefined();
  expect((await JobListTool.call({}, context)).content).toContain(id);
  const sibling = deriveSubContext(context);
  expect((await JobOutputTool.call({ job_id: id }, sibling)).error).toContain("Unknown job");
  expect((await JobKillTool.call({ job_id: id }, sibling)).error).toContain("Unknown job");
  expect(pids().every(alive)).toBe(true);
  const worker = observed[0];
  expect((await JobOutputTool.call({ job_id: id }, worker)).error).toBeUndefined();
  const parentOnly = createJob(context.sessionId, { kind: "agent", command: "parent private job" });
  settleJob(parentOnly, "done", 0);
  expect((await JobOutputTool.call({ job_id: parentOnly.id }, worker)).error).toContain(
    "Unknown job",
  );
  await killRunningJobs(context.sessionId, "owner exited");
  expect(pids().filter(alive)).toEqual([]);
  expect(getJob(context.sessionId, id)?.status).toBe("killed");
  saveSessionRuntime(root, context.sessionId);
  const saved = JSON.parse(
    fs.readFileSync(
      path.join(root, ".claude", "session-runtime", `${context.sessionId}.json`),
      "utf8",
    ),
  );
  expect(saved.backgroundJobs.find((job: { id: string }) => job.id === id)).toMatchObject({
    id,
    status: "killed",
  });
});

it("nested workers preserve ownership without gaining access to their parent's jobs", async () => {
  const child = deriveSubContext(context, { sessionId: "unrelated-looking-child-id" });
  const nested = deriveSubContext(child, { sessionId: "nested-id" });
  observed.push(nested);
  const result = await BashTool.call(
    { command: state.command, description: "nested", run_in_background: true },
    nested,
  );
  const id = String(result.metadata?.jobId);
  await ready();
  expect((await JobOutputTool.call({ job_id: id }, context)).error).toBeUndefined();
  expect((await JobOutputTool.call({ job_id: id }, child)).error).toBeUndefined();
  expect((await JobOutputTool.call({ job_id: id }, deriveSubContext(context))).error).toContain(
    "Unknown job",
  );
  await killRunningJobs(context.sessionId, "owner exited");
  expect(pids().filter(alive)).toEqual([]);
});

it.each([
  "Agent-Agent",
  "Task-Task",
  "Agent-Task",
  "Task-Agent",
  "Team-Team",
])("resumed worker keeps its own job scope, %s", async (route) => {
  const [start, resume] = route.split("-");
  let first: ToolResult;
  if (start === "Team") {
    createAgents(context.sessionId, [{ role: "owner-worker", name: "worker" }]);
    first = await SendMessageTool.call({ agent_id: "worker", message: "start" }, context);
  } else if (start === "Agent")
    first = await AgentTool.call({ prompt: "start", subagent_type: "owner-worker" }, context);
  else
    first = await TaskTool.call(
      { description: "start", prompt: "start", subagent_name: "owner-worker" },
      context,
    );
  expect(first.error).toBeUndefined();
  await ready();
  const id = first.content.match(/job-\d+/)?.[0];
  if (!id) throw new Error("missing original job handle");
  state.collectJobId = id;
  const agentId = first.metadata?.agentId;
  if (start !== "Team" && !agentId) throw new Error("missing resumable worker handle");
  const result =
    resume === "Team"
      ? await SendMessageTool.call({ agent_id: "worker", message: "collect" }, context)
      : resume === "Agent"
        ? await AgentTool.call({ prompt: "collect", resume: agentId }, context)
        : await TaskTool.call(
            { description: "collect", prompt: "collect", resume: agentId },
            context,
          );
  expect(result.error).toBeUndefined();
  expect(result.content).toContain("grandchild:diagnostic");
  expect(result.content).not.toContain("Unknown job");
  await killRunningJobs(context.sessionId, "owner exited");
  expect(pids().filter(alive)).toEqual([]);
});

it("CLI identity cleanup covers visited roots and leaves an unrelated lookalike root alone", async () => {
  const identity = createSessionIdentity(context.sessionId);
  const prior = createJob(identity.id, { kind: "agent", command: "prior session" });
  prior.kill = () => settleJob(prior, "killed", null);
  const original = identity.id;
  identity.id = "visited-target";
  const next = createJob(identity.id, { kind: "agent", command: "visited session" });
  next.kill = () => settleJob(next, "killed", null);
  const otherId = `${original}-agent-unrelated`;
  const other = createJob(otherId, { kind: "agent", command: "other host session" });
  other.kill = vi.fn(() => settleJob(other, "killed", null));
  try {
    expect(await killOwnedSessionJobs(identity.ownedIds)).toEqual([]);
    expect(prior.status).toBe("killed");
    expect(next.status).toBe("killed");
    expect(other.status).toBe("running");
    expect(other.kill).not.toHaveBeenCalled();
  } finally {
    settleJob(other, "done", 0);
    clearJobs(otherId);
    clearJobs("visited-target");
  }
});

it("background-only snapshot updates preserve inactive goals, queues and their original age", async () => {
  const job = createJob(context.sessionId, { kind: "agent", command: "saved work" });
  job.kill = () => settleJob(job, "killed", null);
  saveSessionRuntime(root, context.sessionId);
  const file = path.join(root, ".claude", "session-runtime", `${context.sessionId}.json`);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.goal = { objective: "inactive goal", complete: true, checks: 7 };
  saved.savedAt = Date.now() - 8 * 86400000;
  saved.queuedInputs = [{ prompt: "expired input" }];
  saved.tasks = [{ id: "saved-task", status: "pending" }];
  fs.writeFileSync(file, JSON.stringify(saved));
  await killRunningJobs(context.sessionId);
  saveBackgroundJobRuntime(root, context.sessionId);
  const updated = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(updated.goal).toEqual(saved.goal);
  expect(updated.savedAt).toBe(saved.savedAt);
  expect(updated.queuedInputs).toEqual(saved.queuedInputs);
  expect(updated.tasks).toEqual(saved.tasks);
  expect(updated.backgroundJobs).toMatchObject([{ status: "killed" }]);
});

it("background-only saves neither resurrect deleted snapshots nor overwrite corrupt state", () => {
  const file = path.join(root, ".claude", "session-runtime", `${context.sessionId}.json`);
  saveBackgroundJobRuntime(root, context.sessionId);
  expect(fs.existsSync(file)).toBe(false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{broken");
  expect(() => saveBackgroundJobRuntime(root, context.sessionId)).toThrow(
    /refusing background-only update/,
  );
  expect(fs.readFileSync(file, "utf8")).toBe("{broken");
});
