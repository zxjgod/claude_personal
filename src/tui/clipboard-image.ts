// ============================================================
// clipboard-image — read an image from the system clipboard (P0-5)
// ============================================================
// Terminals can't hand binary clipboard content to a CLI through stdin, so
// image paste (Ctrl+V) reads the SYSTEM clipboard via each platform's tool
// and returns the bytes as a base64 PNG. Returns null when the clipboard
// holds no image or the platform tool is unavailable — callers show a short
// note, never an error wall.
//
//   win32   PowerShell + WinForms Clipboard (STA), saved to a temp PNG
//   darwin  osascript «class PNGf» hex dump → PNG bytes
//   linux   xclip -selection clipboard -t image/png -o, then wl-paste
//
// stdout is captured as a BUFFER (encoding: "buffer") — decoding it as UTF-8
// first would mangle the PNG magic bytes (0x89 is an invalid UTF-8 start
// byte) before any latin1 round-trip could recover them.
// ============================================================

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Skip absurdly large images (provider caps are ~5 MB anyway). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function runBuffer(
  cmd: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
          encoding: "buffer", // binary-safe: no utf8 decode of image bytes
        },
        (error, stdout, stderr) => {
          resolve({
            code: error ? 1 : 0,
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from([]),
            stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from([]),
          });
        },
      );
    } catch {
      resolve({ code: 1, stdout: Buffer.from([]), stderr: Buffer.from([]) });
    }
  });
}

function runText(cmd: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
        (error, stdout) => resolve(error ? "" : String(stdout ?? "")),
      );
    } catch {
      resolve("");
    }
  });
}

async function readWindows(): Promise<string | null> {
  const tmp = path.join(os.tmpdir(), `ccr-clip-${Date.now()}.png`);
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    `$img = [System.Windows.Forms.Clipboard]::GetImage()`,
    `if ($img) { $img.Save('${tmp.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0 }`,
    "exit 1",
  ].join("; ");
  const powershell =
    process.env.SystemRoot &&
    fs.existsSync(
      path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    )
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell";
  await runText(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
  // The script prints nothing; the temp PNG (or its absence) is the result.
  try {
    const data = fs.readFileSync(tmp);
    return data.length > 0 ? data.toString("base64") : null;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

async function readDarwin(): Promise<string | null> {
  // osascript prints the PNG as «data PNGf<hex...>» — parse the hex payload.
  const res = await runText("osascript", ["-e", "get the clipboard as «class PNGf»"]);
  const m = res.match(/«data PNGf([0-9A-Fa-f\s]*)»/);
  if (!m || !m[1]) return null;
  const hex = m[1].replace(/\s+/g, "");
  if (hex.length === 0) return null;
  return Buffer.from(hex, "hex").toString("base64");
}

/** PNG magic: the first two bytes must survive the platform tool. */
function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
}

async function readLinux(): Promise<string | null> {
  // X11 (xclip) first, then Wayland (wl-paste). Each silently fails when the
  // other display server owns the session.
  const xclip = await runBuffer("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
  if (xclip.code === 0 && isPng(xclip.stdout)) return xclip.stdout.toString("base64");
  const wl = await runBuffer("wl-paste", ["-t", "image/png"]);
  if (wl.code === 0 && isPng(wl.stdout)) return wl.stdout.toString("base64");
  return null;
}

/**
 * Read the clipboard image (as base64 PNG) or null. Never throws.
 */
export async function readClipboardImageBase64(): Promise<string | null> {
  try {
    const data =
      process.platform === "win32"
        ? await readWindows()
        : process.platform === "darwin"
          ? await readDarwin()
          : await readLinux();
    if (data === null) return null;
    if (Buffer.byteLength(data, "base64") > MAX_IMAGE_BYTES) return null;
    return data;
  } catch {
    return null;
  }
}
