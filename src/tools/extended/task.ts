import {
  activateSkill,
  activeSkill,
  clearSkillActivation,
  prepareAgentHooks,
  scopedHooks,
} from "../../scoped-execution.js";
// ============================================================
// Task Tool — Sub-agent system for complex multi-step tasks
// ============================================================
// Spawns an independent sub-agent with a configurable tool set and
// isolated context window. Sub-agent types come from the registry
// (src/subagents.ts). Concurrent sub-agents are capped by a semaphore
// so a fan-out of task calls can't exhaust the model's rate limit.
// ============================================================

import { z } from "zod";
import { agentLoop } from "../../agent-loop.js";
import { loadAgentMemoryPrompt } from "../../agent-memory.js";
import { prepareAgentMcpServers } from "../../agents/agent-mcp.js";
import { createModelCaller } from "../../llm-adapter.js";
import { policyDecision } from "../../permission-policy.js";
import {
  recordSidechainReport,
  recordSidechainToolResult,
  recordSidechainToolUse,
} from "../../sidechain-transcript.js";
import { blockedOutputNotice, scanSubagentOutput } from "../../subagent-output-scan.js";
import {
  claimRun,
  createRun,
  isRunActive,
  loadRun,
  type SubagentRunRecord,
  type SubagentRunStatus,
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
  setAgentMemoryLoader,
  subagentModelConfig,
} from "../../subagents.js";
import { deriveSubContext, type Message, type Tool, type ToolResult } from "../../types.js";
import { CancellationScope } from "../../utils/cancellation.js";
import { Semaphore } from "../../utils/semaphore.js";
import { createSubAgentApprover } from "../../utils/subagent-security.js";
import { buildTool } from "../registry.js";
import { collectPartialReport } from "./subagent-report.js";

// Register the agent-memory loader once (M35). Done here rather than in
// subagents.ts to keep that module free of a static node:fs dependency.
setAgentMemoryLoader(loadAgentMemoryPrompt);

// --- Constants ---

const SUBAGENT_MAX_TURNS = 10;
const SUBAGENT_COMPACT_THRESHOLD = 50_000;
// Fork nesting cap: a fork inherits the full core tool set (including the Task
// tool itself), so without a limit fork → fork → … would recurse unbounded.
// The main agent (depth 0) may fork once (depth 1); a fork may not fork again.
const MAX_FORK_DEPTH = 1;

// Total sub-agent nesting cap. Official 2.1.202 rejects any spawn at depth
// >= 5 (S8t=5): "Subagent nesting limit reached (depth N of 5)".
const MAX_SUBAGENT_DEPTH = 5;

// Official fork agent definition: maxTurns 200.
const FORK_MAX_TURNS = 200;

