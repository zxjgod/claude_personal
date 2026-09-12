// ============================================================
// clipboard-text — write text to the system clipboard (/copy)
// ============================================================
// The text counterpart to tui/clipboard-image.ts, which reads images the other
// way. Each platform's native tool reads the payload from stdin, so no
// dependency is needed:
//
//   win32   clip.exe (System32; resolved via SystemRoot like the image path)
//   darwin  pbcopy
//   linux   wl-copy (Wayland) first, then xclip -selection clipboard (X11)
//
// Every failure mode — tool missing, non-zero exit, hang — resolves to `false`
// rather than throwing: /copy reports a short note, never an error wall.
// ============================================================

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function pipe(cmd: string, args: string[], input: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(false);
    }, timeoutMs);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      finish(false);
      return;
    }

    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));

    const stdin = child.stdin;
    if (!stdin) {
      finish(false);
      return;
    }
    // The tool may exit before draining stdin (empty clipboard owner, killed
    // process) — EPIPE here is expected and must not surface as an exception.
    stdin.on("error", () => finish(false));
    stdin.end(input, "utf8");
  });
}

/** Path to clip.exe, preferring the canonical System32 location. */
function clipExe(): string {
  const candidate =
    process.env.SystemRoot && path.join(process.env.SystemRoot, "System32", "clip.exe");
  return candidate && fs.existsSync(candidate) ? candidate : "clip";
}

/**
 * Copy `text` to the system clipboard. Resolves false when no platform tool
 * could do it. Never throws.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (process.platform === "win32") return await pipe(clipExe(), [], text);
    if (process.platform === "darwin") return await pipe("pbcopy", [], text);
    // Linux: Wayland first, then X11. Each silently fails when the other
    // display server owns the session, so trying both is the reliable move.
    if (await pipe("wl-copy", [], text)) return true;
    return await pipe("xclip", ["-selection", "clipboard"], text);
  } catch {
    return false;
  }
}
