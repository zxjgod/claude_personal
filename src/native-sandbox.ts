import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { absoluteWindowsBinary } from "./utils/windows-bin.js";

export interface NativeSandboxOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Capture cap per redirected stream (default 10MB, matching the tools'
   *  in-memory guard). Exposed for tests; callers never need to shrink it. */
  maxCaptureBytes?: number;
}
export interface NativeSandboxResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** A redirected stream exceeded the capture cap and its text was cut. */
  truncated: boolean;
}

/**
 * Decode a redirected output file. cmd.exe and console programs write the OEM
 * codepage on CJK Windows (GBK on a cp936 machine), which decodes as mojibake
 * under plain UTF-8. Try strict UTF-8 first — the common case, and any
 * tool that already emits UTF-8 stays correct — then GBK, then lossy UTF-8
 * for runtimes built without GBK in their ICU.
 */
function decodeCapturedOutput(buf: Buffer): string {
  if (buf.length === 0) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* not valid UTF-8 — probably the OEM codepage */
  }
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    /* small-ICU runtime without GBK */
  }
  return buf.toString("utf8");
}

/**
 * Back `end` off to a UTF-8 character boundary (drop an incomplete trailing
 * sequence, at most 3 bytes). A capped read can cut a multibyte character in
 * half; without this the strict UTF-8 decode of the WHOLE buffer fails and
 * the GBK fallback garbles every byte of valid UTF-8 output, not just the
 * cut. Genuine GBK content loses nothing: strict UTF-8 already fails on it,
 * and dropping ≤3 trailing bytes costs at most one partial GBK character.
 */
export function trimToUtf8Boundary(buf: Buffer, end: number): number {
  for (let k = 1; k <= 3 && k <= end; k++) {
    const b = buf[end - k];
    if ((b & 0xc0) === 0x80) continue; // continuation byte — keep scanning
    if ((b & 0xc0) === 0xc0) {
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      if (k < need) end -= k; // lead byte without its full sequence
    }
    break; // ASCII or a complete sequence — the cut is already clean
  }
  return end;
}

/**
 * Windows restricted-token + Job Object runner. Unsupported platforms fail
 * closed.
 *
 * Two hard-won invariants in the embedded C#:
 *  1. The script builds cmd's command line WITHOUT any escaped quotes or
 *     backslashes — C# string literals have no `""` quote escape (that is the
 *     Pascal/CSV idiom; it is a COMPILE ERROR in C#), and every backslash
 *     here would need doubling again for the surrounding TS template literal.
 *     Quote and backslash are built from their char codes instead, so this
 *     file cannot regress into the bug that made the runner 100% fail to
 *     compile.
 *  2. CreateProcessAsUser under a restricted token needs privileges a normal
 *     (non-admin) user session does not have. If it fails we fall back to a
 *     plain CreateProcess — still CREATE_SUSPENDED, still inside the
 *     kill-on-close Job Object — so resource limits and timeout teardown
 *     work everywhere; token lockdown applies only where it can. The fallback
 *     is NOT silent (Top10 #7): the C# Warn() emits a sentinel line prefixed
 *     `ccr-sandbox: WARNING:` on the host's stderr; the TS side strips
 *     sentinel lines out of result.stderr (so a clean command's stderr stays
 *     empty) and escalates the first one per process into a single console
 *     notice — see splitSandboxWarnings / reportSandboxDegraded. Every HARD
 *     failure still reports its win32 error on the host's stderr, which the
 *     Promise below forwards into the result. Swallowing those streams once
 *     turned every setup failure into a mysterious `code:1, no output`.
 *
 * Known limitation (inherent to the `( )` grouping that keeps a user-side
 * `1>&2` from stealing our redirections): an UNQUOTED, unbalanced `)` in the
 * command closes the group early — `echo )` fails with a cmd syntax error.
 * Quoted or balanced parens are safe. An unbalanced DOUBLE QUOTE is the
 * quieter sibling (quote-state toggling folds our redirection paths into
 * the user's string, so stdout is silently lost) — bash.ts refuses odd
 * quote parity up front rather than let capture corrupt. Do not "fix" this
 * by dropping the group; the stderr-swap bug it prevents is worse than
 * these edges.
 *
 * Init-failure sentinels: the C# returns 0x4CC0000n, a band chosen OUTSIDE
 * both the 0-255 cmd range and the 0xC0000000 NTSTATUS range, so nothing a
 * sandboxed command can exit with collides with "the sandbox itself failed
 * to start". The old small-negative band (0xFFFFFFF0..) collided with a
 * user `exit /b -12`, which was then misreported as a sandbox refusal.
 */
