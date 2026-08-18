// ============================================================
// Diff Utilities for Tools
// ============================================================

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
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  // Longest common subsequence table (lines as atoms).
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

  // Walk the table emitting `-` (removed), `+` (added), and unchanged lines
  // skipped. Group consecutive +/- into hunks so the output reads like a diff.
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${oldLines[i]}`);
      i++;
    } else {
      out.push(`+ ${newLines[j]}`);
      j++;
    }
  }
  while (i < m) out.push(`- ${oldLines[i++]}`);
  while (j < n) out.push(`+ ${newLines[j++]}`);

  return out.join("\n") || "(whitespace-only change)";
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
  let idx: number;
  while ((idx = content.indexOf(oldStr, pos)) !== -1) {
    result += content.slice(pos, idx) + newStr;
    pos = idx + oldStr.length;
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
