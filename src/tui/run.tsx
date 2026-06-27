// ============================================================
// TUI runner — Ink render + REPL orchestration (9.1, 9.6)
// ============================================================
// The TTY counterpart to cli.ts's line-based while-loop. Owns the TuiStore,
// renders <App>, and drives one async-generator agent loop per submitted
// prompt, translating LoopEvents into store mutations. Slash commands run
// here too; their console.log output is captured into a transcript log item
// so it doesn't corrupt the Ink frame.
// ============================================================

import { render } from "ink";
import { useCallback, useState } from "react";
import { agentLoop } from "./../agent-loop.js";
import { formatCliError } from "./../cli-errors.js";
import type { CommandContext } from "./../commands.js";
import { handleSlashCommand } from "./../commands.js";
import { EFFORT_DESCRIPTIONS, getEffort } from "./../effort.js";
import { expandFileRefs } from "./../file-refs.js";
import { formatSpeculationLine } from "./../speculation.js";
import type {
  AskUserFn,
  HookRunner,
  Message,
  ModelCaller,
  ModelConfig,
  PermissionClassifier,
  PermissionMode,
  Tool,
  UserQuestion,
} from "./../types.js";
import { App } from "./App.js";
import { printBanner } from "./banner.js";
import { firstUserPreview, messagesToTranscript } from "./history-replay.js";
import type { CommandInfo } from "./InputBox.js";
import { type SessionPickerItem, TuiStore } from "./store.js";

export interface TuiDeps {
  messages: Message[];
  tools: Tool[];
  callModel: ModelCaller;
  modelConfig: ModelConfig;
  systemPrompt: string;
  workspaceRoot: string;
  sessionId: string;
  permissionMode: PermissionMode;
  commands: CommandInfo[];
  hooks?: HookRunner;
  makeCommandContext: () => CommandContext;
  alwaysAllow: Set<string>;
  permissionKey: (toolName: string, input: Record<string, unknown>) => string;
  /** M15.3: optional LLM permission classifier (opt-in via CLI flag). */
  permissionClassifier?: PermissionClassifier;
  onSave: () => void;
}

/** Run one user turn through the agent loop, pushing events into the store. */
async function runTurn(
  store: TuiStore,
  deps: TuiDeps,
  controller: AbortController,
  askUser: AskUserFn,
  askUserQuestion: (q: UserQuestion) => Promise<string[] | null>,
): Promise<void> {
  store.setBusy(true);
  store.setSpinner("thinking");

  // M18.12: append the session goal (if set) to this turn's system prompt.
  const goal = deps.makeCommandContext().goal?.value;
  const turnSystemPrompt = goal
    ? `${deps.systemPrompt}\n\n[SESSION GOAL]\nThe user set this objective for the session. Keep it in view and steer toward it:\n${goal}`
    : deps.systemPrompt;
  const loop = agentLoop(deps.messages, deps.tools, deps.callModel, deps.modelConfig, {
    systemPrompt: turnSystemPrompt,
    maxTurns: 50,
    toolContext: {
      workspaceRoot: deps.workspaceRoot,
      sessionId: deps.sessionId,
      permissionMode: deps.permissionMode,
      modelConfig: deps.modelConfig,
      askUserQuestion,
      // M15.3: thread the LLM permission classifier (when enabled) so flagged
      // dangerous calls get a model-assessed risk hint/block in the TUI too.
      permissionClassifier: deps.permissionClassifier,
      // Stream nested sub-agent (Task) activity into the transcript live, so
      // its Reads/Greps appear as they happen rather than dumping in a block
      // when the Task finishes.
      onSubAgentProgress: (ev) => {
        if (ev.phase === "tool_use") {
          const d = toolDetail(ev.input);
          store.addSubAgentActivity(
            `    ⎿ [${ev.subagentName}] ${capitalize(ev.toolName ?? "tool")}${d ? `(${truncate(d, 80)})` : ""}`,
          );
        } else if (ev.phase === "done") {
          store.addSubAgentActivity(`    ⎿ [${ev.subagentName}] done`);
        }
      },
    },
    askUser,
    abortSignal: controller.signal,
    hooks: deps.hooks,
  });

  let thinkingStart = Date.now();
  let thoughtReported = false;
  let streamedChars = 0;
  // Map tool-call id → its display detail, so the result card keeps the input
  // (filePath/command/…) the start card showed.
  const toolDetails = new Map<string, string>();

  try {
    for await (const event of loop) {
      switch (event.type) {
        case "thinking":
          thinkingStart = Date.now();
          thoughtReported = false;
          store.setSpinner("thinking");
          break;
        case "text_delta":
          if (!thoughtReported && thinkingStart > 0) {
            const secs = Math.max(1, Math.round((Date.now() - thinkingStart) / 1000));
            store.addThought(secs);
            thoughtReported = true;
          }
          store.setSpinner("responding");
          store.appendStreaming(event.delta);
          streamedChars += event.delta.length;
          store.setSpinnerTokens(Math.round(streamedChars / 4));
          break;
        case "tool_use": {
          store.commitStreaming();
          const detail = toolDetail(event.input);
          toolDetails.set(event.id, detail);
          store.startTool(event.name, detail, event.id);
          store.setSpinner("tool");
          break;
        }
        case "tool_result":
          // A single tool finished — commit it the instant it lands (this is
          // what keeps Reads in sync with the spinner instead of arriving as
          // one late batch).
          store.finishTool(event.result, toolDetails.get(event.id) ?? "", event.id);
          break;
        case "tool_results":
          // Batch boundary: every tool in this turn is done. Persist now.
          deps.onSave();
          break;
        case "usage":
          store.addUsage(event.usage.input_tokens, event.usage.output_tokens);
          break;
        case "compacting":
          store.addNotice("Compacting context…");
          break;
        case "error":
          store.commitStreaming();
          store.addNotice(`⎿ ${formatCliError(event.error)}`);
          break;
        case "aborted":
          store.commitStreaming();
          store.addNotice(`⎿ Aborted: ${event.reason}`);
          break;
        case "done":
          store.commitStreaming();
          // M15.2: surface speculation cost/benefit (only if prefetched anything).
          if (event.speculation) {
            const line = formatSpeculationLine(event.speculation);
            if (line) store.addNotice(line);
          }
          deps.onSave();
          break;
      }
    }
  } finally {
    store.setSpinner("idle");
    store.setSpinnerTokens(0);
    store.setBusy(false);
  }
}