/**
 * Per-stream capture cap, matching the tools' 10MB in-memory guard: the
 * redirected files on disk are unbounded (only the timeout bounds how long a
 * command may write), so loading them must be capped or a single command can
 * OOM the agent process.
 */
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

/** Sentinel prefix for degraded-isolation warnings emitted by the embedded
 *  C# Warn(). These lines are host diagnostics, NOT command output:
 *  splitSandboxWarnings strips them from result.stderr and escalates the
 *  first one per process via reportSandboxDegraded. */
const SANDBOX_WARN_PREFIX = "ccr-sandbox: WARNING:";

/**
 * Split the sandbox host's stderr into (clean diagnostics, degraded-isolation
 * warnings). Clean command runs must keep `result.stderr === ""` — the win32
 * e2e tests enforce this — so sentinel lines may never leak into it. Hard
 * failures (`ccr-sandbox: <op> failed ...`) do NOT carry the WARNING prefix
 * and stay in the clean text on purpose.
 */
export function splitSandboxWarnings(hostStderr: string): {
  clean: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const kept: string[] = [];
  for (const line of hostStderr.split("\n")) {
    const bare = line.replace(/\r$/, "");
    if (bare.startsWith(SANDBOX_WARN_PREFIX)) {
      const detail = bare.slice(SANDBOX_WARN_PREFIX.length).trim();
      if (detail) warnings.push(detail);
      continue; // drop the sentinel line entirely
    }
    kept.push(line);
  }
  return { clean: kept.join("\n"), warnings };
}

let warnedDegraded = false;

/**
 * Escalate degraded isolation (restricted token / CreateProcessAsUser
 * unavailable → the command ran with an unrestricted token) to a single
 * per-process console notice. Once per process on purpose: on machines where
 * the fallback is the norm, warning per command would flood transcripts.
 */
export function reportSandboxDegraded(warnings: string[]): void {
  if (warnedDegraded || warnings.length === 0) return;
  warnedDegraded = true;
  console.error(
    `[ccr-sandbox] Native sandbox degraded: ${warnings[0]}. The command ran WITHOUT token restriction (job resource limits and timeout kill still applied). This notice is shown once per process.`,
  );
}

/** Test-only: reset the reportSandboxDegraded once-per-process latch. */
export function __resetSandboxWarnedForTests(): void {
  warnedDegraded = false;
}

