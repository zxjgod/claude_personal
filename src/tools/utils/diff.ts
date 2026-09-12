// ============================================================
// Diff Utilities for Tools
// ============================================================

/** One changed line, carrying the position it came from in each file. */
interface RawChange {
  sign: "-" | "+";
  text: string;
  /** 0-based index in the OLD fragment (where a `-` line was removed). */
  oldIndex: number;
  /** 0-based index in the NEW fragment (where a `+` line was inserted). */
  newIndex: number;
}

/**
 * Run the LCS over two line arrays and return the changed lines in diff order,
 * each tagged with both fragments' positions.
 *
 * The positions matter: unchanged lines are SKIPPED in the output, so a caller
 * can't recover them by counting rendered lines — the walk has to record where
 * each change actually sat. Shared by the model-facing diff (which ignores the
 * indices) and the display-only numbered diff (which needs them).
 */
function lcsChanges(oldLines: string[], newLines: string[]): RawChange[] {
  const m = oldLines.length;
  const n = newLines.length;
  // dp[i][j] = LCS length of oldLines[i:] and newLines[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: RawChange[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ sign: "-", text: oldLines[i]!, oldIndex: i, newIndex: j });
      i++;
    } else {
      out.push({ sign: "+", text: newLines[j]!, oldIndex: i, newIndex: j });
      j++;
    }
  }
  while (i < m) {
    out.push({ sign: "-", text: oldLines[i]!, oldIndex: i, newIndex: j });
    i++;
  }
  while (j < n) {
    out.push({ sign: "+", text: newLines[j]!, oldIndex: i, newIndex: j });
    j++;
  }
  return out;
}

/**
 * Build a unified-diff-style summary of the change using a real LCS over
 * lines. The previous implementation judged each line by set membership
 * (`!newLines.includes(line)`), which silently dropped moved or duplicated
 * lines and produced misleading output that could fool the model about what
 * actually changed. The LCS-based approach emits `-`/`+` hunks that reflect
 * the true per-line edit, so moved blocks show as a delete+insert pair and
 * duplicates are counted individually.
 */
export function generateSimpleDiff(oldStr: string, newStr: string): string {
  const changes = lcsChanges(oldStr.split("\n"), newStr.split("\n"));
  return changes.map((c) => `${c.sign} ${c.text}`).join("\n") || "(whitespace-only change)";
}

/** A changed line plus the absolute line number to show beside it. */
export interface DiffDisplayLine {
  sign: "-" | "+";
  text: string;
  /** 1-based: the line in the ORIGINAL file for `-`, in the EDITED file for `+`. */
  line: number;
}

/**
 * The same change set as generateSimpleDiff, but each line carries the absolute
 * file line number to render in the gutter — `startLine` being the 1-based line
 * of the edited region in the original file.
 *
 * This is DISPLAY-ONLY and deliberately separate from generateSimpleDiff: that
 * string is the model-facing tool result, and adding a gutter to it would change
 * what the model reads. The renderer opts in by consuming this via metadata.
 */
export function diffDisplayLines(oldStr: string, newStr: string, startLine = 1): DiffDisplayLine[] {
  return lcsChanges(oldStr.split("\n"), newStr.split("\n")).map((c) => ({
    sign: c.sign,
    text: c.text,
    line: startLine + (c.sign === "-" ? c.oldIndex : c.newIndex),
  }));
}

/**
 * Replace every occurrence of `oldStr` with `newStr` using index-based
 * splicing. Unlike String.replaceAll, this treats both strings as literal
 * text — no special-pattern interpretation in the replacement.
 */
export function spliceAll(content: string, oldStr: string, newStr: string): string {
  if (oldStr === "") return content;
  let result = "";
  let pos = 0;
  let idx = content.indexOf(oldStr, pos);
  while (idx !== -1) {
    result += content.slice(pos, idx) + newStr;
    pos = idx + oldStr.length;
    idx = content.indexOf(oldStr, pos);
  }
  result += content.slice(pos);
  return result;
}

/**
 * CRLF tolerance for search/replace on Windows files. The model almost always
 * builds old_string from Read output (which strips `\r`), so it sends LF-only
 * search text; an exact indexOf then fails against a CRLF file on EVERY
 * multi-line match. When that happens, upconvert the pair to CRLF and let the
 * caller retry. Surgical: only the matched region is rewritten with CRLF —
 * lone-LF lines elsewhere in a mixed-ending file are untouched.
 *
 * Returns the ORIGINAL pair unchanged when upconversion doesn't apply (exact
 * match already works, file is LF-only, or old_string already carries `\r`).
 */
export function crlfTolerantPair(
  content: string,
  oldStr: string,
  newStr: string,
): { oldStr: string; newStr: string } {
  if (
    oldStr.includes("\n") &&
    !oldStr.includes("\r") &&
    content.includes("\r\n") &&
    !content.includes(oldStr)
  ) {
    return {
      oldStr: oldStr.replace(/\n/g, "\r\n"),
      newStr: newStr.replace(/\n/g, "\r\n"),
    };
  }
  return { oldStr, newStr };
}