function toolDetail(input?: Record<string, unknown>): string {
  if (!input) return "";
  for (const k of ["command", "filePath", "pattern", "url", "query"]) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return "";
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

/** Capture console.log output produced while `fn` runs, returning the lines. */
async function captureConsole<T>(
  fn: () => Promise<T> | T,
): Promise<{ lines: string[]; result: T }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  let result: T;
  try {
    result = await fn();
  } finally {
    console.log = orig;
  }
  return { lines, result };
}

/**
 * Drive the interactive /resume flow: list saved sessions, let the user pick
 * one from the scrollable overlay, then restore it. Restoration mutates the
 * live `messages` array in place (via the shared CommandContext.resumeSession)
 * and replays the prior conversation into the transcript — all without an LLM
 * call, so it costs zero tokens. The picked session also becomes the save
 * target for subsequent turns (resumeSession updates the REPL's sessionId).
 */
async function runResumePicker(store: TuiStore, deps: TuiDeps): Promise<void> {
  const ctx = deps.makeCommandContext();
  const persistence = ctx.persistence;
  if (!persistence || !ctx.resumeSession) {
    store.addNotice("  Session persistence is not available.");
    return;
  }

  const metas = await persistence.listSessions();
  if (metas.length === 0) {
    store.addNotice("  No saved sessions to resume.");
    return;
  }

  // Cap the picker so a huge history dir can't trigger hundreds of file reads
  // (metas are already sorted most-recent-first).
  const MAX_SHOWN = 50;
  const shown = metas.slice(0, MAX_SHOWN);

  const items: SessionPickerItem[] = [];
  for (const meta of shown) {
    // Load the full session only to surface a first-message preview; this is
    // local JSON and bounded by MAX_SHOWN.
    const data = await persistence.load(meta.sessionId);
    const preview = data ? firstUserPreview(data.messages) : "";
    const when = new Date(meta.updatedAt).toLocaleString();
    const plural = meta.messageCount === 1 ? "msg" : "msgs";
    items.push({
      sessionId: meta.sessionId,
      label: `${meta.sessionId.slice(0, 8)} · ${meta.messageCount} ${plural} · ${when} · ${meta.completed ? "done" : "open"}`,
      preview: preview || undefined,
      current: meta.sessionId === ctx.sessionId,
    });
  }

  const chosen = await store.pickSession(items);
  if (!chosen) {
    store.addNotice("  Resume cancelled.");
    return;
  }

  // Restore. resumeSession console.logs a one-liner; capture it so it doesn't
  // corrupt the Ink frame, then surface our own notice instead.
  const { result: ok } = await captureConsole(() => ctx.resumeSession!(chosen));
  if (!ok) {
    store.addNotice(`  Could not resume session ${chosen.slice(0, 8)}.`);
    return;
  }

  // `messages` was mutated in place by resumeSession — replay it on screen so
  // the restored conversation is visible and scrollable.
  const transcript = messagesToTranscript(deps.messages);
  store.addNotice(
    `  ── Resumed ${chosen.slice(0, 8)} · ${deps.messages.length} messages restored (0 tokens) ──`,
  );
  store.loadTranscript(transcript);
}

/**
 * Root that wires the InputBox submit handler to slash-command dispatch and
 * the agent loop, and installs a process-level SIGINT handler that aborts the
 * current turn (9.6) without tearing down the session.
 */
