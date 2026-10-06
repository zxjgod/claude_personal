import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { ZodError } from "zod";
import { loopStatusLines } from "../commands/loop.js";
import {
  currentLoop,
  loopArchive,
  pauseLoop,
  resumeLoop,
  stopLoop,
  subscribeLoop,
} from "../loop-runtime.js";
import { LOOP_PROFILES, type LoopConfig, type LoopProfile } from "../loop-settings.js";
import { InputBox } from "./InputBox.js";
import { wrapVisualLines } from "./live-window.js";
import { PromptOption, PromptPanel } from "./PromptPanel.js";
import type { Overlay } from "./store.js";
import { sanitizeTerminalText } from "./terminal-width.js";
import { palette } from "./theme.js";
import { useTerminalSize } from "./useTerminalSize.js";

type View = "main" | "status" | "limits" | "completion" | "retry" | "history" | "recovery";
interface SettingRow {
  label: string;
  value: string;
  key: keyof LoopConfig;
  choices?: Array<string | number | boolean | null>;
  input?: "number" | "text" | "lines";
}
function failureText(failure: unknown): string {
  return failure instanceof ZodError
    ? failure.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    : failure instanceof Error
      ? failure.message
      : String(failure);
}
const ACTIONS = [
  "Start task",
  "Status",
  "Pause",
  "Resume",
  "Stop",
  "Completion checks",
  "Retry & notifications",
  "History",
  "Limits & recovery",
];

function settingsRows(view: View, config: LoopConfig): SettingRow[] {
  if (view === "limits")
    return [
      {
        label: "Max rounds",
        key: "maxRounds",
        value: config.maxRounds === null ? "Continuous" : String(config.maxRounds),
        ...(config.profile === "scheduled" ? {} : { input: "number" as const }),
      },
      {
        label: "Token budget",
        key: "tokenBudget",
        value: config.tokenBudget ? config.tokenBudget.toLocaleString() : "Off",
        input: "number",
      },
      {
        label: "USD budget",
        key: "usdBudget",
        value: config.usdBudget ? `$${config.usdBudget}` : "Off",
        input: "number",
      },
      {
        label: "Main input / 1M",
        key: "inputPrice",
        value: config.inputPrice === null ? "Model default" : `$${config.inputPrice}`,
        input: "number",
      },
      {
        label: "Main output / 1M",
        key: "outputPrice",
        value: config.outputPrice === null ? "Model default" : `$${config.outputPrice}`,
        input: "number",
      },
    ];
  if (view === "completion")
    return [
      {
        label: "Verification",
        key: "completion",
        value: config.completion,
        choices: config.profile === "scheduled" ? ["continuous"] : ["model", "checks", "hybrid"],
      },
      {
        label: "Check commands",
        key: "commands",
        value: config.commands.length ? `${config.commands.length} configured` : "None",
        input: "lines",
      },
      {
        label: "Required files",
        key: "files",
        value: config.files.length ? `${config.files.length} configured` : "None",
        input: "lines",
      },
    ];
  if (view === "retry")
    return [
      {
        label: "Transient retries",
        key: "retryLimit",
        value: String(config.retryLimit),
        choices: [0, 1, 2, 3, 4, 5],
      },
      {
        label: "Notifications",
        key: "notifications",
        value: config.notifications,
        choices: ["important", "changes", "all"],
      },
      {
        label: "History entries",
        key: "historyLimit",
        value: String(config.historyLimit),
        choices: [25, 50, 100, 200, 500],
      },
    ];
  if (view === "recovery")
    return [
      {
        label: "Cadence",
        key: "cadence",
        value: config.cadence,
        choices: config.profile === "scheduled" ? ["fixed"] : ["adaptive", "fixed"],
      },
      {
        label: "On restore",
        key: "recovery",
        value: config.recovery,
        choices: ["confirm", "auto", "manual"],
      },
      {
        label: "Missed iterations",
        key: "missedRun",
        value: config.missedRun,
        choices: ["skip", "once", "confirm"],
      },
      { label: "Time zone", key: "timezone", value: config.timezone, input: "text" },
      {
        label: "Work hours",
        key: "workHours",
        value: config.workHours ? "On" : "Off",
        choices: [false, true],
      },
      {
        label: "Start hour",
        key: "startHour",
        value: `${String(config.startHour).padStart(2, "0")}:00`,
        choices: Array.from({ length: 24 }, (_, i) => i),
      },
      {
        label: "End hour",
        key: "endHour",
        value: `${String(config.endHour).padStart(2, "0")}:00`,
        choices: Array.from({ length: 24 }, (_, i) => i),
      },
      {
        label: "Weekdays only",
        key: "weekdaysOnly",
        value: config.weekdaysOnly ? "On" : "Off",
        choices: [false, true],
      },
    ];
  return [];
}

