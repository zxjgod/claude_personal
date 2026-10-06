import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { t } from "./i18n.js";
import { PromptOption, PromptPanel } from "./PromptPanel.js";
import type { Overlay, RewindAction, RewindEntry } from "./store.js";
import { truncateVisual } from "./terminal-width.js";
import { palette } from "./theme.js";
import { useTerminalSize } from "./useTerminalSize.js";

type Action = { value: RewindAction | "nevermind"; labelKey: string };

function actionsFor(entry: RewindEntry): Action[] {
  const code = entry.canRestoreCode !== false && entry.filesChanged > 0;
  return [
    ...(code ? [{ value: "both" as const, labelKey: "ui.rewind.both" }] : []),
    { value: "conversation", labelKey: "ui.rewind.conversation" },
    ...(code ? [{ value: "code" as const, labelKey: "ui.rewind.code" }] : []),
    { value: "summarize", labelKey: "ui.rewind.summarize" },
    { value: "summarize_up_to", labelKey: "ui.rewind.summarizeUpTo" },
    { value: "nevermind", labelKey: "ui.rewind.nevermind" },
  ];
}

function relativeTime(entry: RewindEntry): string {
  if (entry.timestampMs === undefined) return entry.timestamp;
  const seconds = Math.max(0, Math.floor((Date.now() - entry.timestampMs) / 1000));
  if (seconds < 60) return t("ui.rewind.secondsAgo", { n: seconds });
  if (seconds < 3600) return t("ui.rewind.minutesAgo", { n: Math.floor(seconds / 60) });
  return t("ui.rewind.hoursAgo", { n: Math.floor(seconds / 3600) });
}

