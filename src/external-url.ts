import { type ExecFileOptions, execFile } from "node:child_process";

const OPEN_EXTERNAL_URL_TIMEOUT_MS = 10_000;
const OPEN_EXTERNAL_URL_FORCE_KILL_DELAY_MS = 1_000;

export function validatedExternalUrl(value: string): string {
  if (/[\u0000-\u0020\u007f]/.test(value))
    throw new Error("URL contains control characters or spaces");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only HTTP(S) URLs without credentials may be opened");
  return url.href;
}
export async function openExternalUrl(value: string): Promise<void> {
  const url = validatedExternalUrl(value);
  // No shell command string contains the server-supplied URL.
  // Review fix ("powershell.exe CWD 劫持"): a bare "powershell.exe" is resolved
  // through the Windows search order, which includes the CURRENT directory —
  // in a malicious workspace (cwd = repo root) a planted powershell.exe would
  // run instead of the system one. Resolve via SystemRoot to the real binary.
  const command =
    process.platform === "win32"
      ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Start-Process -FilePath $env:CCR_EXTERNAL_URL",
        ]
      : [url];
  await new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let settled = false;
    const options = {
      windowsHide: true,
      env: { ...process.env, CCR_EXTERNAL_URL: url },
      // Do not let an inherited stdout/stderr pipe keep execFile pending
      // after the opener itself has exited or been killed. execFile forwards
      // this spawn option at runtime, but @types/node omits it from ExecFileOptions.
      stdio: "ignore",
      timeout: OPEN_EXTERNAL_URL_TIMEOUT_MS,
      killSignal: "SIGTERM",
    } as ExecFileOptions;
    const child = execFile(command, args, options, (error) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (error) reject(error);
      else resolve();
    });
    // Some mocked/very fast openers complete synchronously. In that case no
    // timer should retain the process or attempt to kill an already-done child.
    if (settled) return;
    timeout = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {}
      // Node's execFile timeout only sends SIGTERM. Escalate a stubborn opener
      // and settle the Promise even if its close/error callback never arrives.
      forceKill = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {}
        reject(
          Object.assign(new Error("External URL opener did not exit after termination"), {
            killed: true,
            signal: "SIGKILL",
          }),
        );
      }, OPEN_EXTERNAL_URL_FORCE_KILL_DELAY_MS);
    }, OPEN_EXTERNAL_URL_TIMEOUT_MS);
  });
}
export async function handleUrlElicitation(
  request: { url?: string; message: string },
  flow: {
    confirmOpen(url: string): Promise<boolean>;
    open(url: string): Promise<void>;
    confirmComplete(): Promise<boolean>;
  },
): Promise<{ action: "accept" | "cancel" | "decline" }> {
  let url: string;
  try {
    if (!request.url) return { action: "decline" };
    url = validatedExternalUrl(request.url);
  } catch {
    return { action: "decline" };
  }
  if (!(await flow.confirmOpen(url))) return { action: "cancel" };
  try {
    await flow.open(url);
  } catch {
    return { action: "decline" };
  }
  return { action: (await flow.confirmComplete()) ? "accept" : "cancel" };
}