export function LoopMenu({ overlay }: { overlay: Extract<Overlay, { kind: "loopMenu" }> }) {
  const { columns, rows } = useTerminalSize();
  const [config, setConfig] = useState(overlay.config);
  const configRef = useRef(config);
  const applyConfig = (next: LoopConfig) => {
    configRef.current = next;
    setConfig(next);
  };
  const [view, setView] = useState<View>("main");
  const viewRef = useRef<View>("main");
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{
    field: keyof LoopConfig | "task";
    initial: string;
    kind: "number" | "text" | "lines";
  } | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  useEffect(
    () => subscribeLoop(overlay.scope, () => setRevision((value) => value + 1)),
    [overlay.scope],
  );
  void revision;
  const record = currentLoop(overlay.scope);
  const settingRows = settingsRows(view, config);
  const height = Math.max(2, rows - 11);
  const count = view === "main" ? ACTIONS.length + 2 : settingRows.length;
  const enterView = (next: View) => {
    viewRef.current = next;
    setView(next);
    cursorRef.current = 0;
    setCursor(0);
    setError("");
  };
  const change = (partial: Partial<LoopConfig>, profile = configRef.current.profile) => {
    try {
      applyConfig(overlay.onConfigure(profile, partial));
      setError("");
    } catch (failure) {
      setError(failureText(failure));
    }
  };
  const edit = (row: SettingRow) => {
    if (!row.input) return;
    const current = configRef.current[row.key];
    const initial = Array.isArray(current)
      ? current.join("\n")
      : current === null
        ? ""
        : String(current);
    setEditor({ field: row.key, initial, kind: row.input });
  };
  const commit = (value: string) => {
    const active = editorRef.current;
    if (!active) return;
    try {
      if (active.field === "task") {
        overlay.onStart(value);
        overlay.resolve();
        return;
      }
      const next =
        active.kind === "lines"
          ? value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
          : active.kind === "number"
            ? value.trim() === "" &&
              (active.field === "inputPrice" || active.field === "outputPrice")
              ? null
              : Number(value)
            : value.trim();
      applyConfig(overlay.onConfigure(configRef.current.profile, { [active.field]: next }));
      setEditor(null);
      setError("");
    } catch (failure) {
      setError(failureText(failure));
    }
  };
  const act = (index: number) => {
    try {
      if (index === 0) {
        setEditor({ field: "task", initial: "", kind: "text" });
      } else if (index === 1) enterView("status");
      else if (index === 2) {
        pauseLoop(overlay.scope);
        enterView("status");
      } else if (index === 3) {
        resumeLoop(overlay.scope);
        overlay.resolve();
      } else if (index === 4) {
        stopLoop(overlay.scope);
        enterView("status");
      } else if (index === 5) enterView("completion");
      else if (index === 6) enterView("retry");
      else if (index === 7) enterView("history");
      else if (index === 8) enterView("limits");
    } catch (failure) {
      setError(failureText(failure));
    }
  };
  const readLines =
    view === "status"
      ? loopStatusLines(overlay.scope)
      : view === "history"
        ? [
            ...(record?.history.map(
              (entry) =>
                `${new Date(entry.at).toLocaleTimeString()} · #${entry.round} ${entry.event}\n${entry.summary}`,
            ) ?? ["No loop history."]),
            ...loopArchive(overlay.scope).map(
              (previous) =>
                `${LOOP_PROFILES[previous.config.profile].name}: ${previous.status} · ${previous.objective}`,
            ),
          ]
        : [];
  const displayLines = readLines.flatMap((line) =>
    wrapVisualLines(sanitizeTerminalText(line), Math.max(10, columns - 6)),
  );

  useInput((input, key) => {
    const activeView = viewRef.current;
    const activeRows = settingsRows(activeView, configRef.current);
    if (editorRef.current) {
      if (key.escape) {
        setEditor(null);
        setError("");
      }
      return;
    }
    if (key.escape) {
      if (viewRef.current === "main") overlay.resolve();
      else enterView("main");
      return;
    }
    if (activeView === "status" || activeView === "history") {
      if (key.return) return enterView("main");
      let next = cursorRef.current;
      if (key.downArrow) next++;
      else if (key.upArrow) next--;
      else if (key.pageDown) next += height;
      else if (key.pageUp) next -= height;
      else if (key.home) next = 0;
      else if (key.end) next = displayLines.length - height;
      else return;
      next = Math.max(0, Math.min(next, Math.max(0, displayLines.length - height)));
      cursorRef.current = next;
      setCursor(next);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const next = Math.max(
        0,
        Math.min(
          (activeView === "main" ? ACTIONS.length + 2 : activeRows.length) - 1,
          cursorRef.current + (key.upArrow ? -1 : 1),
        ),
      );
      cursorRef.current = next;
      setCursor(next);
      return;
    }
    if (activeView === "main") {
      if (/^[1-9]$/.test(input)) return act(Number(input) - 1);
      if ((key.leftArrow || key.rightArrow) && cursorRef.current === 0) {
        const profiles = Object.keys(LOOP_PROFILES) as LoopProfile[];
        change(
          {},
          profiles[
            (profiles.indexOf(configRef.current.profile) +
              (key.leftArrow ? -1 : 1) +
              profiles.length) %
              profiles.length
          ],
        );
      } else if ((key.leftArrow || key.rightArrow) && cursorRef.current === 1)
        change({
          intervalMinutes: Math.max(
            3,
            Math.min(30, configRef.current.intervalMinutes + (key.leftArrow ? -1 : 1)),
          ),
        });
      else if (key.return && cursorRef.current >= 2) act(cursorRef.current - 2);
      return;
    }
    if (key.tab && activeView === "limits") return enterView("recovery");
    if (key.tab && activeView === "recovery") return enterView("limits");
    const row = activeRows[cursorRef.current];
    if (!row) return;
    if (key.return && row.input) return edit(row);
    if ((key.leftArrow || key.rightArrow) && row.choices && row.choices.length > 1) {
      const value =
        row.choices[
          (row.choices.indexOf(configRef.current[row.key] as string | number | boolean | null) +
            (key.leftArrow ? -1 : 1) +
            row.choices.length) %
            row.choices.length
        ];
      change({ [row.key]: value });
    }
  });

  const selectedProfile = LOOP_PROFILES[config.profile];
  const titles = {
    main: "Loop",
    status: "Loop status",
    limits: "Loop limits",
    completion: "Completion checks",
    retry: "Retry & notifications",
    history: "Execution history",
    recovery: "Recovery & schedule",
  };
  const start = Math.max(0, cursor - height + 1);
  return (
    <PromptPanel
      title={
        editor
          ? editor.field === "task"
            ? "Start loop task"
            : `Edit ${editor.field}`
          : titles[view]
      }
      subtitle={`${selectedProfile.name} · ${selectedProfile.description}`}
      footer={
        editor
          ? "Enter save · Ctrl+J newline · Esc back"
          : view === "limits" || view === "recovery"
            ? "←/→ change · Enter edit · Tab limits/schedule · Esc back"
            : "↑↓ select · ←/→ change · Enter choose · Esc back"
      }
    >
      {editor ? (
        <Box flexDirection="column" marginTop={1}>
          <InputBox
            commands={[]}
            disabled={false}
            onSubmit={commit}
            preserveDraftOnSubmit
            maxVisibleRows={Math.max(2, Math.min(5, rows - 13))}
            maxColumns={Math.max(8, columns - 5)}
            initialDraft={{ text: editor.initial, cursor: editor.initial.length }}
          />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {view === "main" ? (
            <>
              <Text color={record?.status === "running" ? palette.success : palette.secondary}>
                {record
                  ? `${LOOP_PROFILES[record.config.profile].name} · ${record.status} · round ${record.rounds}/${record.config.maxRounds ?? "continuous"}`
                  : "No active loop"}
              </Text>
              <Box height={1} />
              {Array.from({ length: Math.min(count, height) }, (_, i) => i + start).map((index) =>
                index === 0 ? (
                  <Text
                    key="profile"
                    color={cursor === index ? palette.promptAccent : palette.secondary}
                  >
                    {`${cursor === index ? "> " : "  "}New profile  `}
                    {(columns < 90
                      ? [config.profile]
                      : (Object.keys(LOOP_PROFILES) as LoopProfile[])
                    ).map((profile) => (
                      <Text
                        key={profile}
                        bold={config.profile === profile}
                        color={
                          config.profile === profile ? palette.promptAccent : palette.secondary
                        }
                      >{`${config.profile === profile ? "[" : " "}${LOOP_PROFILES[profile].name}${config.profile === profile ? "]" : " "} `}</Text>
                    ))}
                  </Text>
                ) : index === 1 ? (
                  <Text
                    key="interval"
                    color={cursor === index ? palette.promptAccent : palette.secondary}
                  >{`${cursor === index ? "> " : "  "}Interval     ‹ ${config.intervalMinutes} min ›`}</Text>
                ) : (
                  <PromptOption key={index} index={index - 2} selected={cursor === index}>
                    {ACTIONS[index - 2]}
                  </PromptOption>
                ),
              )}
            </>
          ) : view === "status" || view === "history" ? (
            displayLines.slice(cursor, cursor + height).map((line, index) => (
              <Text key={cursor + index} color={palette.secondary}>
                {line || " "}
              </Text>
            ))
          ) : (
            settingRows
              .slice(start, start + height)
              .map((row, index) => (
                <Text
                  key={row.key}
                  color={cursor === start + index ? palette.promptAccent : palette.secondary}
                >{`${cursor === start + index ? "> " : "  "}${row.label.padEnd(21)}${row.value}`}</Text>
              ))
          )}
        </Box>
      )}
      {error ? <Text color={palette.error}>{sanitizeTerminalText(error)}</Text> : null}
    </PromptPanel>
  );
}
