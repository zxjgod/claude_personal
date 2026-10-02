import { Box, Text, useInput } from "ink";
import { type ReactNode, useState } from "react";
import { stripAnsi } from "./terminal-width.js";
import { palette } from "./theme.js";

const requestKeys = new WeakMap<object, number>();
let nextRequestKey = 0;
/** A queued interaction starts with fresh selection/editor state, even for identical text. */
export function promptRequestKey(request: object): number {
  let key = requestKeys.get(request);
  if (key === undefined) {
    key = ++nextRequestKey;
    requestKeys.set(request, key);
  }
  return key;
}

/** Shared open dialog: one thin rule, a title, readable body and a quiet footer. */
export function PromptPanel({
  title,
  subtitle,
  children,
  footer,
  color = palette.promptAccent,
}: {
  title: ReactNode;
  subtitle?: string;
  children: ReactNode;
  footer: ReactNode;
  color?: string;
}) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        borderStyle="single"
        borderColor={color}
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        height={1}
        width="100%"
      />
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={color}>
          {title}
        </Text>
        {subtitle ? <Text>{subtitle}</Text> : null}
        {children}
        <Box marginTop={1}>
          <Text color={palette.secondary}>{footer}</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function PromptOption({
  index,
  selected,
  children,
  prefix = "",
  color = palette.promptAccent,
}: {
  index: number;
  selected: boolean;
  children: ReactNode;
  prefix?: string;
  color?: string;
}) {
  return (
    <Text>
      <Text color={selected ? color : palette.secondary}>{selected ? "> " : "  "}</Text>
      <Text color={palette.secondary}>{index + 1}. </Text>
      <Text color={selected ? color : undefined}>
        {prefix}
        {children}
      </Text>
    </Text>
  );
}

/** A small inline editor for amended answers; code points keep CJK/emoji intact. */
export function PromptAnswerInput({
  onSubmit,
  onCancel,
}: {
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [buffer, setBuffer] = useState({ chars: [] as string[], cursor: 0 });
  useInput((input, key) => {
    if (key.tab && key.shift) return; // permission dialog owns mode cycling
    if (key.escape || key.tab || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }
    if (key.return) {
      const value = buffer.chars.join("").trim();
      if (value) onSubmit(value);
      return;
    }
    if (key.ctrl && input === "u") {
      setBuffer({ chars: [], cursor: 0 });
      return;
    }
    if (key.ctrl || key.meta) return;
    setBuffer((current) => {
      const { cursor, chars } = current;
      if (key.leftArrow) return { chars, cursor: Math.max(0, cursor - 1) };
      if (key.rightArrow) return { chars, cursor: Math.min(chars.length, cursor + 1) };
      if (key.home) return { chars, cursor: 0 };
      if (key.end) return { chars, cursor: chars.length };
      if (key.backspace)
        return cursor > 0
          ? { chars: [...chars.slice(0, cursor - 1), ...chars.slice(cursor)], cursor: cursor - 1 }
          : current;
      if (key.delete)
        return { chars: [...chars.slice(0, cursor), ...chars.slice(cursor + 1)], cursor };
      if (key.upArrow || key.downArrow) return current;
      const inserted = Array.from(stripAnsi(input).replace(/[\x00-\x1f\x7f]/g, " "));
      return inserted.length
        ? {
            chars: [...chars.slice(0, cursor), ...inserted, ...chars.slice(cursor)],
            cursor: cursor + inserted.length,
          }
        : current;
    });
  });
  return (
    <Box marginTop={1}>
      <Text color={palette.promptAccent}>{"> "}</Text>
      <Text>
        {buffer.chars.slice(0, buffer.cursor).join("")}
        <Text inverse>{buffer.chars[buffer.cursor] ?? " "}</Text>
        {buffer.chars.slice(buffer.cursor + 1).join("")}
      </Text>
    </Box>
  );
}