function Root({ store, deps }: { store: TuiStore; deps: TuiDeps }) {
  const [expandedId] = useState<number | null>(null);

  const askUser: AskUserFn = useCallback(
    async (tool, input, riskHint) => {
      const key = deps.permissionKey(tool.name, input);
      if (deps.alwaysAllow.has(key)) return true;
      const detail = toolDetail(input);
      const choice = await store.askPermission(
        `${tool.name[0]!.toUpperCase()}${tool.name.slice(1)} request`,
        detail || undefined,
        riskHint,
      );
      if (choice === "always") {
        deps.alwaysAllow.add(key);
        return true;
      }
      return choice === "yes";
    },
    [store, deps],
  );

  const askUserQuestion = useCallback(
    (q: UserQuestion) => store.askQuestion(q.header, q.question, q.options, q.multiSelect === true),
    [store],
  );

  const onSubmit = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      if (value.toLowerCase() === "exit" || value.toLowerCase() === "/exit") {
        // Tear down resources before exiting. Previously this was a bare
        // process.exit(0) that skipped onSave (session lost), MCP disconnect,
        // and LSP dispose. onSave() flushes the session; Ink unmounts on exit.
        try {
          deps.onSave();
        } catch {
          /* best-effort: don't block exit on a save failure */
        }
        // Give the (synchronous) save a tick to flush, then exit. The CLI's
        // top-level signal/cleanup handlers cover MCP/LSP teardown for the
        // process, but a prompt exit here avoids orphaned stdio children.
        setTimeout(() => process.exit(0), 50);
        return;
      }
      // Echo the user's input line once. For prompt-injecting slash commands
      // the echoed line is the command itself (e.g. "/review"); the injected
      // prompt is pushed only into `deps.messages`, not re-echoed.
      store.addUserMessage(value);

      void (async () => {
        // /effort with no args → open the interactive slider overlay (TUI).
        // With an arg (e.g. /effort max) it falls through to the static handler.
        if (/^\/effort\s*$/i.test(value)) {
          const options = (deps.modelConfig.options ??= {});
          const chosen = await store.askEffort(getEffort(options));
          if (chosen) {
            options.effort = chosen;
            store.addNotice(
              `  Effort: ${chosen} — ${EFFORT_DESCRIPTIONS[chosen]} (applies to the next turn)`,
            );
          }
          return;
        }

        // /resume with no args → open the interactive session picker overlay.
        // With an arg (e.g. /resume a1b2) it falls through to the static handler
        // which resolves the prefix directly. Selecting a session replays its
        // history into the transcript and costs no tokens (no LLM call).
        if (/^\/resume\s*$/i.test(value)) {
          await runResumePicker(store, deps);
          return;
        }

        // Slash commands run locally; capture their console output and read
        // the CommandResult in one dispatch (no double-execution). A command
        // may return `prompt` to inject a user message and run the loop
        // (/review /recap /fork /onboarding); otherwise it's fully local.
        let effectiveText: string | null = null;
        if (value.startsWith("/")) {
          const { lines, result } = await captureConsole(() =>
            handleSlashCommand(value, deps.makeCommandContext()),
          );
          if (lines.length > 0) store.addLog(lines);
          if (result.exit) return;
          if (result.handled && !result.prompt) return; // purely local command
          if (result.prompt) effectiveText = result.prompt;
        }

        // Determine the effective user text: either a prompt injected by a
        // slash command, or the raw input.
        const inputText = effectiveText ?? value;

        // Expand @file refs, then push the user message + run the loop.
        const { attachments, notes } = expandFileRefs(inputText, deps.workspaceRoot);
        for (const note of notes) store.addNotice(note);
        const contentText =
          attachments.length > 0 ? `${inputText}\n\n${attachments.join("\n\n")}` : inputText;
        deps.messages.push({ role: "user", content: [{ type: "text", text: contentText }] });

        const controller = new AbortController();
        const onSigint = () => controller.abort("用户中断");
        process.on("SIGINT", onSigint);
        try {
          await runTurn(store, deps, controller, askUser, askUserQuestion);
        } catch (err) {
          store.addNotice(`⎿ ${formatCliError(err)}`);
          store.setBusy(false);
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
      })().catch((err) => {
        // Floating async IIFE — without this, an internal throw becomes an
        // unhandled rejection that crashes the process with no UI feedback.
        store.addNotice(`⎿ ${formatCliError(err)}`);
        store.setBusy(false);
      });
    },
    [store, deps, askUser, askUserQuestion],
  );

  return (
    <App
      store={store}
      commands={deps.commands}
      onSubmit={onSubmit}
      expandedId={expandedId}
      editorMode={deps.makeCommandContext().editorMode}
    />
  );
}

/** Launch the Ink TUI. Resolves when the user exits. */
export function runTui(deps: TuiDeps): Promise<void> {
  // Print the startup banner once into scrollback (above Ink's live region).
  printBanner({
    version: "1.0.0",
    model: deps.modelConfig.model,
    provider: deps.modelConfig.provider,
    workspaceRoot: deps.workspaceRoot,
  });
  const store = new TuiStore(`${deps.modelConfig.provider}/${deps.modelConfig.model}`);
  const { waitUntilExit } = render(<Root store={store} deps={deps} />);
  return waitUntilExit() as Promise<void>;
}
