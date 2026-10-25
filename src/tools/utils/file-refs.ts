// ============================================================
// @file references — expand "@path" tokens in user input
// ============================================================
// A bare "@src/foo.ts" in the user's message is read from disk and its
// contents appended to the message as context. Paths are resolved inside
// the workspace; escapes and missing files are reported, not injected.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

// Matches @ followed by a path-like token: letters, digits, /._-~ and
// Windows backslashes. Stops at whitespace. Skips emails (char before @).
const FILE_REF = /(^|\s)@([\w./~\-\\]+)/g;

const MAX_FILE_BYTES = 100_000;

export interface FileRefResult {
  /** The user text with @refs left intact (model still sees what was typed). */
  text: string;
  /** Resolved file blocks to append as context, or errors to surface. */
  attachments: string[];
  /** Human-readable notes (resolved / skipped) for the CLI to print. */
  notes: string[];
}

/**
 * Find @path references in input and read them from the workspace.
 * Returns the original text plus any file contents to append as context.
 */
export function expandFileRefs(input: string, workspaceRoot: string): FileRefResult {
  const attachments: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const match of input.matchAll(FILE_REF)) {
    const ref = match[2];
    if (seen.has(ref)) continue;
    seen.add(ref);

    const resolved = path.resolve(workspaceRoot, ref);
    const root = path.resolve(workspaceRoot);
    // Boundary check: must stay inside the workspace. Compare REAL paths —
    // `path.resolve` is lexical only, so a workspace symlink (or Windows
    // junction) pointing outside would sail through while statSync/readFile
    // happily follow it (review fix; the Read tool already does this).
    //
    // CI regression (self-review round 2): the real check is only comparable
    // when BOTH sides resolve. A MISSING target keeps its lexical path, so
    // comparing it against the realpath'd ROOT mismatches whenever the root
    // itself sits behind an alias (GitHub's Windows runner temp dir is an
    // 8.3 short name; realpath expands it) — every missing file was then
    // misreported as "outside the workspace". When the target cannot be
    // realpath'd, fall back to the lexical floor: a nonexistent entry cannot
    // be stat'd or read anyway, and any EXISTING escape must resolve.
    let realOutside = false;
    let statTarget = resolved;
    try {
      const realRoot = fs.realpathSync.native(root);
      const realResolved = fs.realpathSync.native(resolved);
      realOutside = realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep);
      statTarget = realResolved;
    } catch {
      /* missing/broken target — lexical check below is the floor */
    }
    const lexicalOutside = resolved !== root && !resolved.startsWith(root + path.sep);
    // EITHER check failing means outside. The first cut of this fix ANDed the
    // two conditions — which is exactly backwards for a symlink: lexical
    // INSIDE + real OUTSIDE is the symlink case, so the conjunction never
    // fired and the escape survived (self-review finding, probe-verified).
    if (realOutside || lexicalOutside) {
      notes.push(`  ⚠️  @${ref} is outside the workspace — skipped`);
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(statTarget);
    } catch {
      notes.push(`  ⚠️  @${ref} not found — skipped`);
      continue;
    }
    if (!stat.isFile()) {
      notes.push(`  ⚠️  @${ref} is not a file — skipped`);
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      notes.push(`  📎 @${ref} is too large (${stat.size} bytes) — skipped`);
      continue;
    }

    try {
      const contents = fs.readFileSync(statTarget, "utf-8");
      attachments.push(
        [
          `<file path="${ref}" attached_by="@file">`,
          `The contents below were already attached from @${ref}. Do not call the read tool for this file again unless you specifically need fresh line-numbered content or suspect the file changed.`,
          contents,
          `</file>`,
        ].join("\n"),
      );
      notes.push(`  📎 attached @${ref} (${stat.size} bytes)`);
    } catch {
      notes.push(`  ⚠️  @${ref} could not be read — skipped`);
    }
  }

  return { text: input, attachments, notes };
}
