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

/** Windows restricted-token + Job Object runner. Unsupported platforms fail closed. */
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
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token,string app,string cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ResumeThread(IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 const uint TOKEN_QUERY=8,TOKEN_DUPLICATE=2,TOKEN_ASSIGN_PRIMARY=1,TOKEN_ADJUST_DEFAULT=128,TOKEN_ADJUST_SESSIONID=256,CREATE_SUSPENDED=4,DISABLE_MAX_PRIVILEGE=1; const int JobObjectExtendedLimitInformation=9; const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000;
 [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public string reserved,desktop,title; public int x,y,xsize,ysize,xcount,ycount,fill; public int flags; public short show,cb2; public IntPtr reserved2,stdin,stdout,stderr; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active; public IntPtr affinity; public uint priority,sched; }
 [StructLayout(LayoutKind.Sequential)] struct LIMITS { public BASIC basic; public ulong io1,io2,io3,io4,io5,io6; public UIntPtr processMemoryLimit, jobMemoryLimit, peakProcessMemoryUsed, peakJobMemoryUsed; }
 public static int Run(string cmd,string cwd,string output,string error){ IntPtr orig=IntPtr.Zero,restricted=IntPtr.Zero; if(!OpenProcessToken(Process.GetCurrentProcess().Handle,TOKEN_QUERY|TOKEN_DUPLICATE|TOKEN_ASSIGN_PRIMARY|TOKEN_ADJUST_DEFAULT|TOKEN_ADJUST_SESSIONID,out orig)) return -10; if(!CreateRestrictedToken(orig,DISABLE_MAX_PRIVILEGE,0,IntPtr.Zero,0,IntPtr.Zero,0,IntPtr.Zero,out restricted)) return -11; var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si); PROCESS_INFORMATION pi; var line="cmd.exe /d /s /c ""+cmd.Replace(""","\\"")+" > \\""+output+"\\" 2> \\""+error+"\\""; if(!CreateProcessAsUser(restricted,null,line,IntPtr.Zero,IntPtr.Zero,false,CREATE_SUSPENDED,IntPtr.Zero,cwd,ref si,out pi)) return -12; var job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) return -13; var lim=new LIMITS(); lim.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; var mem=Marshal.AllocHGlobal(Marshal.SizeOf(lim)); Marshal.StructureToPtr(lim,mem,false); if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,mem,(uint)Marshal.SizeOf(lim))) return -14; Marshal.FreeHGlobal(mem); if(!AssignProcessToJobObject(job,pi.process)) return -15; ResumeThread(pi.thread); var p=Process.GetProcessById((int)pi.pid); p.WaitForExit(); CloseHandle(job); CloseHandle(pi.thread); CloseHandle(pi.process); CloseHandle(restricted); CloseHandle(orig); return p.ExitCode; }
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
    const abort = () => child.kill();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      let stdout = "";
      try {
        stdout = fs.readFileSync(outFile, "utf8");
      } catch {}
      try {
        stderr += fs.readFileSync(errFile, "utf8");
      } catch {}
      try {
        fs.rmSync(temp, { recursive: true, force: true });
      } catch {}
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("close", finish);
    child.on("error", (e) => {
      stderr += e.message;
      finish(null);
    });
  });
}