// Max sub-agents running at once. A turn can request many `task` calls
// (they're concurrency-safe), so without a cap a wide fan-out would hit
// the provider all at once. Override via TASK_MAX_CONCURRENCY.
const MAX_CONCURRENCY = (() => {
  const raw = Number(process.env.TASK_MAX_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
})();

// --- Schema ---

const TaskSchema = z.strictObject({
  description: z.string().min(1).describe("A short (3-5 word) description of the task"),
  prompt: z
    .string()
    .min(1)
    .describe("The detailed task for the sub-agent to perform. Be specific."),
  subagent_name: z
    .string()
    .optional()
    .describe(
      `Type of sub-agent to launch. Omit for the default general agent; "fork" FORKS the current ` +
        `agent (inherits conversation context). Available types: ${listSubagentNames().join(", ")}`,
    ),
  resume: z
    .string()
    .optional()
    .describe(
      "Resume a previous sub-agent run by its agent id (shown in the report header and " +
        "metadata). The stored conversation is loaded and this prompt continues it. " +
        'Not valid with subagent_name "fork".',
    ),
});

// --- Concurrency semaphore ---

// Module-level (session-wide) semaphore over concurrent sub-agent loops.
// The label keeps the historical error strings ("Sub-agent aborted …").
const slots = new Semaphore(MAX_CONCURRENCY, "Sub-agent");

const acquireSlot = (signal?: AbortSignal): Promise<void> => slots.acquire(signal);
const releaseSlot = (): void => slots.release();

// --- Tool ---

// Build the promptDescription dynamically to include current subagent types.
// Rebuilt by cli-tools after disk agents register (and in lean form when the
// description budget is blown — official Y$l swaps whenToUse → whenToUseLean).
export function buildTaskPromptDescription(lean?: boolean): string {
  const hints = listSubagentSelectionHints(lean)
    .map((h) => `  - ${h.name}: ${h.whenToUse}`)
    .join("\n");

  return (
    "Launch a sub-agent to handle complex, multi-step tasks. " +
    "This is the DEFAULT sub-agent tool — reach for it unless you need per-agent " +
    "control (a different model/effort, git worktree isolation, or background " +
    "execution), which only the `Agent` tool provides.\n" +
    "Parameters: description (required, short summary), prompt (required, detailed instructions), " +
    'subagent_name (optional; omit for the default general agent, or "fork" to fork current agent). ' +
    'subagent_name "fork" FORKS the current agent: inherits conversation context and prompt cache, returns final report only. ' +
    "Or pick a typed sub-agent:\n" +
    hints +
    "\n" +
    `Multiple sub-agents run concurrently (max ${MAX_CONCURRENCY}). ` +
    "Only the final report is returned — intermediate tool output is not shown."
  );
}

export const TaskTool: Tool = buildTool({
  name: "task",
  description: "Launch a sub-agent to handle complex, multi-step tasks autonomously",
  promptDescription: buildTaskPromptDescription(),
  schema: TaskSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: true,
  timeoutMs: 15 * 60 * 1000,

  async call(input, context): Promise<ToolResult> {
    // --- Setup sub-agent ---

    const requestedName = input.subagent_name?.trim();

    const canFork = !!context.getParentMessages && !!context.parentSystemPrompt;
    // Official (2.1.202): subagent_type "fork" selects the fork EXPLICITLY
    // (normalization makes "Fork"/"fork_" equivalent).
    const wantsFork = !!requestedName && normalizeSubagentTypeName(requestedName) === "fork";
    if (wantsFork && !canFork) {
      return {
        content: "",
        error: `subagent_name "fork" requires a parent session context, which is not available here.`,
      };
    }
    // 拍板 a = official 2.1.202: omitting the type launches the DEFAULT typed
    // agent (general-purpose), NOT a fork. Forking is explicit-only.
    const isFork = wantsFork && canFork;

    // Guard against unbounded fork recursion (fork → fork → …).
    const depth = context.subagentDepth ?? 0;
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return {
        content: "",
        error:
          `Subagent nesting limit reached (depth ${depth} of ${MAX_SUBAGENT_DEPTH}). ` +
          `Complete this task directly using your tools instead of spawning another agent.`,
      };
    }
    if (isFork && depth >= MAX_FORK_DEPTH) {
      return {
        content: "",
        error:
          `Fork nesting limit reached (depth ${depth}). ` +
          `A forked agent cannot fork again — use a typed sub-agent (subagent_name) instead.`,
      };
    }
    // Official fork availability check includes the deny list (task(fork)
    // removes the fork agent from the selectable set).
    if (
      isFork &&
      policyDecision(context.permissionPolicy, "task", { subagent_type: "fork" }) === "deny"
    ) {
      return {
        content: "",
        error:
          `Agent type 'fork' has been denied by a permissions.deny rule (e.g. task(fork)). ` +
          `Remove the rule or use a typed sub-agent.`,
      };
    }

    // 拍板 #19: resume a previous typed sub-agent run by agent id.
    const resumeId = input.resume?.trim();
    let resumeRecord: SubagentRunRecord | undefined;
    if (resumeId) {
      if (requestedName && normalizeSubagentTypeName(requestedName) === "fork") {
        return { content: "", error: `resume cannot be combined with subagent_name "fork".` };
      }
      resumeRecord = loadRun(context.workspaceRoot, context.sessionId, resumeId);
      if (!resumeRecord) {
        return {
          content: "",
          error: `No stored sub-agent run "${resumeId}" for this session (see /agents history).`,
        };
      }
      if (isRunActive(context.sessionId, resumeId)) {
        return {
          content: "",
          error: `Sub-agent run "${resumeId}" is still running — wait for it or job_kill it first.`,
        };
      }
      // A record stuck at "running" on disk belongs to a DEAD process (we are
      // the only writer of our own mid-run records) — that orphan is exactly
      // what resume exists for. Heal the status before reactivation.
      if (resumeRecord.status === "running") resumeRecord.status = "interrupted";
      if (
        requestedName &&
        normalizeSubagentTypeName(requestedName) !==
          normalizeSubagentTypeName(resumeRecord.typeName)
      ) {
        return {
          content: "",
          error:
            `Run "${resumeId}" is a "${resumeRecord.typeName}" agent — ` +
            `resume with that type or omit subagent_name.`,
        };
      }
    }

    const subagentName = isFork ? "fork" : resumeRecord?.typeName || requestedName || "general";
    const resolution = isFork ? undefined : resolveSubagentType(subagentName);
    if (resolution?.kind === "ambiguous") {
      return {
        content: "",
        error:
          `Agent type '${subagentName}' is ambiguous — matches ` +
          `${resolution.matches.join(", ")}. Use the exact name: ${resolution.matches.join(" or ")}`,
      };
    }
    if (resolution?.kind === "not-found") {
      // Hide policy-denied types from the suggestion list so the model stops
      // being offered a capability the operator removed (official parity:
      // "Disable specific subagents").
      const allowed = listSubagentNames().filter(
        (n) => policyDecision(context.permissionPolicy, "task", { subagent_type: n }) !== "deny",
      );
      return {
        content: "",
        error: `Unknown subagent type: "${subagentName}". Allowed: ${allowed.join(", ")}`,
      };
    }
    const subagentType = resolution?.kind === "found" ? resolution.type : undefined;

    // 拍板 #14-B: agent-scoped MCP servers — trust-gated, connected for the
    // duration of THIS run, closed in the finally at the end of the call.
    const agentMcp =
      subagentType && !isFork ? await prepareAgentMcpServers(subagentType, context) : undefined;
    if (agentMcp?.kind === "error") return { content: "", error: agentMcp.error };
    const agentMcpHandle = agentMcp?.kind === "ready" ? agentMcp.handle : undefined;
    // Trust-gate the agent's declared hooks (review fix: project agent hooks
    // used to register with no gate at all) before the prompt is assembled.
    const agentHooks =
      subagentType && !isFork
        ? await prepareAgentHooks(subagentType, context.askUser, context.workspaceRoot)
        : {};
    // 拍板 #19: hoisted so the outer finally (after the try) can persist the
    // terminal record even when an exception unwinds the run.
    let runRecord: SubagentRunRecord | undefined;
    // Only the CLAIMANT persists the terminal record and releases the marker —
    // a parallel call that lost the claim must not write over the winner's
    // record nor free its active marker.
    let runClaimed = false;
    let runStatus: SubagentRunStatus = "running";
    let runReport: string | undefined;
    let finalMessages: Message[] = [];
    try {
      if (
        subagentType &&
        policyDecision(context.permissionPolicy, "task", { subagent_type: subagentType.name }) ===
          "deny"
      ) {
        return {
          content: "",
          error:
            `Sub-agent type "${subagentType.name}" is denied by permissions.deny ` +
            `(e.g. Task(${subagentType.name})). Remove the rule or pick another type.`,
        };
      }
      if (!context.modelConfig) {
        return {
          content: "",
          error: "Task tool requires modelConfig in context. The CLI must provide this.",
        };
      }

      // Fork seeds the sub-loop with a copy of the parent's history (inherit
      // context) then appends the fork task; a typed sub-agent starts clean —
      // or with the stored conversation when resuming (拍板 #19).
      const seed: Message[] = isFork
        ? context.getParentMessages!()
        : (resumeRecord?.messages ?? []);
      const subMessages: Message[] = [
        ...seed,
        { role: "user", content: [{ type: "text", text: input.prompt }] },
      ];
      // Mark the inherited parent history by IDENTITY, not length: autoCompact
      // splices subMessages in place, so an index boundary (seedLen) drifts after
      // compaction and a completed fork reads as "no final report".
      const seedSet = new Set<Message>(seed);
      finalMessages = subMessages; // same reference — the loop mutates in place

      const config = subagentModelConfig(isFork ? undefined : subagentType, context.modelConfig);
      const subCaller = createModelCaller(config);

      // 拍板 #19: one run record per typed sub-agent (forks excluded — their
      // history is the parent's). Persisted "running" now; the finally below
      // writes the terminal status + full messages (the resume seed). A crash
      // leaves "running", which listRuns reports as "interrupted" (orphan).
      runRecord = !isFork
        ? (resumeRecord ??
          createRun(
            context.workspaceRoot,
            context.sessionId,
            subagentType!.name,
            input.description,
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
            error: `Sub-agent run "${runRecord.agentId}" is already running in this session — only one resume may write its record.`,
          };
        }
        runClaimed = true;
        // Seed the record with the live conversation BEFORE the first save:
        // a crash before the terminal finally used to leave an orphan whose
        // messages were empty, so a resume knew nothing about the original
        // task (review fix). The loop mutates this array in place; the
        // terminal finally persists the same reference again.
        runRecord.messages = subMessages;
        saveRun(context.workspaceRoot, runRecord);
      }
      // Fork reuses the parent prompt verbatim (shared cache); a typed sub-agent
      // gets its own type-specific prompt + env footnote.
      const subSystemPrompt = isFork
        ? context.parentSystemPrompt!
        : buildSubagentSystemPrompt(
            subagentType!,
            [
              subagentType!.systemPrompt,
              "",
              `Your task: ${input.description}`,
              await preloadAgentSkills(subagentType!, context.workspaceRoot, context.askUser),
              ...(agentHooks.note ? ["", agentHooks.note] : []),
            ].join("\n"),
            { workspaceRoot: context.workspaceRoot },
          );

      // M35: fork a child cancellation scope from the parent's signal so a parent
      // Ctrl+C / abort cascades into this sub-agent's loop. Previously the loop
      // was spawned with no signal, so an aborted parent left sub-agents running.
      const scope = new CancellationScope(context.abortSignal);

      // --- Run sub-agent loop (under the concurrency cap) ---

      const startTime = Date.now();
      let toolCallCount = 0;
      let errorMessage: string | undefined;
      let finishReason: string | undefined;
      let partialReport = "";

      let slotAcquired = false;
      // The sub-loop SHARES the parent's sessionId (same workspace, job store,
      // speculation cache) — and agentLoop's finally calls
      // clearSkillActivation(sessionId) unconditionally, which used to wipe the
      // PARENT's active skill policy/hooks/model when any Task sub-agent
      // finished (review finding "Task 子代理共享 sessionId 清掉父技能策略").
      // Snapshot the activation and restore it when the sub-loop exits; a skill
      // the sub-agent itself activated must not leak into the parent either, so
      // restore (not merge) is the correct semantics.
      const parentSkillActivation = activeSkill(context.sessionId);
      try {
        await acquireSlot(context.abortSignal);
        slotAcquired = true;
        const coreTools = await getCoreToolsForSubagents();
        // Fork inherits the full core tool set (it IS the current agent); a typed
        // sub-agent is restricted to its declared tools.
        const subagentTools = [
          ...(isFork ? coreTools : resolveSubagentTools(subagentType!, coreTools)),
          ...(agentMcpHandle?.tools ?? []),
        ];

        // P0 Security Fix: Create restricted approver for sub-agent
        // Dangerous tools (bash/write/edit) require parent approval
        const subApprover = createSubAgentApprover(context.askUser, true);

        const loop = agentLoop(subMessages, subagentTools, subCaller, config, {
          systemPrompt: subSystemPrompt,
          // Forks must preserve the parent's prompt byte-for-byte for prompt
          // cache reuse. The parent loop already applied the effort contract.
          applyEffortInstruction: !isFork,
          maxTurns: isFork ? FORK_MAX_TURNS : (subagentType?.maxTurns ?? SUBAGENT_MAX_TURNS),
          autoCompactThreshold: SUBAGENT_COMPACT_THRESHOLD,
          abortSignal: scope.signal,
          // Run sub-agent tools in the same workspace/session as the parent.
          // deriveSubContext is an explicit allow-list — a spread here would
          // hand the worker the parent's fork hooks and full approver.
          toolContext: deriveSubContext(context, {
            modelConfig: config,
            // Restricted approver: a sub-agent must not bypass permissions.
            askUser: subApprover,
            // The worker's own scope, so a Ctrl+C in the worker cancels it.
            abortSignal: scope.signal,
            // Thread the nesting depth so a fork-of-a-fork is capped.
            subagentDepth: depth + 1,
            // Own skill-activation scope for typed agents (a fork shares the
            // parent's — see ToolContext.skillScopeId).
            skillScopeId: isFork
              ? context.skillScopeId
              : `task-${subagentName}-${Date.now().toString(36)}-${Math.random()
                  .toString(36)
                  .slice(2, 8)}`,
            hooks: scopedHooks(
              context.hooks,
              isFork ? undefined : agentHooks.hooksConfig,
              context.sessionId,
              context.workspaceRoot,
            ),
            permissionMode:
              context.permissionMode === "plan"
                ? "plan"
                : subagentType?.permissionMode === "plan" ||
                    subagentType?.permissionMode === "dontAsk"
                  ? subagentType.permissionMode
                  : context.permissionMode,
          }),
          // Also pass restricted askUser at the LoopOptions level
          askUser: subApprover,
        });

        for await (const event of loop) {
          switch (event.type) {
            case "tool_use":
              toolCallCount++;
              // 拍板 #22: sidechain audit trail (mode-filtered inside).
              recordSidechainToolUse(
                context.workspaceRoot,
                context.sessionId,
                subagentName,
                event.id,
                event.name,
                event.input,
              );
              context.onSubAgentProgress?.({
                subagentName,
                phase: "tool_use",
                toolName: event.name,
                input: event.input,
              });
              break;
            case "tool_results":
              for (const r of event.results)
                recordSidechainToolResult(
                  context.workspaceRoot,
                  context.sessionId,
                  subagentName,
                  r.toolName,
                  r.formatted,
                  r.error,
                );
              context.onSubAgentProgress?.({
                subagentName,
                phase: "tool_results",
                results: event.results,
              });
              break;
            case "done":
              finishReason = event.finishReason;
              break;
            case "aborted":
              errorMessage = event.reason;
              break;
            case "error":
              errorMessage = String(event.error);
              break;
            default:
              // thinking / usage / compacting — silent
              break;
          }
        }
        if (finishReason === "max_turns" && !scope.signal.aborted) {
          partialReport = await collectPartialReport(
            subMessages,
            subCaller,
            context.modelConfig,
            subSystemPrompt,
            scope.signal,
          );
        }
      } catch (error) {
        errorMessage = (error as Error).message || String(error);
      } finally {
        if (parentSkillActivation) activateSkill(context.sessionId, parentSkillActivation);
        else clearSkillActivation(context.sessionId);
        if (slotAcquired) releaseSlot();
        scope.dispose();
        context.onSubAgentProgress?.({
          subagentName,
          phase: "done",
          reason: context.abortSignal?.aborted ? "aborted" : (finishReason ?? "model_error"),
        });
      }

      const duration = Date.now() - startTime;
      // 拍板 #22: the final report line is recorded in BOTH sidechain modes
      // ("audit" detail + "report" 仅最终报告回流).
      const own = subMessages.filter((m) => !seedSet.has(m));
      const output = extractLastAssistantText(own);
      // 拍板 #19: terminal status for the run record (persisted in finally).
      if (context.abortSignal?.aborted || errorMessage === "AbortError") {
        runStatus = "interrupted";
        runReport = output || errorMessage;
      } else if (finishReason === "end_turn" && output) {
        runStatus = "completed";
        runReport = output;
      } else {
        runStatus = "error";
        runReport = output || errorMessage;
      }
      if (output || errorMessage) {
        recordSidechainReport(
          context.workspaceRoot,
          context.sessionId,
          subagentName,
          output || `ERROR: ${errorMessage}`,
          duration,
          toolCallCount,
        );
      }

      if (finishReason === "max_turns" && !context.abortSignal?.aborted) {
        // The bounded handoff call can come back empty (timeout, refusal, or the
        // model tried a tool); the sub-agent's own final text is the next-best
        // report. Either way the result stays labeled incomplete.
        const report = partialReport || output;
        if (report) {
          return {
            content: `[Sub-agent "${subagentName}" partial report — turn budget reached; task incomplete]\n${report}`,
            metadata: {
              durationMs: duration,
              linesRead: toolCallCount,
              incomplete: true,
              ...(runRecord ? { agentId: runRecord.agentId } : {}),
            },
          };
        }
      }

      if (finishReason !== "end_turn" || !output) {
        return {
          content: output ? `Partial output (not a completed report):\n${output}` : "",
          error: `${isFork ? "Fork" : "Sub-agent"} incomplete: ${errorMessage || finishReason || "no terminal event"}${!output ? "; no final report" : ""}`,
          metadata: { durationMs: duration, ...(runRecord ? { agentId: runRecord.agentId } : {}) },
        };
      }

      const header = [
        isFork ? `[Fork of current agent completed]` : `[Sub-agent "${subagentName}" completed]`,
        `Task: ${input.description}`,
        ...(runRecord
          ? [
              `Agent id: ${runRecord.agentId} (resume: task/agent with resume:"${runRecord.agentId}")`,
            ]
          : []),
        `Tool calls: ${toolCallCount}`,
        `Duration: ${(duration / 1000).toFixed(1)}s`,
        ``,
        `--- Findings ---`,
        ``,
      ].join("\n");

      // Subagent output scanning (official 2.1.202 parity, 拍板 d=A): run the
      // report through a prompt-injection classifier before handing it back.
      // Fail-open: an unavailable classifier never blocks a legitimate report.
      const scan = await scanSubagentOutput(output, config, scope.signal);
      if (scan.blocked) {
        return {
          content: header + blockedOutputNotice(subagentName),
          truncated: false,
          metadata: { durationMs: duration, linesRead: toolCallCount, outputScan: "blocked" },
        };
      }

      return {
        content: header + output,
        truncated: false,
        metadata: {
          durationMs: duration,
          linesRead: toolCallCount,
          outputScan: scan.status,
          ...(runRecord ? { agentId: runRecord.agentId } : {}),
        },
      };
    } finally {
      // 拍板 #19: persist the terminal record (terminal status set above; an
      // exception path leaves "interrupted") and release the active marker.
      if (runRecord) {
        // An exception path never set a terminal status — that IS an
        // interruption (abort/crash), not a successful or failed run.
        runRecord.status = runStatus === "running" ? "interrupted" : runStatus;
        runRecord.report = runReport;
        runRecord.messages = finalMessages;
        if (runClaimed) {
          saveRun(context.workspaceRoot, runRecord);
          unmarkRunActive(context.sessionId, runRecord.agentId);
        }
      }
      // 拍板 #14-B: agent-scoped MCP connections live exactly one run.
      await agentMcpHandle?.close();
    }
  },

  formatResult: (result) =>
    result.error
      ? `Error: ${result.error}${result.content ? `\n${result.content}` : ""}`
      : result.content,

  async checkPermissions(_input, context) {
    // Plan mode: never spawn sub-agents (they run their own loop).
    if (context.permissionMode === "plan") {
      return {
        allowed: false,
        reason: "Plan mode: task tool is disabled.",
      };
    }
    return { allowed: true };
  },
});
