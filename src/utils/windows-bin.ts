import { join } from "node:path";

/**
 * Absolute paths for Windows system binaries the CLI spawns.
 *
 * Review fix ("裸可执行名 CWD 劫持"): Windows' executable search order
 * includes the CURRENT directory, so a bare "powershell.exe" / "cmd.exe" /
 * "taskkill" spawned with cwd = workspace can be hijacked by a binary the
 * repo planted — before any sandboxing or token restriction applies. The
 * same class of bug was already fixed for the external-URL opener
 * (external-url.ts); this helper gives every spawn site the same treatment.
 *
 * On non-Windows platforms the bare name is returned unchanged: POSIX
 * exec search does NOT include the working directory.
 */
export function absoluteWindowsBinary(name: "powershell" | "cmd" | "taskkill"): string {
  if (process.platform !== "win32") return name;
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  if (name === "powershell")
    return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return join(root, "System32", `${name}.exe`);
}
