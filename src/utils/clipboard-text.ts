// ============================================================
// clipboard-text — write text to the system clipboard (/copy)
// ============================================================
// The text counterpart to tui/clipboard-image.ts, which reads images the other
// way. Each platform's native tool reads the payload from stdin, so no
// dependency is needed:
//
//   win32   Set-Clipboard via powershell -EncodedCommand (Unicode-clean),
//           falling back to clip.exe (System32; resolved via SystemRoot)
//   darwin  pbcopy
//   linux   wl-copy (Wayland) first, then xclip -selection clipboard (X11)
//
// Every failure mode — tool missing, non-zero exit, hang — resolves to `false`
// rather than throwing: /copy reports a short note, never an error wall.
// ============================================================

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function pipe(
  cmd: string,
  args: string[],
  input: string | Buffer,
  timeoutMs = 5000,
): Promise<boolean> {
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

/**
 * Encode a clipboard payload for clip.exe. clip.exe sniffs a leading FF FE
 * and switches to CF_UNICODETEXT; writing raw UTF-8 instead makes it decode
 * stdin as the OEM codepage, so on a cp936 (Chinese) Windows every non-ASCII
 * payload comes back mojibake ("中文" → "涓枃"). UTF-16LE+BOM is what that
 * sniffing expects. Kept as the FALLBACK only: measured on a cp936 machine,
 * clip.exe also leaks the BOM into the copied text and appends a trailing
 * CRLF — see setClipboard for the primary path. Newlines are normalized to
 * CRLF — clip.exe stores bytes verbatim, and LF-only text pastes as one long
 * line into Notepad-class apps.
 */
function clipPayload(text: string): Buffer {
  const crlf = text.replace(/\r?\n/g, "\r\n");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(crlf, "utf16le")]);
}

/** Path to clip.exe, preferring the canonical System32 location. */
function clipExe(): string {
  const candidate =
    process.env.SystemRoot && path.join(process.env.SystemRoot, "System32", "clip.exe");
  return candidate && fs.existsSync(candidate) ? candidate : "clip";
}

/**
 * Primary win32 path: Set-Clipboard, with the script — the text included —
 * carried as -EncodedCommand (base64 UTF-16LE). That keeps the payload out of
 * both argv quoting and every stdin/stdout codepage: stdin piping into
 * Windows PowerShell 5.1 decodes as the OEM codepage and clip.exe alters the
 * bytes (BOM + trailing CRLF leak); neither problem exists here.
 */
function setClipboard(text: string): Promise<boolean> {
  const script = `Set-Clipboard -Value '${text.replace(/'/g, "''")}'`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return pipe(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    "",
    10_000,
  );
}

/**
 * Copy `text` to the system clipboard. Resolves false when no platform tool
 * could do it. Never throws.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (process.platform === "win32")
      return (await setClipboard(text)) || (await pipe(clipExe(), [], clipPayload(text)));
    if (process.platform === "darwin") return await pipe("pbcopy", [], text);
    // Linux: Wayland first, then X11. Each silently fails when the other
    // display server owns the session, so trying both is the reliable move.
    if (await pipe("wl-copy", [], text)) return true;
    return await pipe("xclip", ["-selection", "clipboard"], text);
  } catch {
    return false;
  }
}