export function runWindowsSandbox(options: NativeSandboxOptions): Promise<NativeSandboxResult> {
  if (process.platform !== "win32")
    return Promise.resolve({
      code: null,
      stdout: "",
      stderr: "unsupported platform",
      timedOut: false,
      truncated: false,
    });
  const q = (value: string) => value.replace(/'/g, "''");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-sandbox-"));
  const outFile = path.join(temp, "stdout.txt");
  const errFile = path.join(temp, "stderr.txt");
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System; using System.Diagnostics; using System.Runtime.InteropServices;
public static class CcrSandbox {
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint a,out IntPtr t);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr e,uint f,uint s,IntPtr sid,uint d,IntPtr priv,uint g,IntPtr grp,out IntPtr r);
 [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr token,string app,string cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,string cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ResumeThread(IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr p,uint c);
 const uint TOKEN_QUERY=8,TOKEN_DUPLICATE=2,TOKEN_ASSIGN_PRIMARY=1,TOKEN_ADJUST_DEFAULT=128,TOKEN_ADJUST_SESSIONID=256,CREATE_SUSPENDED=4,DISABLE_MAX_PRIVILEGE=1; const int JobObjectExtendedLimitInformation=9; const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000; const uint SB=0x4CC00000;
 [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public string reserved,desktop,title; public int x,y,xsize,ysize,xcount,ycount,fill; public int flags; public short show,cb2; public IntPtr reserved2,stdin,stdout,stderr; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active; public IntPtr affinity; public uint priority,sched; }
 [StructLayout(LayoutKind.Sequential)] struct LIMITS { public BASIC basic; public ulong io1,io2,io3,io4,io5,io6; public UIntPtr processMemoryLimit, jobMemoryLimit, peakProcessMemoryUsed, peakJobMemoryUsed; }
 static void Fail(string what){ Console.Error.WriteLine("ccr-sandbox: "+what+" failed (win32 error "+Marshal.GetLastWin32Error()+")"); }
 static void Warn(string what){ Console.Error.WriteLine("ccr-sandbox: WARNING: "+what); }
 public static int Run(string cmd,string cwd,string output,string error,string shell){
  // '"' by char code — see the TS doc-comment: NO escaped quote or backslash may ever appear in this file's C#.
  string dq=((char)34).ToString();
  IntPtr orig=IntPtr.Zero, restricted=IntPtr.Zero;
  bool tokOk=OpenProcessToken(Process.GetCurrentProcess().Handle,TOKEN_QUERY|TOKEN_DUPLICATE|TOKEN_ASSIGN_PRIMARY|TOKEN_ADJUST_DEFAULT|TOKEN_ADJUST_SESSIONID,out orig);
  if(tokOk) tokOk=CreateRestrictedToken(orig,DISABLE_MAX_PRIVILEGE,0,IntPtr.Zero,0,IntPtr.Zero,0,IntPtr.Zero,out restricted);
  if(!tokOk||restricted==IntPtr.Zero) Warn("restricted token unavailable - the command will run WITHOUT token privilege restriction");
  // The user command goes inside ( ) and OUR redirections go OUTSIDE them.
  // Appending '> out 2> err' to a bare command line lets cmd bind
  // left-to-right, so a user-side redirect like 'echo x 1>&2' silently swaps
  // into our stdout capture file. With outer-then-inner binding the group's
  // stderr lands where the user intended it.
  // (NEVER use backticks in these C# comments: this block is a TS template
  // literal and one would close it — the parser error lands far away.)
  // The user command passes through with NO quote escaping (the old
  // backslash-escape corrupted echo he said "hi" into literal backslashes —
  // cmd builtins emit verbatim, and external programs run their own argv
  // parser over the raw quotes). /s strips exactly the outer pair we add
  // FIRST and LAST, so inner quotes cannot break the wrapping.
  string line=shell+" /d /s /c "+dq+"("+cmd+") > "+dq+output+dq+" 2> "+dq+error+dq;
  var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si);
  // MUST initialize: CreateProcessAsUser is short-circuited when no restricted
  // token was obtained, so C# definite-assignment sees pi as maybe-unassigned
  // at the job-assignment below (CS0165 killed the previous version).
  var pi=new PROCESS_INFORMATION();
  bool ok=restricted!=IntPtr.Zero && CreateProcessAsUser(restricted,null,line,IntPtr.Zero,IntPtr.Zero,false,CREATE_SUSPENDED,IntPtr.Zero,cwd,ref si,out pi);
  // Restricted-token launch needs privileges a plain user lacks; fall back to a same-job unsandboxed-token spawn rather than hard-failing.
  // The fallback is NOT silent: Warn emits a host-stderr sentinel that the TS side strips and escalates once per process. When restricted==Zero the token Warn above already fired, so only warn again here when CreateProcessAsUser itself failed.
  if(!ok){
   if(restricted!=IntPtr.Zero) Warn("CreateProcessAsUser failed - falling back to an unrestricted-token spawn (resource limits and timeout kill still apply)");
   ok=CreateProcess(null,line,IntPtr.Zero,IntPtr.Zero,false,CREATE_SUSPENDED,IntPtr.Zero,cwd,ref si,out pi);
  }
  if(!ok){ Fail("spawn"); return (int)(SB+1); }
  var job=CreateJobObject(IntPtr.Zero,null);
  // Every early return below MUST TerminateProcess: the child is CREATE_SUSPENDED and
  // not yet in any job (or in a job without kill-on-close), so nothing else would
  // ever reap it — it would sit suspended forever after the host exits.
  if(job==IntPtr.Zero){ Fail("CreateJobObject"); TerminateProcess(pi.process,1); return (int)(SB+2); }
  var lim=new LIMITS(); lim.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  var mem=Marshal.AllocHGlobal(Marshal.SizeOf(lim)); Marshal.StructureToPtr(lim,mem,false);
  bool limOk=SetInformationJobObject(job,JobObjectExtendedLimitInformation,mem,(uint)Marshal.SizeOf(lim));
  Marshal.FreeHGlobal(mem);
  // Hard-fail, not log-and-continue: without kill-on-close a later timeout kill of
  // this host leaves the whole sandboxed tree RUNNING (orphaned teardown no-op).
  if(!limOk){ Fail("SetInformationJobObject"); TerminateProcess(pi.process,1); return (int)(SB+3); }
  if(!AssignProcessToJobObject(job,pi.process)){ Fail("AssignProcessToJobObject"); TerminateProcess(pi.process,1); return (int)(SB+4); }
  ResumeThread(pi.thread);
  // Wait on the PROCESS HANDLE, not Process.GetProcessById: a fast command
  // (a plain echo) can finish before the pid lookup runs, and GetProcessById
  // then throws "process is not running" even though the job completed.
  WaitForSingleObject(pi.process,0xFFFFFFFF);
  uint rc;
  if(!GetExitCodeProcess(pi.process,out rc)){ Fail("GetExitCodeProcess"); return (int)(SB+5); }
  CloseHandle(job); CloseHandle(pi.thread); CloseHandle(pi.process);
  if(restricted!=IntPtr.Zero) CloseHandle(restricted);
  if(orig!=IntPtr.Zero) CloseHandle(orig);
  return (int)rc;
 }
}
'@; exit [CcrSandbox]::Run('${q(options.command)}','${q(options.cwd)}','${q(outFile)}','${q(errFile)}','${q(absoluteWindowsBinary("cmd"))}')`;
  return new Promise((resolve) => {
    const child = spawn(
      absoluteWindowsBinary("powershell"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
    );
    let timedOut = false;
    // Raw bytes, not strings: the host powershell writes diagnostics in the
    // OEM codepage on CJK Windows, so decoding per-chunk would garble the
    // very errors we added the handler to surface.
    const hostErr: Buffer[] = [];
    let hostErrBytes = 0;
    const abort = () => child.kill();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    // Forward the host's own streams: Add-Type compile errors and Fail()
    // diagnostics land there, and an unread stderr pipe can also stall the
    // child at its 64KB buffer. stdout is drained to nothing — the command's
    // real stdout arrives via the redirected file.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      if (hostErrBytes > 64_000) return;
      hostErrBytes += chunk.length;
      hostErr.push(chunk);
    });
    const finish = (rawCode: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Init-failure sentinels arrive as 0x4CC0000n (see the file doc-comment):
      // a band no cmd/PowerShell/NTSTATUS exit code occupies. Restore them to
      // small negatives so callers can tell "sandbox refused to start" from
      // "command failed with code N". Everything else — including a user
      // `exit /b -12` (0xFFFFFFF4) and NTSTATUS crashes (0xC0000005...) —
      // passes through unchanged.
      let code = rawCode;
      if (code !== null && code >= 0x4cc00001 && code <= 0x4cc0000f)
        code = -(code - 0x4cc00000 + 100);
      const cap = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
      // Read each redirected file capped: a command can write gigabytes to
      // its redirect within the timeout window, and readFileSync would load
      // every byte. The +16 slack lets trimToUtf8Boundary drop the partial
      // character WITHOUT eating into the caller's cap budget.
      const readCapped = (file: string): { text: string; truncated: boolean } => {
        try {
          const size = fs.statSync(file).size;
          const len = Math.min(size, cap + 16);
          const fh = fs.openSync(file, "r");
          try {
            const buf = Buffer.alloc(len);
            const got = fs.readSync(fh, buf, 0, len, 0);
            const end = trimToUtf8Boundary(buf, got);
            return { text: decodeCapturedOutput(buf.subarray(0, end)), truncated: size > cap };
          } finally {
            fs.closeSync(fh);
          }
        } catch {
          return { text: "", truncated: false };
        }
      };
      const hostRaw = decodeCapturedOutput(Buffer.concat(hostErr));
      // Degraded-isolation sentinels are host diagnostics, not command output:
      // strip them from result.stderr and surface the first one per process.
      const { clean: host, warnings } = splitSandboxWarnings(hostRaw);
      reportSandboxDegraded(warnings);
      const out = readCapped(outFile);
      const err = readCapped(errFile);
      const truncated = out.truncated || err.truncated;
      const stdout = out.text;
      const base = err.text ? (host ? `${err.text}\n${host}` : err.text) : host;
      const note = "ccr-sandbox: output exceeded the capture cap and was truncated";
      const stderr = truncated ? (base ? `${base}\n${note}` : note) : base;
      try {
        fs.rmSync(temp, { recursive: true, force: true });
      } catch {}
      resolve({ code, stdout, stderr, timedOut, truncated });
    };
    child.on("close", finish);
    child.on("error", (e) => {
      // Into hostErr, not stderr — finish() rebuilds stderr from hostErr and
      // would otherwise discard this line (e.g. "powershell.exe ENOENT").
      hostErr.push(Buffer.from(`ccr-sandbox: ${e.message}\n`, "utf8"));
      finish(null);
    });
  });
}
