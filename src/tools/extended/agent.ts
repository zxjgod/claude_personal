import { scopedHooks } from "../../scoped-execution.js";
// ============================================================
// Agent Tool ??Enhanced sub-agent spawning with full API compatibility
// ============================================================
// Provides the official Claude Code "Agent" tool API as an enhanced wrapper
// around the existing Task tool, with added support for isolation modes,
// effort levels, and schema-based structured output.
// ============================================================

import { z } from "zod";
import { agentLoop } from "../../agent-loop.js";
import { type AgentMcpHandle, prepareAgentMcpServers } from "../../agents/agent-mcp.js";
import { createModelCaller } from "../../llm-adapter.js";
import { policyDecision } from "../../permission-policy.js";
import { recordSidechainReport } from "../../sidechain-transcript.js";
import { blockedOutputNotice, scanSubagentOutput } from "../../subagent-output-scan.js";
import {
  claimRun,
  createRun,
  isRunActive,
  loadRun,
  type SubagentRunRecord,
  saveRun,
  unmarkRunActive,
} from "../../subagent-store.js";
import {
  buildSubagentSystemPrompt,
  extractLastAssistantText,
  getCoreToolsForSubagents,
  listSubagentNames,
  listSubagentSelectionHints,
  normalizeSubagentTypeName,
  preloadAgentSkills,
  resolveSubagentTools,
  resolveSubagentType,
  subagentModelConfig,
} from "../../subagents.js";
import {
  deriveSubContext,
  type Message,
  type PermissionMode,
  type Tool,
  type ToolResult,
} from "../../types.js";
import { Semaphore } from "../../utils/semaphore.js";
import { createSubAgentApprover } from "../../utils/subagent-security.js";
import {
  createIsolatedWorktree,
  finishIsolatedWorktree,
  randomWorktreeName,
  type WorktreeInfo,
} from "../../worktrees.js";
import { createJob, settleJob } from "../job-store.js";
import { buildTool } from "../registry.js";
import { collectPartialReport } from "./subagent-report.js";

// ============================================================
// Guards ??fork depth + concurrency
// ============================================================

// Fork nesting cap: a fork inherits the full core tool set (including the
// Agent tool itself), so without a limit fork ??fork ????recurses unbounded.
// Official semantics (docs/en/sub-agents "How forks differ"): "A fork can't
// spawn further forks" ??the main agent (depth 0) forks at depth 1, and that
// fork must delegate to a TYPED sub-agent instead of forking again. (This
// now matches the Task tool's cap; the earlier depth-2 allowance diverged.)
const MAX_FORK_DEPTH = 1;

// Total sub-agent nesting cap. Official 2.1.202 rejects any spawn at depth
// >= 5 (S8t=5): "Subagent nesting limit reached (depth N of 5). Complete
// this task directly using your tools instead of spawning another agent."
const MAX_SUBAGENT_DEPTH = 5;

// Official fork agent definition: maxTurns 200 (a fork inherits the full
// task and needs the headroom typed research agents don't).
const FORK_MAX_TURNS = 200;

