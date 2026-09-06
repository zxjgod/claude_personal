// ============================================================
// input-history — cross-session input history persistence (batch C5)
// ============================================================
// One JSONL file per project under the config home, mirroring the official
// history.ts contract:
//   • append-only, one JSON-encoded entry per line (multi-line drafts stay
//     single lines);
//   • consecutive duplicates collapse (the common re-submit);
//   • reads return oldest→newest so the InputBox's ↑ walks newest-first the
//     same way it walks the in-session array.
// The config home follows the persistence layer's convention
// (<workspace>/.claude) — history lives beside sessions, scoped per project
// root so different workspaces never mix.
// Pure fs helpers; no store/React imports. Errors degrade to "no history":
// a broken or unreadable file must never block the TUI.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

/** Cap on the in-memory (and read-back) history, matching the InputBox. */
export const HISTORY_LIMIT = 100;

function historyDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "history");
}

/** Stable per-project file name: a cheap path hash keeps roots with exotic
 *  characters (Windows drive letters, CJK) out of the file system layer. */
function historyFile(workspaceRoot: string): string {
  let h = 0;
  for (const ch of workspaceRoot) {
    h = (Math.imul(h, 31) + ch.codePointAt(0)!) | 0;
  }
  return path.join(historyDir(workspaceRoot), `${(h >>> 0).toString(36)}.jsonl`);
}

/** Load this project's saved history (oldest→newest). Missing/unreadable
 *  file → []. Corrupt lines are skipped, never thrown. */
export function loadHistory(workspaceRoot: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(historyFile(workspaceRoot), "utf-8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { v?: unknown };
      if (typeof entry.v === "string" && entry.v.trim()) out.push(entry.v);
    } catch {
      /* corrupt line — skip */
    }
  }
  return out.slice(-HISTORY_LIMIT);
}

/** Append one entry. Consecutive duplicates collapse; the file is created
 *  (with its directory) on demand. Best-effort: fs errors are swallowed —
 *  history persistence must never fail a submit. */
export function appendHistory(workspaceRoot: string, value: string): void {
  const v = value.trim();
  if (!v) return;
  try {
    const file = historyFile(workspaceRoot);
    const prev = loadHistory(workspaceRoot);
    if (prev.length > 0 && prev[prev.length - 1] === v) return; // consecutive dup
    fs.mkdirSync(historyDir(workspaceRoot), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ v })}\n`, "utf-8");
  } catch {
    /* best-effort */
  }
}
