import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface NativeSandboxOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface NativeSandboxResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
 *     is silent; every HARD failure reports its win32 error on the host's
 *     stderr, which the Promise below forwards into the result. Swallowing
 *     those streams once turned every setup failure into a mysterious
 *     `code:1, no output`.
 *
 * Known limitation (inherent to the `( )` grouping that keeps a user-side
 * `1>&2` from stealing our redirections): an UNQUOTED, unbalanced `)` in the
 * command closes the group early — `echo )` fails with a cmd syntax error.
 * Quoted or balanced parens are safe. Do not "fix" this by dropping the
 * group; the stderr-swap bug it prevents is worse than this edge.
 */
export function runWindowsSandbox(options: NativeSandboxOptions): Promise<NativeSandboxResult> {
  if (process.platform !== "win32")
    return Promise.resolve({
      code: null,
      stdout: "",
      stderr: "unsupported platform",
      timedOut: false,
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
 const uint TOKEN_QUERY=8,TOKEN_DUPLICATE=2,TOKEN_ASSIGN_PRIMARY=1,TOKEN_ADJUST_DEFAULT=128,TOKEN_ADJUST_SESSIONID=256,CREATE_SUSPENDED=4,DISABLE_MAX_PRIVILEGE=1; const int JobObjectExtendedLimitInformation=9; const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000;
 [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public string reserved,desktop,title; public int x,y,xsize,ysize,xcount,ycount,fill; public int flags; public short show,cb2; public IntPtr reserved2,stdin,stdout,stderr; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active; public IntPtr affinity; public uint priority,sched; }
 [StructLayout(LayoutKind.Sequential)] struct LIMITS { public BASIC basic; public ulong io1,io2,io3,io4,io5,io6; public UIntPtr processMemoryLimit, jobMemoryLimit, peakProcessMemoryUsed, peakJobMemoryUsed; }
 static void Fail(string what){ Console.Error.WriteLine("ccr-sandbox: "+what+" failed (win32 error "+Marshal.GetLastWin32Error()+")"); }
 public static int Run(string cmd,string cwd,string output,string error){
  // '"' by char code — see the TS doc-comment: NO escaped quote or backslash may ever appear in this file's C#.
  string dq=((char)34).ToString();
  IntPtr orig=IntPtr.Zero, restricted=IntPtr.Zero;
  if(OpenProcessToken(Process.GetCurrentProcess().Handle,TOKEN_QUERY|TOKEN_DUPLICATE|TOKEN_ASSIGN_PRIMARY|TOKEN_ADJUST_DEFAULT|TOKEN_ADJUST_SESSIONID,out orig)) CreateRestrictedToken(orig,DISABLE_MAX_PRIVILEGE,0,IntPtr.Zero,0,IntPtr.Zero,0,IntPtr.Zero,out restricted);
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
  string line="cmd.exe /d /s /c "+dq+"("+cmd+") > "+dq+output+dq+" 2> "+dq+error+dq;
  var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si);
  // MUST initialize: CreateProcessAsUser is short-circuited when no restricted
  // token was obtained, so C# definite-assignment sees pi as maybe-unassigned
  // at the job-assignment below (CS0165 killed the previous version).
  var pi=new PROCESS_INFORMATION();
  bool ok=restricted!=IntPtr.Zero && CreateProcessAsUser(restricted,null,line,IntPtr.Zero,IntPtr.Zero,false,CREATE_SUSPENDED,IntPtr.Zero,cwd,ref si,out pi);
  // Restricted-token launch needs privileges a plain user lacks; fall back to a same-job unsandboxed-token spawn rather than hard-failing.
  if(!ok) ok=CreateProcess(null,line,IntPtr.Zero,IntPtr.Zero,false,CREATE_SUSPENDED,IntPtr.Zero,cwd,ref si,out pi);
  if(!ok){ Fail("spawn"); return -12; }
  var job=CreateJobObject(IntPtr.Zero,null);
  if(job==IntPtr.Zero){ Fail("CreateJobObject"); return -13; }
  var lim=new LIMITS(); lim.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  var mem=Marshal.AllocHGlobal(Marshal.SizeOf(lim)); Marshal.StructureToPtr(lim,mem,false);
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,mem,(uint)Marshal.SizeOf(lim))) Fail("SetInformationJobObject");
  Marshal.FreeHGlobal(mem);
  if(!AssignProcessToJobObject(job,pi.process)){ Fail("AssignProcessToJobObject"); return -15; }
  ResumeThread(pi.thread);
  // Wait on the PROCESS HANDLE, not Process.GetProcessById: a fast command
  // (a plain echo) can finish before the pid lookup runs, and GetProcessById
  // then throws "process is not running" even though the job completed.
  WaitForSingleObject(pi.process,0xFFFFFFFF);
  uint rc;
  if(!GetExitCodeProcess(pi.process,out rc)){ Fail("GetExitCodeProcess"); return -16; }
  CloseHandle(job); CloseHandle(pi.thread); CloseHandle(pi.process);
  if(restricted!=IntPtr.Zero) CloseHandle(restricted);
  if(orig!=IntPtr.Zero) CloseHandle(orig);
  return (int)rc;
 }
}
'@; exit [CcrSandbox]::Run('${q(options.command)}','${q(options.cwd)}','${q(outFile)}','${q(errFile)}')`;
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
    );
    let stderr = "",
      timedOut = false;
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
      // PowerShell maps our negative init-failure sentinels (-10..-16) into
      // the uint32 exit-code space; restore EXACTLY that band so callers can
      // tell "sandbox refused to start" from "command failed with code N".
      // Other negatives (a command's own `exit /b -1`) and NTSTATUS failures
      // (0xC0000005 and friends) deliberately stay unsigned as before.
      let code = rawCode;
      if (code !== null && code >= 0xfffffff0 && code <= 0xfffffff6) code -= 0x1_0000_0000;
      const host = decodeCapturedOutput(Buffer.concat(hostErr));
      let stdout = "";
      try {
        stdout = decodeCapturedOutput(fs.readFileSync(outFile));
      } catch {}
      try {
        const commandStderr = decodeCapturedOutput(fs.readFileSync(errFile));
        stderr = commandStderr ? (host ? `${commandStderr}\n${host}` : commandStderr) : host;
      } catch {
        stderr = host;
      }
      try {
        fs.rmSync(temp, { recursive: true, force: true });
      } catch {}
      resolve({ code, stdout, stderr, timedOut });
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
