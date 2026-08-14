// ============================================================
// Vim Mode — operator execution (delete / change / yank, …)
// ============================================================

import { Cursor, lastGrapheme } from "./cursor.js";
import { isInclusiveMotion, isLinewiseMotion, resolveMotion } from "./motions.js";
import { findTextObject } from "./textObjects.js";
import type { FindType, Operator, RecordedChange, TextObjScope } from "./types.js";

function firstGrapheme(str: string): string {
  if (str.length === 0) return "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    str,
  )) {
    return segment;
  }
  return str[0] ?? "";
}

function countCharInString(str: string, char: string): number {
  let n = 0;
  for (let i = 0; i < str.length; i++) if (str[i] === char) n++;
  return n;
}

export type OperatorContext = {
  cursor: Cursor;
  text: string;
  setText: (text: string) => void;
  setOffset: (offset: number) => void;
  enterInsert: (offset: number) => void;
  getRegister: () => string;
  setRegister: (content: string, linewise: boolean) => void;
  getLastFind: () => { type: FindType; char: string } | null;
  setLastFind: (type: FindType, char: string) => void;
  recordChange: (change: RecordedChange) => void;
};

export function executeOperatorMotion(
  op: Operator,
  motion: string,
  count: number,
  ctx: OperatorContext,
): void {
  const target = resolveMotion(motion, ctx.cursor, count);
  if (target.equals(ctx.cursor)) return;
  const range = getOperatorRange(ctx.cursor, target, motion, op, count);
  applyOperator(op, range.from, range.to, ctx, range.linewise);
  ctx.recordChange({ type: "operator", op, motion, count });
}

export function executeOperatorFind(
  op: Operator,
  findType: FindType,
  char: string,
  count: number,
  ctx: OperatorContext,
): void {
  const targetOffset = ctx.cursor.findCharacter(char, findType, count);
  if (targetOffset === null) return;
  const target = new Cursor(ctx.text, targetOffset);
  const range = getOperatorRangeForFind(ctx.cursor, target);
  applyOperator(op, range.from, range.to, ctx);
  ctx.setLastFind(findType, char);
  ctx.recordChange({ type: "operatorFind", op, find: findType, char, count });
}

export function executeOperatorTextObj(
  op: Operator,
  scope: TextObjScope,
  objType: string,
  count: number,
  ctx: OperatorContext,
): void {
  const range = findTextObject(ctx.text, ctx.cursor.offset, objType, scope === "inner");
  if (!range) return;
  applyOperator(op, range.start, range.end, ctx);
  ctx.recordChange({ type: "operatorTextObj", op, objType, scope, count });
}

export function executeLineOp(op: Operator, count: number, ctx: OperatorContext): void {
  const text = ctx.text;
  const lines = text.split("\n");
  const currentLine = countCharInString(text.slice(0, ctx.cursor.offset), "\n");
  const linesToAffect = Math.min(count, lines.length - currentLine);
  const lineStart = ctx.cursor.startOfLogicalLine().offset;
  let lineEnd = lineStart;
  for (let i = 0; i < linesToAffect; i++) {
    const nextNewline = text.indexOf("\n", lineEnd);
    lineEnd = nextNewline === -1 ? text.length : nextNewline + 1;
  }

  let content = text.slice(lineStart, lineEnd);
  if (!content.endsWith("\n")) content = content + "\n";
  ctx.setRegister(content, true);

  if (op === "yank") {
    ctx.setOffset(lineStart);
  } else if (op === "delete") {
    let deleteStart = lineStart;
    const deleteEnd = lineEnd;
    if (deleteEnd === text.length && deleteStart > 0 && text[deleteStart - 1] === "\n") {
      deleteStart -= 1;
    }
    const newText = text.slice(0, deleteStart) + text.slice(deleteEnd);
    ctx.setText(newText || "");
    const maxOff = Math.max(0, newText.length - (lastGrapheme(newText).length || 1));
    ctx.setOffset(Math.min(deleteStart, maxOff));
  } else if (op === "change") {
    if (lines.length === 1) {
      ctx.setText("");
      ctx.enterInsert(0);
    } else {
      const beforeLines = lines.slice(0, currentLine);
      const afterLines = lines.slice(currentLine + linesToAffect);
      ctx.setText([...beforeLines, "", ...afterLines].join("\n"));
      ctx.enterInsert(lineStart);
    }
  }
  ctx.recordChange({ type: "operator", op, motion: op[0]!, count });
}

