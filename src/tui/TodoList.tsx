// ============================================================
// TodoList — pinned live todo projection (shared by App / FullScreenApp)
// ============================================================
// Renders the Todo tool's session state under the status line (first row
// carries the `⎿` connector). Long lists are WINDOWED around the in_progress
// item — the whole point of the display is seeing the active task, so a naive
// head-slice (which can hide it) is not acceptable. Hidden ranges collapse
// into "↑/↓ 还有 N 项" indicator rows; total height never exceeds 5 rows
// (the live-frame height invariant, see live-window.ts).
// ============================================================

import { Box, Text } from "ink";
import type { TodoDisplayItem } from "../types.js";
import { t } from "./i18n.js";
import { palette } from "./theme.js";

/** Max rows the region may occupy, indicator rows included. */
export const TODO_MAX_ROWS = 5;

export interface TodoWindow {
  /** The visible slice of `todos`. */
  items: TodoDisplayItem[];
  /** Index of items[0] in the original list. */
  offset: number;
  hiddenAbove: number;
  hiddenBelow: number;
}

/**
 * Choose the visible window for a todo list. Short lists pass through whole;
 * long lists show a window centered (as much as possible) on the in_progress
 * item, shrinking by one row when both overflow indicators are needed.
 */
export function todoWindow(todos: TodoDisplayItem[], maxRows: number = TODO_MAX_ROWS): TodoWindow {
  if (todos.length <= maxRows) {
    return { items: todos, offset: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }
  const focus = Math.max(
    0,
    todos.findIndex((t) => t.status === "in_progress"),
  );
  // Reserve one row for an overflow indicator; if the window ends up hidden on
  // BOTH sides, reserve a second one.
  let take = maxRows - 1;
  let start = Math.min(Math.max(0, focus - Math.floor(take / 2)), todos.length - take);
  if (start > 0 && start + take < todos.length) {
    take = maxRows - 2;
    start = Math.min(Math.max(0, focus - Math.floor(take / 2)), todos.length - take);
  }
  return {
    items: todos.slice(start, start + take),
    offset: start,
    hiddenAbove: start,
    hiddenBelow: todos.length - (start + take),
  };
}

/** One todo row. `prefix` carries the `⎿` connector on the region's first
 *  visible row (hanging from the status line above); other rows align under it. */
function TodoRow({ item, prefix }: { item: TodoDisplayItem; prefix: string }) {
  if (item.status === "completed") {
    return (
      <Text dimColor>
        {prefix}☑ <Text strikethrough>{item.content}</Text>
      </Text>
    );
  }
  if (item.status === "in_progress") {
    return (
      <Text>
        {prefix}
        <Text color={palette.accent}>■ </Text>
        {item.content}
        {item.activeForm ? <Text dimColor>{` — ${item.activeForm}`}</Text> : null}
      </Text>
    );
  }
  return <Text dimColor>{`${prefix}□ ${item.content}`}</Text>;
}

export function TodoList({ todos }: { todos: TodoDisplayItem[] }) {
  const { items, offset, hiddenAbove, hiddenBelow } = todoWindow(todos);
  // The ⎿ connector lives on the first VISIBLE row, whichever kind it is.
  let first = true;
  const takePrefix = () => {
    const p = first ? "  ⎿  " : "     ";
    first = false;
    return p;
  };
  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 ? (
        <Text dimColor>{`${takePrefix()}${t("ui.todo.moreAbove", { n: hiddenAbove })}`}</Text>
      ) : null}
      {items.map((t, i) => (
        // Rows are stateless Text, but key by identity (position in the full
        // list + content), not the window index, so reordering a todo doesn't
        // make React recycle the wrong row instance.
        <TodoRow key={`${offset + i}:${t.status}:${t.content}`} item={t} prefix={takePrefix()} />
      ))}
      {hiddenBelow > 0 ? (
        <Text dimColor>{`${takePrefix()}${t("ui.todo.moreBelow", { n: hiddenBelow })}`}</Text>
      ) : null}
    </Box>
  );
}
