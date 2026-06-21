// ============================================================
// TUI runner — Ink render + REPL orchestration (9.1, 9.6)
// ============================================================
// The TTY counterpart to cli.ts's line-based while-loop. Owns the TuiStore,
// renders <App>, and drives one async-generator agent loop per submitted
// prompt, translating LoopEvents into store mutations. Slash commands run
// here too; their console.log output is captured into a transcript log item
// so it doesn't corrupt the Ink frame.
// ============================================================

import React, { useState, useCallback } from "react";
import { render } from "ink";
import { agentLoop } from "./../agent-loop.js";
import { handleSlashCommand } from "./../commands.js";
import type { CommandContext } from "./../commands.js";
import { expandFileRefs } from "./../file-refs.js";
import { getEffort, EFFORT_DESCRIPTIONS } from "./../effort.js";
import { App } from "./App.js";
import { TuiStore } from "./store.js";
import { printBanner } from "./banner.js";
import type { CommandInfo } from "./InputBox.js";
import { formatCliError } from "./../cli-errors.js";
import type {
  AskUserFn,
  Message,
  ModelCaller,
  ModelConfig,
  PermissionMode,
  Tool,
  UserQuestion,
} from "./../types.js";
import type { HookRunner } from "./../types.js";

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

  const loop = agentLoop(deps.messages, deps.tools, deps.callModel, deps.modelConfig, {
    systemPrompt: deps.systemPrompt,
    maxTurns: 50,
    toolContext: {
      workspaceRoot: deps.workspaceRoot,
      sessionId: deps.sessionId,
      permissionMode: deps.permissionMode,
      modelConfig: deps.modelConfig,
      askUserQuestion,
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
async function captureConsole(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
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
        process.exit(0);
      }
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

        // Slash commands run locally; capture their console output.
        if (value.startsWith("/")) {
          const lines = await captureConsole(async () => {
            await handleSlashCommand(value, deps.makeCommandContext());
          });
          if (lines.length > 0) store.addLog(lines);
          return;
        }

        // Expand @file refs, then push the user message + run the loop.
        const { attachments, notes } = expandFileRefs(value, deps.workspaceRoot);
        for (const note of notes) store.addNotice(note);
        const contentText =
          attachments.length > 0 ? `${value}\n\n${attachments.join("\n\n")}` : value;
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
      })();
    },
    [store, deps, askUser, askUserQuestion],
  );

  return <App store={store} commands={deps.commands} onSubmit={onSubmit} expandedId={expandedId} />;
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