export function executeX(count: number, ctx: OperatorContext): void {
  const from = ctx.cursor.offset;
  if (from >= ctx.text.length) return;
  let endCursor = ctx.cursor;
  for (let i = 0; i < count && !endCursor.isAtEnd(); i++) endCursor = endCursor.right();
  const to = endCursor.offset;
  const deleted = ctx.text.slice(from, to);
  ctx.setRegister(deleted, false);
  ctx.setText(ctx.text.slice(0, from) + ctx.text.slice(to));
  ctx.setOffset(Math.min(from, ctx.text.length - (lastGrapheme(ctx.text).length || 1)));
  ctx.recordChange({ type: "x", count });
}

export function executeReplace(char: string, count: number, ctx: OperatorContext): void {
  let offset = ctx.cursor.offset;
  let newText = ctx.text;
  for (let i = 0; i < count && offset < newText.length; i++) {
    const graphemeLen = firstGrapheme(newText.slice(offset)).length || 1;
    newText = newText.slice(0, offset) + char + newText.slice(offset + graphemeLen);
    offset += char.length;
  }
  ctx.setText(newText);
  ctx.setOffset(Math.max(0, offset - char.length));
  ctx.recordChange({ type: "replace", char, count });
}

export function executeToggleCase(count: number, ctx: OperatorContext): void {
  const startOffset = ctx.cursor.offset;
  if (startOffset >= ctx.text.length) return;
  let newText = ctx.text;
  let offset = startOffset;
  let toggled = 0;
  while (offset < newText.length && toggled < count) {
    const grapheme = firstGrapheme(newText.slice(offset));
    const graphemeLen = grapheme.length;
    const toggledGrapheme =
      grapheme === grapheme.toUpperCase() ? grapheme.toLowerCase() : grapheme.toUpperCase();
    newText = newText.slice(0, offset) + toggledGrapheme + newText.slice(offset + graphemeLen);
    offset += toggledGrapheme.length;
    toggled++;
  }
  ctx.setText(newText);
  ctx.setOffset(offset);
  ctx.recordChange({ type: "toggleCase", count });
}

export function executeJoin(count: number, ctx: OperatorContext): void {
  const text = ctx.text;
  const lines = text.split("\n");
  const { line: currentLine } = ctx.cursor.getPosition();
  if (currentLine >= lines.length - 1) return;
  const linesToJoin = Math.min(count, lines.length - currentLine - 1);
  let joinedLine = lines[currentLine]!;
  const cursorPos = joinedLine.length;
  for (let i = 1; i <= linesToJoin; i++) {
    const nextLine = (lines[currentLine + i] ?? "").trimStart();
    if (nextLine.length > 0) {
      if (!joinedLine.endsWith(" ") && joinedLine.length > 0) joinedLine += " ";
      joinedLine += nextLine;
    }
  }
  const newLines = [
    ...lines.slice(0, currentLine),
    joinedLine,
    ...lines.slice(currentLine + linesToJoin + 1),
  ];
  ctx.setText(newLines.join("\n"));
  ctx.setOffset(getLineStartOffset(newLines, currentLine) + cursorPos);
  ctx.recordChange({ type: "join", count });
}

export function executePaste(after: boolean, count: number, ctx: OperatorContext): void {
  const register = ctx.getRegister();
  if (!register) return;
  const isLinewise = register.endsWith("\n");
  const content = isLinewise ? register.slice(0, -1) : register;

  if (isLinewise) {
    const lines = ctx.text.split("\n");
    const { line: currentLine } = ctx.cursor.getPosition();
    const insertLine = after ? currentLine + 1 : currentLine;
    const repeatedLines: string[] = [];
    for (let i = 0; i < count; i++) repeatedLines.push(...content.split("\n"));
    const newLines = [...lines.slice(0, insertLine), ...repeatedLines, ...lines.slice(insertLine)];
    ctx.setText(newLines.join("\n"));
    ctx.setOffset(getLineStartOffset(newLines, insertLine));
  } else {
    const textToInsert = content.repeat(count);
    const insertPoint =
      after && ctx.cursor.offset < ctx.text.length
        ? ctx.cursor.measuredText.nextOffset(ctx.cursor.offset)
        : ctx.cursor.offset;
    const newText = ctx.text.slice(0, insertPoint) + textToInsert + ctx.text.slice(insertPoint);
    ctx.setText(newText);
    ctx.setOffset(insertPoint + textToInsert.length - (lastGrapheme(textToInsert).length || 1));
  }
}

