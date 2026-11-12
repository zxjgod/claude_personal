import { type ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import { absoluteWindowsBinary } from "./windows-bin.js";

const execute = promisify(execFile);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** taskkill reports target PID first on each action line; later PIDs are
 * parents and can include the SDK host itself. A partial-failure exit is
 * benign only when every reported target is demonstrably gone. */
async function alreadyStopped(error: unknown, rootPid: number): Promise<boolean> {
  const result = error as { code?: number; stdout?: string; stderr?: string };
  if (typeof result.code !== "number" || result.code === 0) return false;
  const targets = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/\bPID\s+(\d+)/i);
      return match ? [Number(match[1])] : [];
    });
  // A vanished root is reported as a quoted process name, without "PID".
  if (!targets.length && result.stderr?.includes(`"${rootPid}"`)) targets.push(rootPid);
  if (!targets.length || targets.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))
    return false;
  const deadline = Date.now() + 1000;
  while (targets.some(alive) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return !targets.some(alive);
}

/** Stop descendants while their parent is still reachable. Shell tools may
 * create independent Unix process groups, so killing only the CLI group leaks
 * those commands. This is bounded best-effort cleanup, not an OS containment
 * boundary: already detached/reparented descendants cannot be rediscovered. */
export async function terminateOwnedProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      await execute(absoluteWindowsBinary("taskkill"), ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 5000,
      });
    } else {
      const { stdout } = await execute("/bin/ps", ["-eo", "pid=,ppid="], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const rows = stdout
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number));
      const descendants = new Set([child.pid]);
      const order = [child.pid];
      for (let index = 0; index < order.length; index++)
        for (const [pid, parent] of rows)
          if (parent === order[index] && pid > 0 && pid !== process.pid && !descendants.has(pid)) {
            descendants.add(pid);
            order.push(pid);
          }
      for (const pid of order.reverse()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
  } catch (error) {
    if (process.platform === "win32" && (await alreadyStopped(error, child.pid))) return;
    // A closed root alone is not proof that failed descendant kills succeeded.
    child.kill("SIGKILL");
    throw new Error("Failed to terminate the owned CLI process tree", { cause: error });
  }
}
