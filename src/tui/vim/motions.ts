// ============================================================
// Vim Mode — motion resolution (pure)
// ============================================================

import type { Cursor } from "./cursor.js";

export function resolveMotion(key: string, cursor: Cursor, count: number): Cursor {
  let result = cursor;
  for (let i = 0; i < count; i++) {
    const next = applySingleMotion(key, result);
    if (next.equals(result)) break;
    result = next;
  }
  return result;
}

function applySingleMotion(key: string, cursor: Cursor): Cursor {
  switch (key) {
    case "h":
      return cursor.left();
    case "l":
      return cursor.right();
    case "j":
      return cursor.downLogicalLine();
    case "k":
      return cursor.upLogicalLine();
    case "gj":
      return cursor.downLogicalLine();
    case "gk":
      return cursor.upLogicalLine();
    case "w":
      return cursor.nextVimWord();
    case "b":
      return cursor.prevVimWord();
    case "e":
      return cursor.endOfVimWord();
    case "W":
      return cursor.nextWORD();
    case "B":
      return cursor.prevWORD();
    case "E":
      return cursor.endOfWORD();
    case "0":
      return cursor.startOfLogicalLine();
    case "^":
      return cursor.firstNonBlankInLogicalLine();
    case "$":
      return cursor.endOfLogicalLine();
    case "G":
      return cursor.startOfLastLine();
    default:
      return cursor;
  }
}

export function isInclusiveMotion(key: string): boolean {
  return "eE$".includes(key);
}

export function isLinewiseMotion(key: string): boolean {
  // G is linewise; gg is handled separately; gj/gk are characterwise.
  return key === "G";
}
