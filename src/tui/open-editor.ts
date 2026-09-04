// ============================================================
// openEditor — hand content to the user's $VISUAL/$EDITOR (P0-1)
// ============================================================
// The transcript viewer's `v` key writes the flattened transcript to a temp
// file and opens it in the user's editor, Claude-Code style. Ink owns stdin
// in raw mode, so we suspend raw mode around the child: the editor gets a
// normal terminal, and the TUI resumes cleanly on exit.
// ============================================================

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function pickEditor(): string {
  return (
    process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi")
  );
}

/**
 * Write `content` to a temp file and open it in $VISUAL/$EDITOR. Resolves
 * with `{ ok, filePath }`; `ok` is false when the temp file could not be
 * written or no editor could be spawned. NEVER rejects — callers
 * fire-and-forget, and an unhandled rejection here would crash the TUI.
 * The temp file is removed after the editor exits (best-effort).
 */
export async function openInEditor(lines: string[]): Promise<{ ok: boolean; filePath: string }> {
  const filePath = path.join(os.tmpdir(), `ccr-transcript-${Date.now()}.txt`);
  try {
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
  } catch {
    return { ok: false, filePath };
  }

  const editor = pickEditor();
  // A command with arguments (e.g. EDITOR="code --wait") is split naively —
  // shell-quoting an env-provided editor is out of scope.
  const parts = editor.split(/\s+/);
  const cmd = parts[0];
  const args = [...parts.slice(1), filePath];

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  try {
    stdin.setRawMode?.(false);
  } catch {
    /* non-TTY stdin (tests): nothing to suspend */
  }
  stdin.pause();

  try {
    await new Promise<void>((resolve) => {
      let child: ReturnType<typeof spawn> | null = null;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fuse);
        resolve();
      };
      // Safety fuse: an editor that never starts (bad $EDITOR) must not hang
      // the TUI. KILL the child, then resolve — restoring stdin under a live
      // editor would have both processes fighting over the same TTY.
      const fuse = setTimeout(() => {
        try {
          child?.kill();
        } catch {
          /* already gone */
        }
        settle();
      }, 120_000);
      try {
        child = spawn(cmd, args, { stdio: "inherit" });
      } catch {
        settle();
        return;
      }
      child.on("error", () => settle());
      child.on("exit", () => settle());
    });
    return { ok: true, filePath };
  } finally {
    stdin.resume();
    try {
      stdin.setRawMode?.(wasRaw);
    } catch {
      /* non-TTY stdin */
    }
    // The transcript snapshot is regenerable — clean up after the editor
    // closes (best-effort; an editor still holding the file just keeps it).
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
