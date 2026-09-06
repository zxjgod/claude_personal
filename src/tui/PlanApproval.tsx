// ============================================================
// PlanApproval — the official "Ready to code?" panel (batch C2)
// ============================================================
// Rendered when the agent calls ExitPlanMode: the plan (markdown), the
// official prompt line, and three options:
//   1. Yes                     → approve (session flips to accept edits)
//   2. Edit in editor (ctrl+g) → revise the plan in $VISUAL/$EDITOR, then
//                                approve carries the EDITED plan back
//   3. No                      → reject (agent stays in plan mode)
// The panel colors itself with the official planMode teal.
// ============================================================

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { editInEditor } from "./open-editor.js";
import type { Overlay } from "./store.js";
import { palette } from "./theme.js";

const PLAN_COLOR = palette.modeColors.plan ?? "#4ec9b0";

export function PlanApproval({ overlay }: { overlay: Extract<Overlay, { kind: "planApproval" }> }) {
  // The plan mutates when the user revises it in the editor — approval must
  // carry the version they actually signed off on.
  const [plan, setPlan] = useState(overlay.plan);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);

  const options: Array<{ label: string; value: "yes" | "edit" | "no" }> = [
    { label: t("ui.plan.yes"), value: "yes" },
    { label: t("ui.plan.edit"), value: "edit" },
    { label: t("ui.plan.no"), value: "no" },
  ];

  const choose = (value: "yes" | "edit" | "no") => {
    if (value === "yes") {
      overlay.resolve({ choice: "approve", plan });
      return;
    }
    if (value === "no") {
      overlay.resolve({ choice: "reject", plan });
      return;
    }
    // Edit in $VISUAL/$EDITOR (official ctrl+g): the TTY hands over to the
    // child; on a clean exit the edited file becomes the plan under review.
    if (editing) return;
    setEditing(true);
    void editInEditor(plan).then(({ ok, text }) => {
      setEditing(false);
      if (ok) setPlan(text);
    });
  };

  useInput((input, key) => {
    if (editing) return; // the editor owns the TTY
    if (key.upArrow) setSelected((s) => (s - 1 + options.length) % options.length);
    else if (key.downArrow) setSelected((s) => (s + 1) % options.length);
    else if (key.return) choose(options[selected]!.value);
    else if (key.escape) choose("no");
    else if (input === "1") choose("yes");
    else if (input === "2") choose("edit");
    else if (input === "3") choose("no");
    else if (input === "y") choose("yes");
    else if (input === "n") choose("no");
    else if (key.ctrl && input === "g") choose("edit");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={PLAN_COLOR} paddingX={1}>
      <Text bold color={PLAN_COLOR}>
        {t("ui.plan.title")}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {renderMarkdown(plan)
          .split("\n")
          .slice(0, 15)
          .map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
      </Box>
      {editing ? (
        <Text dimColor italic>
          {`  ${t("ui.input.editorWaiting")}`}
        </Text>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text>{t("ui.plan.proceed")}</Text>
          {options.map((opt, i) => (
            <Text key={opt.value} color={i === selected ? PLAN_COLOR : undefined}>
              {i === selected ? "❯ " : "  "}
              {i + 1}. {opt.label}
            </Text>
          ))}
        </Box>
      )}
      <Text dimColor>{t("ui.plan.hint")}</Text>
    </Box>
  );
}