export function executeIndent(dir: ">" | "<", count: number, ctx: OperatorContext): void {
  const lines = ctx.text.split("\n");
  const { line: currentLine } = ctx.cursor.getPosition();
  const linesToAffect = Math.min(count, lines.length - currentLine);
  const indent = "  ";
  for (let i = 0; i < linesToAffect; i++) {
    const lineIdx = currentLine + i;
    const line = lines[lineIdx] ?? "";
    if (dir === ">") lines[lineIdx] = indent + line;
    else if (line.startsWith(indent)) lines[lineIdx] = line.slice(indent.length);
    else if (line.startsWith("\t")) lines[lineIdx] = line.slice(1);
    else {
      let removed = 0;
      while (removed < indent.length && removed < line.length && /\s/.test(line[removed]!)) {
        removed++;
      }
      lines[lineIdx] = line.slice(removed);
    }
  }
  const newText = lines.join("\n");
  const firstNonBlank = (lines[currentLine] ?? "").match(/^\s*/)?.[0].length ?? 0;
  ctx.setText(newText);
  ctx.setOffset(getLineStartOffset(lines, currentLine) + firstNonBlank);
  ctx.recordChange({ type: "indent", dir, count });
}

export function executeOpenLine(direction: "above" | "below", ctx: OperatorContext): void {
  const lines = ctx.text.split("\n");
  const { line: currentLine } = ctx.cursor.getPosition();
  const insertLine = direction === "below" ? currentLine + 1 : currentLine;
  const newLines = [...lines.slice(0, insertLine), "", ...lines.slice(insertLine)];
  ctx.setText(newLines.join("\n"));
  ctx.enterInsert(getLineStartOffset(newLines, insertLine));
  ctx.recordChange({ type: "openLine", direction });
}

export function executeOperatorG(op: Operator, count: number, ctx: OperatorContext): void {
  const target = count === 1 ? ctx.cursor.startOfLastLine() : ctx.cursor.goToLine(count);
  if (target.equals(ctx.cursor)) return;
  const range = getOperatorRange(ctx.cursor, target, "G", op, count);
  applyOperator(op, range.from, range.to, ctx, range.linewise);
  ctx.recordChange({ type: "operator", op, motion: "G", count });
}

export function executeOperatorGg(op: Operator, count: number, ctx: OperatorContext): void {
  const target = count === 1 ? ctx.cursor.startOfFirstLine() : ctx.cursor.goToLine(count);
  if (target.equals(ctx.cursor)) return;
  const range = getOperatorRange(ctx.cursor, target, "gg", op, count);
  applyOperator(op, range.from, range.to, ctx, range.linewise);
  ctx.recordChange({ type: "operator", op, motion: "gg", count });
}

// --- internal helpers ---

function getLineStartOffset(lines: string[], lineIndex: number): number {
  return lines.slice(0, lineIndex).join("\n").length + (lineIndex > 0 ? 1 : 0);
}

function getOperatorRange(
  cursor: Cursor,
  target: Cursor,
  motion: string,
  op: Operator,
  count: number,
): { from: number; to: number; linewise: boolean } {
  let from = Math.min(cursor.offset, target.offset);
  let to = Math.max(cursor.offset, target.offset);
  let linewise = false;

  if (op === "change" && (motion === "w" || motion === "W")) {
    let wordCursor = cursor;
    for (let i = 0; i < count - 1; i++) {
      wordCursor = motion === "w" ? wordCursor.nextVimWord() : wordCursor.nextWORD();
    }
    const wordEnd = motion === "w" ? wordCursor.endOfVimWord() : wordCursor.endOfWORD();
    to = cursor.measuredText.nextOffset(wordEnd.offset);
  } else if (isLinewiseMotion(motion)) {
    linewise = true;
    const nextNewline = cursor.text.indexOf("\n", to);
    if (nextNewline === -1) {
      to = cursor.text.length;
      if (from > 0 && cursor.text[from - 1] === "\n") from -= 1;
    } else {
      to = nextNewline + 1;
    }
  } else if (isInclusiveMotion(motion) && cursor.offset <= target.offset) {
    to = cursor.measuredText.nextOffset(to);
  }

  from = cursor.snapOutOfImageRef(from);
  to = cursor.snapOutOfImageRef(to);
  return { from, to, linewise };
}

function getOperatorRangeForFind(cursor: Cursor, target: Cursor): { from: number; to: number } {
  const from = Math.min(cursor.offset, target.offset);
  const maxOffset = Math.max(cursor.offset, target.offset);
  return { from, to: cursor.measuredText.nextOffset(maxOffset) };
}

function applyOperator(
  op: Operator,
  from: number,
  to: number,
  ctx: OperatorContext,
  linewise = false,
): void {
  let content = ctx.text.slice(from, to);
  if (linewise && !content.endsWith("\n")) content = content + "\n";
  ctx.setRegister(content, linewise);

  if (op === "yank") {
    ctx.setOffset(from);
  } else if (op === "delete") {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to);
    ctx.setText(newText);
    const maxOff = Math.max(0, newText.length - (lastGrapheme(newText).length || 1));
    ctx.setOffset(Math.min(from, maxOff));
  } else if (op === "change") {
    ctx.setText(ctx.text.slice(0, from) + ctx.text.slice(to));
    ctx.enterInsert(from);
  }
}
