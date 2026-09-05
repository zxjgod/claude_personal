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

const IS_WIN = process.platform === "win32";

// Safety fuse: an editor that never exits must not hang the TUI. Generous by
// default (a real editing session is long); override with CCR_EDITOR_TIMEOUT
// (ms). On fire the child is killed and the temp file is KEPT (see below).
const DEFAULT_FUSE_MS = 10 * 60_000;

function fuseMs(): number {
  const v = Number.parseInt(process.env.CCR_EDITOR_TIMEOUT ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_FUSE_MS;
}

function pickEditor(): string {
  return process.env.VISUAL || process.env.EDITOR || (IS_WIN ? "notepad" : "vi");
}

/**
 * Write `content` to a temp file and open it in $VISUAL/$EDITOR. Resolves
 * with `{ ok, filePath }`; `ok` is true only when the editor ran to a
 * successful exit — a bad $EDITOR (spawn error, "command not found") or a
 * fuse kill reports `ok: false`, and the temp file is then KEPT at
 * `filePath` so its content is recoverable. NEVER rejects — callers
 * fire-and-forget, and an unhandled rejection here would crash the TUI.
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

  // ok is only true when the editor exits 0 without an error/kill. On the
  // Windows shell path a missing command ALSO shows up as a non-zero exit —
  // the one case where "the editor quit non-zero" and "never ran" are
  // indistinguishable — and flagging both keeps a silent no-op impossible.
  let ok = false;
  try {
    await new Promise<void>((resolve) => {
      let child: ReturnType<typeof spawn> | null = null;
      let settled = false;
      const settle = (result: boolean) => {
        if (settled) return;
        settled = true;
        ok = result;
        clearTimeout(fuse);
        resolve();
      };
      // Safety fuse: kill the child, then resolve — restoring stdin under a
      // live editor would have both processes fighting over the same TTY.
      const fuse = setTimeout(() => {
        try {
          child?.kill();
        } catch {
          /* already gone */
        }
        settle(false);
      }, fuseMs());
      try {
        // Windows: many editors are .cmd/.bat shims on PATH (VS Code's
        // `code`), which Node refuses to spawn directly (CVE-2024-27980) —
        // route through the shell with every argument quoted so paths with
        // spaces survive. POSIX keeps the direct spawn (its spawn "error"
        // event cleanly reports ENOENT).
        child = IS_WIN
          ? spawn(`"${cmd}" ${args.map((a) => `"${a}"`).join(" ")}`, {
              shell: true,
              stdio: "inherit",
            })
          : spawn(cmd, args, { stdio: "inherit" });
      } catch {
        settle(false);
        return;
      }
      child.on("error", () => settle(false));
      child.on("exit", (code) => settle(code === 0));
    });
    return { ok, filePath };
  } finally {
    stdin.resume();
    try {
      stdin.setRawMode?.(wasRaw);
    } catch {
      /* non-TTY stdin */
    }
    // Clean up only after a successful run. On failure the file stays at
    // `filePath` (reported to the user by the caller) — deleting it would
    // destroy the only recoverable copy after a fuse kill.
    if (ok) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
