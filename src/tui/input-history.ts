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

/**
 * #37: last-entry memo per history file. appendHistory used to re-read and
 * re-parse the WHOLE file on every submit just to check the consecutive-dup
 * rule — O(history) per keystroke-submit. The memo makes that O(1) in-process;
 * the first append after startup seeds it from an ≤8KB tail read (still
 * cross-session-correct), never a full parse.
 */
const lastEntryMemo = new Map<string, string>();

/** Read ONLY the last entry of a JSONL history file (≤8KB tail read).
 *  Returns null when the file is missing/empty/unparseable. */
function readLastEntry(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf-8").split("\n");
    // Scan upward past blank AND corrupt lines — loadHistory skips corrupt
    // lines too, so the "previous entry" must be the last VALID one for the
    // dup-collapse rule to match the file's readable content. (The first
    // line may be truncated by the 8KB window — a parse failure there just
    // ends the scan.)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { v?: unknown };
        if (typeof entry.v === "string" && entry.v.trim()) return entry.v;
      } catch {
        /* corrupt line — keep scanning upward */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Append one entry. Consecutive duplicates collapse; the file is created
 *  (with its directory) on demand. Best-effort: fs errors are swallowed —
 *  history persistence must never fail a submit. */
export function appendHistory(workspaceRoot: string, value: string): void {
  const v = value.trim();
  if (!v) return;
  try {
    const file = historyFile(workspaceRoot);
    let prev = lastEntryMemo.get(file);
    if (prev === undefined) {
      prev = readLastEntry(file) ?? "";
      lastEntryMemo.set(file, prev);
    }
    if (prev === v) return; // consecutive dup
    fs.mkdirSync(historyDir(workspaceRoot), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ v })}\n`, "utf-8");
    lastEntryMemo.set(file, v);
    // Review fix ("历史文件无界增长"): the read-back is capped at
    // HISTORY_LIMIT entries but the FILE itself grew forever. Compact once it
    // crosses a size threshold: keep the newest HISTORY_LIMIT entries and
    // rewrite atomically (tmp + rename — a crash mid-compact must not lose
    // the history). One stat per submit; rewrites are rare (≈ every
    // 2500 entries).
    const MAX_HISTORY_FILE_BYTES = 256 * 1024;
    if (fs.statSync(file).size > MAX_HISTORY_FILE_BYTES) {
      const kept = loadHistory(workspaceRoot); // newest HISTORY_LIMIT entries
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, kept.map((e) => `${JSON.stringify({ v: e })}\n`).join(""), "utf-8");
      fs.renameSync(tmp, file);
      lastEntryMemo.set(file, kept.at(-1) ?? v);
    }
  } catch {
    /* best-effort */
  }
}