export function RewindPicker({ overlay }: { overlay: Extract<Overlay, { kind: "rewind" }> }) {
  const entries = [...overlay.entries].sort((a, b) => a.turnIndex - b.turnIndex);
  const { columns, rows } = useTerminalSize();
  const [cursor, setCursor] = useState(entries.length);
  const cursorRef = useRef(entries.length);
  const [chosen, setChosen] = useState<RewindEntry | null>(null);
  const chosenRef = useRef<RewindEntry | null>(null);
  const [actionCursor, setActionCursor] = useState(0);
  const actionCursorRef = useRef(0);
  const [contexts, setContexts] = useState<Record<string, string>>({});
  const [editingContext, setEditingContext] = useState(false);
  const windowSize = Math.max(2, Math.floor((rows - 10) / 3));
  const total = entries.length + 1;
  const start = Math.max(0, Math.min(cursor - Math.floor(windowSize / 2), total - windowSize));
  const end = Math.min(total, start + windowSize);
  const actions = chosen ? actionsFor(chosen) : [];
  const selectedAction = actions[actionCursor]?.value;
  const summarySelected = selectedAction === "summarize" || selectedAction === "summarize_up_to";
  const previewWidth = Math.max(8, columns - 8);

  const goBack = () => {
    chosenRef.current = null;
    setChosen(null);
    setEditingContext(false);
  };

  useInput((input, key) => {
    if (overlay.processing) return;
    const entry = chosenRef.current;
    if (entry) {
      const options = actionsFor(entry);
      const action = options[actionCursorRef.current]?.value;
      const pick = (index: number) => {
        const selected = options[index]?.value;
        if (!selected) return;
        if (selected === "nevermind") return goBack();
        const context = contexts[selected]?.trim();
        overlay.resolve({
          turnIndex: entry.turnIndex,
          action: selected,
          ...(context ? { context } : {}),
        });
      };
      if (editingContext && (action === "summarize" || action === "summarize_up_to")) {
        if (key.escape || key.tab) setEditingContext(false);
        else if (key.return) pick(actionCursorRef.current);
        else if (key.backspace || key.delete)
          setContexts((value) => ({
            ...value,
            [action]: Array.from(value[action] ?? "")
              .slice(0, -1)
              .join(""),
          }));
        else if (key.ctrl && input === "u") setContexts((value) => ({ ...value, [action]: "" }));
        else if (input && !key.ctrl && !key.meta)
          setContexts((value) => ({ ...value, [action]: (value[action] ?? "") + input }));
        return;
      }
      if (key.upArrow || key.downArrow) {
        const next =
          (actionCursorRef.current + (key.upArrow ? -1 : 1) + options.length) % options.length;
        actionCursorRef.current = next;
        setActionCursor(next);
      } else if (key.return) pick(actionCursorRef.current);
      else if (/^[1-9]$/.test(input)) pick(Number.parseInt(input, 10) - 1);
      else if (key.escape || key.backspace) goBack();
      else if (key.tab && (action === "summarize" || action === "summarize_up_to"))
        setEditingContext(true);
      else if (
        input &&
        !key.ctrl &&
        !key.meta &&
        (action === "summarize" || action === "summarize_up_to")
      ) {
        setEditingContext(true);
        setContexts((value) => ({ ...value, [action]: (value[action] ?? "") + input }));
      }
      return;
    }

    let next = cursorRef.current;
    if (key.upArrow) next--;
    else if (key.downArrow) next++;
    else if (key.pageUp) next -= windowSize;
    else if (key.pageDown) next += windowSize;
    else if (key.home) next = 0;
    else if (key.end) next = entries.length;
    else if (key.return) {
      const selected = entries[cursorRef.current];
      if (!selected) return overlay.resolve(null);
      chosenRef.current = selected;
      setChosen(selected);
      actionCursorRef.current = 0;
      setActionCursor(0);
      return;
    } else if (key.escape) return overlay.resolve(null);
    else return;
    next = Math.max(0, Math.min(entries.length, next));
    cursorRef.current = next;
    setCursor(next);
  });

  let explanation = t("ui.rewind.forked");
  if (selectedAction === "summarize") explanation = t("ui.rewind.afterSummarized");
  else if (selectedAction === "summarize_up_to") explanation = t("ui.rewind.beforeSummarized");
  else if (selectedAction === "code" || selectedAction === "nevermind")
    explanation = t("ui.rewind.conversationUnchanged");

  if (overlay.processing) {
    return (
      <PromptPanel title={t("ui.rewind.title")} footer={null}>
        <Box marginTop={1}>
          <Text color={palette.secondary}>
            {t(
              overlay.processing === "summarize" || overlay.processing === "summarize_up_to"
                ? "ui.rewind.summarizing"
                : "ui.rewind.restoring",
            )}
          </Text>
        </Box>
      </PromptPanel>
    );
  }

  return (
    <PromptPanel
      title={t("ui.rewind.title")}
      footer={chosen ? null : <Text italic>{t("ui.rewind.hint")}</Text>}
    >
      <Box marginTop={1} flexDirection="column">
        <Text>{t(chosen ? "ui.rewind.confirm" : "ui.rewind.description")}</Text>
        {chosen ? (
          <>
            <Box
              marginTop={1}
              flexDirection="column"
              borderStyle="single"
              borderColor={palette.secondary}
              borderTop={false}
              borderBottom={false}
              borderRight={false}
              paddingLeft={1}
            >
              <Text color={palette.userText}>{truncateVisual(chosen.label, previewWidth)}</Text>
              <Text color={palette.secondary}>
                {relativeTime(chosen) ? `(${relativeTime(chosen)})` : " "}
              </Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color={palette.secondary}>{explanation}</Text>
              {!summarySelected ? (
                <Text color={palette.secondary}>
                  {selectedAction === "both" || selectedAction === "code"
                    ? t("ui.rewind.codeRestored", { n: chosen.filesChanged })
                    : t("ui.rewind.codeUnchanged")}
                </Text>
              ) : null}
            </Box>
            <Box marginTop={1} flexDirection="column">
              {actions.map((action, index) => (
                <PromptOption key={action.value} index={index} selected={index === actionCursor}>
                  {t(action.labelKey)}
                  {contexts[action.value] ? `: ${contexts[action.value]}` : ""}
                </PromptOption>
              ))}
              {summarySelected && editingContext ? (
                <Text color={palette.secondary}>
                  {`${t("ui.rewind.context")}: ${contexts[selectedAction] ?? ""}`}
                  <Text inverse> </Text>
                </Text>
              ) : null}
            </Box>
          </>
        ) : (
          <Box marginTop={1} flexDirection="column">
            {start > 0 ? (
              <Text color={palette.secondary}>{t("ui.suggest.moreAbove", { n: start })}</Text>
            ) : null}
            {Array.from({ length: end - start }, (_, offset) => {
              const index = start + offset;
              const entry = entries[index];
              const selected = index === cursor;
              return (
                <Box key={entry?.turnIndex ?? "current"} marginBottom={1} flexDirection="column">
                  <Text color={selected ? palette.promptAccent : palette.text} italic={!entry}>
                    {`${selected ? "> " : "  "}${entry ? truncateVisual(entry.label, previewWidth) : t("ui.rewind.current")}`}
                  </Text>
                  {entry ? (
                    <Text
                      color={palette.secondary}
                    >{`  ${entry.filesChanged > 0 ? t("ui.rewind.filesChanged", { n: entry.filesChanged }) : t(entry.checkpointAvailable === false ? "ui.rewind.noRestore" : "ui.rewind.noChanges")}`}</Text>
                  ) : null}
                </Box>
              );
            })}
            {end < total ? (
              <Text color={palette.secondary}>{t("ui.suggest.moreBelow", { n: total - end })}</Text>
            ) : null}
          </Box>
        )}
      </Box>
    </PromptPanel>
  );
}