// Max concurrent Agent loops. Deliberately a SEPARATE semaphore from Task's:
// a fan-out mixing Task and Agent calls should not starve either kind.
// Override via AGENT_MAX_CONCURRENCY.
const MAX_CONCURRENCY = (() => {
  const raw = Number(process.env.AGENT_MAX_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
})();

const agentSlots = new Semaphore(MAX_CONCURRENCY, "Agent");

/** Test teardown: drop held slots so a case can't strand the next one. */
export function resetAgentSlots(): void {
  agentSlots.reset();
}

// ============================================================
// Worktree isolation helpers
// ============================================================

async function createWorktree(
  workspaceRoot: string,
  _sessionId: string,
): Promise<WorktreeInfo | { error: string }> {
  try {
    return await createIsolatedWorktree(workspaceRoot, randomWorktreeName("agent-wt"));
  } catch (error) {
    return { error: String(error) };
  }
}

// ============================================================
// Agent Tool
// ============================================================

const AgentSchema = z.strictObject({
  prompt: z.string().min(1).describe("The task for the agent to perform"),
  description: z.string().optional().describe("A short (3-5 word) description of the task"),
  subagent_type: z
    .string()
    .optional()
    .describe(
      `Type of agent to launch. Omit for the default general agent; "fork" forks the current agent. Available: ${listSubagentNames().join(", ")}`,
    ),
  model: z.string().optional().describe("Model override for this agent"),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Reasoning effort level for this agent"),
  isolation: z
    .enum(["worktree"])
    .optional()
    .describe("Run in isolated git worktree (expensive, use only for parallel mutations)"),
  run_in_background: z
    .boolean()
    .optional()
    .describe("Run agent in background, return immediately with task ID"),
  mode: z
    .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
    .optional()
    .describe(
      "Permission mode for this agent (e.g. 'plan' to require plan approval). " +
        "Overrides the agent definition and the inherited mode. Not applied while the " +
        "parent session is itself in plan mode — a sub-agent cannot widen past its parent.",
    ),
  // Official declares this "Deprecated; ignored. The session has a single implicit
  // team." Accepted and discarded so an official-shaped call does not fail the
  // strict parse, which is exactly how official treats it.
  team_name: z.string().optional().describe("Deprecated and ignored; the session has one team"),
  resume: z
    .string()
    .optional()
    .describe(
      "Resume a previous agent run by its agent id (returned in metadata). The stored " +
        'conversation is loaded and this prompt continues it. Not valid with "fork".',
    ),
});

// How much authority a permission mode GRANTS, least → most. `dontAsk` sits
// below `default` because it changes prompting (deny instead of ask), not
// grants ??it can never be used to obtain more authority than the parent holds.
const MODE_AUTHORITY: Record<PermissionMode, number> = {
  plan: 0,
  dontAsk: 1,
  default: 2,
  acceptEdits: 3,
  auto: 4,
  bypassPermissions: 5,
};

type AgentInput = z.infer<typeof AgentSchema>;

// Rebuilt by cli-tools after disk agents register (and in lean form when the
// description budget is blown ??official Y$l swaps whenToUse ??whenToUseLean).
export function buildAgentPromptDescription(lean?: boolean): string {
  const hints = listSubagentSelectionHints(lean)
    .map((h) => `  - ${h.name}: ${h.whenToUse}`)
    .join("\n");

  return (
    "Launch a sub-agent to handle complex tasks. Each agent has its own context and tools.\n" +
    "WHEN TO USE THIS vs the `task` tool: this one adds per-agent CONTROL that `task` lacks —\n" +
    "  - a different `model` or `effort` for a hard sub-problem,\n" +
    '  - `isolation: "worktree"` so a mutating sub-task edits a throwaway git worktree\n' +
    "    instead of the working tree (expensive — creates a branch per agent),\n" +
    "  - `run_in_background: true` to keep working while it runs.\n" +
    "For an ordinary same-model, read-only sub-task, prefer `task` — it is the common case.\n" +
    "Parameters:\n" +
    "  - prompt (required): detailed task instructions\n" +
    "  - description (optional): short summary shown in UI\n" +
    "  - subagent_type (optional): agent type; omit for the default general agent,\n" +
    '    or "fork" to fork the current agent\n' +
    "  - model (optional): override model for this agent\n" +
    "  - effort (optional): reasoning effort (low/medium/high/xhigh/max)\n" +
    "  - isolation (optional): 'worktree' for git worktree isolation (expensive)\n" +
    "  - run_in_background (optional): return immediately, agent runs async\n\n" +
    "Available agent types:\n" +
    hints +
    "\n\nOmit subagent_type for the default general-purpose agent. " +
    'Use subagent_type: "fork" to FORK: inherits conversation context and prompt cache.'
  );
}

export const AgentTool: Tool = buildTool({
  name: "Agent",
  description: "Launch a sub-agent to handle complex, multi-step tasks autonomously",
  promptDescription: buildAgentPromptDescription(),
  schema: AgentSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: true,
  timeoutMs: 15 * 60 * 1000,

  async call(input: AgentInput, context): Promise<ToolResult> {
    if (context.permissionMode === "plan")
      return { content: "", error: "Plan mode: Agent execution is disabled" };
    const startTime = Date.now();

    // Validate model config
    if (!context.modelConfig) {
      return { content: "", error: "Agent tool requires modelConfig in context" };
    }

    // Official lets the caller pass `mode` for the spawned teammate, and the
    // caller here is the MODEL. Honoring it verbatim would hand a
    // prompt-injected model a privilege-escalation path: it cannot change the
    // session mode, but `mode: "bypassPermissions"` would grant its sub-agent
    // more authority than the user ever granted this session. So a sub-agent
    // may narrow, never widen — and a widening request is reported rather than
    // silently downgraded, so a model that relied on it is not misled.
    if (input.mode && MODE_AUTHORITY[input.mode] > MODE_AUTHORITY[context.permissionMode]) {
      return {
        content: "",
        error:
          `Agent mode "${input.mode}" grants more authority than this session's ` +
          `"${context.permissionMode}" mode. A sub-agent can only narrow permissions.`,
      };
    }

    // Guard against unbounded fork recursion (fork → fork → …). Computed from
    // context alone so the cheap rejection happens before any slot or worktree
    // is created.
    const canFork = !!context.getParentMessages && !!context.parentSystemPrompt;
    // Official (2.1.202): subagent_type "fork" selects the fork EXPLICITLY
    // (normalization makes "Fork"/"fork_" equivalent), alongside omitting
    // the type entirely.
    const requestedType = input.subagent_type?.trim();
    const wantsFork = !!requestedType && normalizeSubagentTypeName(requestedType) === "fork";
    if (wantsFork && !canFork) {
      return {
        content: "",
        error: `subagent_type "fork" requires a parent session context, which is not available here.`,
      };
    }
    // 拍板 a = official 2.1.202: omitting subagent_type launches the DEFAULT
    // typed agent (general-purpose) — "If omitted, the general-purpose agent
    // is used." Forking is EXPLICIT-only (subagent_type: "fork").
    const isFork = wantsFork && canFork;
    const forkDepth = context.subagentDepth ?? 0;
    if (forkDepth >= MAX_SUBAGENT_DEPTH) {
      return {
        content: "",
        error:
          `Subagent nesting limit reached (depth ${forkDepth} of ${MAX_SUBAGENT_DEPTH}). ` +
          `Complete this task directly using your tools instead of spawning another agent.`,
      };
    }
    if (isFork && forkDepth >= MAX_FORK_DEPTH) {
      return {
        content: "",
        error:
          `Fork nesting limit reached (depth ${forkDepth}). ` +
          `Use a typed sub-agent (subagent_type) instead of forking again.`,
      };
    }
    // Official fork availability check includes the deny list (Agent(fork)
    // removes the fork agent from the selectable set). Applies to both the
    // explicit subagent_type:"fork" and the omitted-type fork.
    if (
      isFork &&
      policyDecision(context.permissionPolicy, "Agent", { subagent_type: "fork" }) === "deny"
    ) {
      return {
        content: "",
        error:
          `Agent type 'fork' has been denied by a permissions.deny rule (e.g. Agent(fork)). ` +
          `Remove the rule or use a typed sub-agent.`,
      };
    }

    // F3: background mode. This call returns immediately with a job handle;
    // the work re-enters this same tool synchronously minus the flag, so
    // slots, approvals, worktree cleanup and abort cascading all reuse the
    // one foreground code path. The job stores the final report in stdout;
    // settleJob pushes the M41 completion notification (no polling needed).
    if (input.run_in_background) {
      // An already-aborted parent signal never fires "abort" again — starting
      // the job anyway would run it to completion, unreachable by the
      // cascade. Refuse before creating any job state.
      if (context.abortSignal?.aborted) {
        return { content: "", error: "Session aborted; background agent not started." };
      }
      const { run_in_background: _bg, ...foregroundInput } = input;
      const job = createJob(context.sessionId, {
        kind: "agent",
        command: input.description || input.prompt.slice(0, 80),
        description: input.description,
      });
      const controller = new AbortController();
      const onParentAbort = () => controller.abort();
      context.abortSignal?.addEventListener("abort", onParentAbort, { once: true });
      // Self-settling kill: aborting cascades into the inner run, whose own
      // settle would be a no-op (idempotent) — settling here means `killed`
      // wins even if the inner run takes a moment to unwind.
      job.kill = () => {
        controller.abort();
        settleJob(job, "killed", null);
      };
      void (async () => {
        try {
          const result = await AgentTool.call(foregroundInput, {
            ...context,
            abortSignal: controller.signal,
          });
          job.stdout = result.content ?? "";
          if (result.error) job.stderr = result.error;
          settleJob(job, result.error ? "error" : "done", result.error ? null : 0);
        } catch (error) {
          job.stderr = error instanceof Error ? error.message : String(error);
          settleJob(job, "error", null);
        } finally {
          context.abortSignal?.removeEventListener("abort", onParentAbort);
        }
      })();
      return {
        content:
          `Background agent started (${job.id}). A completion notification will arrive when it ` +
          `finishes; use job_output (wait: true) to retrieve the report, or job_kill to stop it.`,
        metadata: { jobId: job.id, summary: `Background agent ${job.id} started` },
      };
    }

    // Resolve the agent type FIRST — before any resource (slot, worktree) is
    // acquired — so this validation error's early return cannot leak them.
    // (canFork/isFork were computed above.)
    const subagentName = isFork ? "fork" : requestedType || "general";
    // 拍板 #19: resume a previous typed agent run by agent id.
    let resumeRecord: SubagentRunRecord | undefined;
    const resumeId = input.resume?.trim();
    if (resumeId) {
      if (wantsFork) {
        return { content: "", error: `resume cannot be combined with subagent_type "fork".` };
      }
      resumeRecord = loadRun(context.workspaceRoot, context.sessionId, resumeId);
      if (!resumeRecord) {
        return {
          content: "",
          error: `No stored agent run "${resumeId}" for this session (see /agents history).`,
        };
      }
      if (isRunActive(context.sessionId, resumeId)) {
        return {
          content: "",
          error: `Agent run "${resumeId}" is still running — wait for it or job_kill it first.`,
        };
      }
      // A record stuck at "running" on disk belongs to a DEAD process — an
      // orphan, exactly what resume exists for. Heal before reactivation.
      if (resumeRecord.status === "running") resumeRecord.status = "interrupted";
      if (
        requestedType &&
        normalizeSubagentTypeName(requestedType) !==
          normalizeSubagentTypeName(resumeRecord.typeName)
      ) {
        return {
          content: "",
          error:
            `Run "${resumeId}" is a "${resumeRecord.typeName}" agent — ` +
            `resume with that type or omit subagent_type.`,
        };
      }
    }
    const effectiveName = resumeRecord?.typeName ?? subagentName;
    const resolution = isFork ? undefined : resolveSubagentType(effectiveName);
    if (resolution?.kind === "ambiguous") {
      return {
        content: "",
        error:
          `Agent type '${effectiveName}' is ambiguous — matches ` +
          `${resolution.matches.join(", ")}. Use the exact name: ${resolution.matches.join(" or ")}`,
      };
    }
    if (resolution?.kind === "not-found") {
      const allowed = listSubagentNames().filter(
        (n) => policyDecision(context.permissionPolicy, "Agent", { subagent_type: n }) !== "deny",
      );
      return {
        content: "",
        error: `Unknown subagent type: "${effectiveName}". Available: ${allowed.join(", ")}`,
      };
    }
    const subagentType = resolution?.kind === "found" ? resolution.type : undefined;
    // The resumed run's own type name wins for display/progress too.
    const displayName = resumeRecord?.typeName ?? subagentName;

    // Official "Disable specific subagents": `permissions.deny` may name a
    // type (`Agent(code-explorer)`). The generic permission gate also denies
    // the call, but rejecting here — before slot/worktree acquisition —
    // returns a clearer message and cannot leak resources.
    if (
      subagentType &&
      policyDecision(context.permissionPolicy, "Agent", { subagent_type: subagentType.name }) ===
        "deny"
    ) {
      return {
        content: "",
        error:
          `Sub-agent type "${subagentType.name}" is denied by permissions.deny ` +
          `(e.g. Agent(${subagentType.name})). Remove the rule or pick another type.`,
      };
    }

    // Worktree isolation — created AFTER the slot guard below. Creating it
    // first would orphan a fresh worktree+branch on the nested-agent
    // rejection path, whose early return bypasses the catch-block cleanup.
    let worktree: WorktreeInfo | null = null;
    let worktreeRetained = false;
    let effectiveWorkspaceRoot = context.workspaceRoot;

    let slotAcquired = false;
    // 拍板 #14-B: agent-scoped MCP handle, closed in the finally below.
    let agentMcpHandle: AgentMcpHandle | undefined;
    // 拍板 #19: hoisted so the finally can persist the terminal record even
    // when an exception unwinds the run.
    let runRecord: SubagentRunRecord | undefined;
    // Only the CLAIMANT persists the terminal record and releases the marker.
    let runClaimed = false;
    try {
      // Trust-gate + connect the agent's declared MCP servers BEFORE any
      // resource acquisition — a denial/errors out without leaking slots.
      if (subagentType && !isFork) {
        const prepared = await prepareAgentMcpServers(subagentType, context);
        if (prepared.kind === "error") return { content: "", error: prepared.error };
        if (prepared.kind === "ready") agentMcpHandle = prepared.handle;
      }
      // Concurrency guard. Top-level agents QUEUE for a slot — a fan-out of
      // Agent calls is the normal use. NESTED agents must never queue: their
      // parent already holds a slot and is waiting on this result, so parking
      // here under full load would deadlock the whole batch.
      if (forkDepth === 0) {
        await agentSlots.acquire(context.abortSignal);
        slotAcquired = true;
      } else if (agentSlots.tryAcquire()) {
        slotAcquired = true;
      } else {
        return {
          content: "",
          error:
            `Too many concurrent agents (${agentSlots.active}/${MAX_CONCURRENCY}). ` +
            `A nested agent cannot queue behind its own parent — finish or narrow the fan-out first.`,
        };
      }

      if (input.isolation === "worktree" || subagentType?.isolation === "worktree") {
        const result = await createWorktree(context.workspaceRoot, context.sessionId);
        if ("error" in result) {
          return { content: "", error: result.error };
        }
        worktree = result;
        effectiveWorkspaceRoot = worktree.path;
      }

      // Build model config with overrides. Precedence (2.1.202 binary B7):
      // env > call-time model param > frontmatter — all inside
      // subagentModelConfig; the effort param is applied here after.
      let modelConfig = subagentModelConfig(
        isFork ? undefined : subagentType,
        context.modelConfig,
        isFork ? undefined : input.model,
      );
      if (!isFork && input.effort) {
        modelConfig = {
          ...modelConfig,
          options: { ...modelConfig.options, effort: input.effort },
        };
      }

      // Get available tools
      const availableTools = await getCoreToolsForSubagents();

      // Build system prompt
      let systemPrompt: string;
      let initialMessages: Message[];
      let tools: Tool[];

      if (isFork) {
        systemPrompt = context.parentSystemPrompt!;
        initialMessages = context.getParentMessages!();
        tools = availableTools; // Fork gets all available tools
      } else {
        systemPrompt = buildSubagentSystemPrompt(
          subagentType!,
          [
            input.description || "Sub-agent task",
            await preloadAgentSkills(subagentType!, effectiveWorkspaceRoot),
          ].join("\n"),
          { workspaceRoot: effectiveWorkspaceRoot },
        );
        initialMessages = resumeRecord?.messages ?? [];
        tools = [
          ...resolveSubagentTools(subagentType!, availableTools),
          ...(agentMcpHandle?.tools ?? []),
        ];
      }

      // Add user prompt
      const messages: Message[] = [
        ...initialMessages,
        {
          role: "user",
          content: [{ type: "text", text: input.prompt }],
        },
      ];

      // Mark the inherited context by IDENTITY, not index: autoCompact splices
      // this array in place, so a `slice(initialMessages.length)` boundary
      // drifts after compaction and a completed fork reads as "no final report".
      const inherited = new Set<Message>(initialMessages);

      // Create model caller
      const modelCaller = createModelCaller(modelConfig);

      // 拍板 #19: one run record per typed agent (forks excluded). Persisted
      // "running" now; the finally writes the terminal status + full messages.
      runRecord = !isFork
        ? (resumeRecord ??
          createRun(
            context.workspaceRoot,
            context.sessionId,
            subagentType!.name,
            input.description || "Sub-agent task",
            input.prompt,
          ))
        : undefined;
      if (runRecord) {
        // 拍板 #19: authoritative claim (the earlier isRunActive check is only
        // the fast, friendly path — both tools are concurrency-safe, so two
        // calls can resume the same id in one assistant turn).
        if (!claimRun(context.sessionId, runRecord.agentId)) {
          return {
            content: "",
            error: `Agent run "${runRecord.agentId}" is already running in this session — only one resume may write its record.`,
          };
        }
        runClaimed = true;
        saveRun(context.workspaceRoot, runRecord);
      }

      // Run agent loop
      const approver = createSubAgentApprover(context.askUser);

      const loop = agentLoop(messages, tools, modelCaller, modelConfig, {
        systemPrompt,
        applyEffortInstruction: !isFork,
        maxTurns: isFork ? FORK_MAX_TURNS : (subagentType?.maxTurns ?? 20),
        autoCompactThreshold: 50_000,
        abortSignal: context.abortSignal,
        // Explicit allow-list, not a spread: a spread would hand the worker
        // the parent's fork hooks (making a typed Agent able to re-fork) and
        // its unrestricted approver.
        toolContext: deriveSubContext(context, {
          modelConfig,
          // Worktree isolation moves the worker's cwd.
          workspaceRoot: effectiveWorkspaceRoot,
          // A fork runs under its own session id so its checkpoint bucket is
          // distinct from the parent's.
          sessionId: `${context.sessionId}-agent-${Date.now()}`,
          askUser: approver,
          abortSignal: context.abortSignal,
          onSubAgentProgress: context.onSubAgentProgress,
          hooks: scopedHooks(
            context.hooks,
            isFork ? undefined : subagentType?.hooks,
            context.sessionId,
            effectiveWorkspaceRoot,
          ),
          // An explicit `mode` on the call wins over the agent definition's
          // frontmatter. (Widening was already rejected in call(), and plan mode
          // never reaches here — line 161 returns early.)
          permissionMode:
            input.mode ??
            (subagentType?.permissionMode === "plan" || subagentType?.permissionMode === "dontAsk"
              ? subagentType.permissionMode
              : context.permissionMode),
          // Thread the nesting depth so a fork-of-a-fork is capped.
          subagentDepth: forkDepth + 1,
        }),
        askUser: approver,
      });

      // Consume loop events
      let terminal: { reason: string; turns: number; error?: unknown } | undefined;
      for await (const event of loop) {
        if (event.type === "tool_use") {
          context.onSubAgentProgress?.({
            subagentName: displayName,
            phase: "tool_use",
            toolName: event.name,
            input: event.input,
          });
        } else if (event.type === "tool_results") {
          context.onSubAgentProgress?.({
            subagentName: displayName,
            phase: "tool_results",
            results: event.results,
          });
        }
        if (event.type === "done") {
          terminal = { reason: event.finishReason, turns: event.turns };
        } else if (event.type === "error") {
          terminal = { reason: "model_error", turns: 0, error: event.error };
        } else if (event.type === "aborted") {
          terminal = { reason: "aborted_streaming", turns: 0, error: event.reason };
        }
      }

      const partialReport =
        terminal?.reason === "max_turns"
          ? await collectPartialReport(
              messages,
              modelCaller,
              modelConfig,
              systemPrompt,
              context.abortSignal,
            )
          : "";
      context.onSubAgentProgress?.({
        subagentName: displayName,
        phase: "done",
        reason: context.abortSignal?.aborted ? "aborted" : (terminal?.reason ?? "model_error"),
      });
      await context.hooks
        ?.runEvent?.("SubagentStop", {
          subagent_name: displayName,
          reason: context.abortSignal?.aborted ? "aborted" : (terminal?.reason ?? "model_error"),
        })
        .catch(() => {});

      // Extract final output — the last assistant message the sub-agent itself
      // produced. Compaction keeps surviving messages by reference, so identity
      // filtering still sees the fork's own turns and never echoes a parent
      // assistant message that happened to survive in the tail.
      const finalText = extractLastAssistantText(messages.filter((m) => !inherited.has(m)));
      const duration = Date.now() - startTime;

      // 拍板 #19: terminal status for the run record (persisted in finally).
      if (runRecord) {
        runRecord.status =
          context.abortSignal?.aborted || terminal?.reason === "aborted_streaming"
            ? "interrupted"
            : terminal?.reason === "end_turn" && finalText
              ? "completed"
              : "error";
        runRecord.report =
          finalText || String(terminal?.error || terminal?.reason || "no terminal event");
        runRecord.messages = messages;
      }

      // Clean up worktree if successful
      if (worktree && terminal?.reason === "end_turn") {
        worktreeRetained = !(await finishIsolatedWorktree(worktree));
      }
      const worktreeMetadata = worktree
        ? {
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch,
            worktreeRetained: terminal?.reason !== "end_turn" || worktreeRetained,
          }
        : {};
      const worktreeNotice =
        worktree && worktreeMetadata.worktreeRetained
          ? `\n\nWorktree retained: ${worktree.path}\nBranch: ${worktree.branch}`
          : "";

      if (terminal?.reason === "max_turns" && !context.abortSignal?.aborted) {
        // The bounded handoff call can come back empty (timeout, refusal, or
        // the model tried a tool); the sub-agent's own final text is the
        // next-best report. Either way the result stays labeled incomplete —
        // hitting the turn budget is never reported as a completed task.
        const report = partialReport || finalText;
        if (report) {
          recordSidechainReport(
            context.workspaceRoot,
            context.sessionId,
            displayName,
            report,
            duration,
          );
          return {
            content: `[Agent partial report — turn budget reached; task incomplete]\n${report}${worktreeNotice}`,
            metadata: {
              durationMs: duration,
              incomplete: true,
              ...(runRecord ? { agentId: runRecord.agentId } : {}),
              ...worktreeMetadata,
            },
          };
        }
      }
      if (terminal?.reason !== "end_turn" || !finalText) {
        recordSidechainReport(
          context.workspaceRoot,
          context.sessionId,
          displayName,
          finalText || `ERROR: ${terminal?.error || terminal?.reason || "no terminal event"}`,
          duration,
        );
        return {
          content: (finalText || "") + worktreeNotice,
          error: `Agent incomplete: ${terminal?.error || terminal?.reason || "no terminal event"}${!finalText ? "; no final report" : ""}`,
          metadata: {
            durationMs: duration,
            ...(runRecord ? { agentId: runRecord.agentId } : {}),
            ...worktreeMetadata,
          },
        };
      }

      // Subagent output scanning (official 2.1.202 parity, 拍板 d=A): classify
      // the final report for prompt injection before returning it. Fail-open.
      // 拍板 #22: the RAW report is recorded before scanning — the audit trail
      // must show what the agent actually said even when it is withheld.
      recordSidechainReport(
        context.workspaceRoot,
        context.sessionId,
        displayName,
        finalText,
        duration,
      );
      const scan = await scanSubagentOutput(finalText, modelConfig);
      if (scan.blocked) {
        return {
          content: blockedOutputNotice(displayName) + worktreeNotice,
          metadata: {
            durationMs: duration,
            outputScan: "blocked",
            ...(runRecord ? { agentId: runRecord.agentId } : {}),
            ...worktreeMetadata,
          },
        };
      }

      return {
        content:
          (finalText || "(Agent completed with no output)") +
          worktreeNotice +
          (runRecord
            ? `\n\n(Agent id: ${runRecord.agentId} — continue this agent with resume:"${runRecord.agentId}")`
            : ""),
        metadata: {
          durationMs: duration,
          outputScan: scan.status,
          ...(runRecord ? { agentId: runRecord.agentId } : {}),
          ...worktreeMetadata,
        },
      };
    } catch (error) {
      if (worktree) {
        return {
          content: `Worktree retained: ${worktree.path}\nBranch: ${worktree.branch}`,
          error: String(error),
          metadata: {
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch,
            worktreeRetained: true,
          },
        };
      }
      throw error;
    } finally {
      // 拍板 #19: persist the terminal record (crash leaves "running", which
      // listRuns reports as "interrupted") and release the active marker.
      if (runRecord) {
        // An exception path never set a terminal status — that IS an
        // interruption (abort/crash), not a successful or failed run.
        if (runRecord.status === "running") runRecord.status = "interrupted";
        if (runClaimed) {
          saveRun(context.workspaceRoot, runRecord);
          unmarkRunActive(context.sessionId, runRecord.agentId);
        }
      }
      // 拍板 #14-B: agent-scoped MCP connections live exactly one run.
      await agentMcpHandle?.close();
      if (slotAcquired) agentSlots.release();
    }
  },
  formatResult: (result) =>
    result.error
      ? `Error: ${result.error}${result.content ? `\nPartial output (not a completed report):\n${result.content}` : ""}`
      : result.content,
});
