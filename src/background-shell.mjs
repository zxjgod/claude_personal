// Run an owned Bash job as a separate process so the CLI's IPC disconnect can
// stop it even when the CLI never reaches its shutdown handlers.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";

const windows = process.platform === "win32";
let child;
let stopping = false;
let exited = false;
let finished = false;
let killAttempt;

function stop() {
  if (!child?.pid || stopping || finished) return;
  stopping = true;
  if (windows) {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    if (exited) return;
    killAttempt = new Promise((resolve) => {
      const killer = spawn(join(systemRoot, "System32", "taskkill.exe"), [
        "/PID", String(child.pid), "/T", "/F",
      ], { windowsHide: true, stdio: "ignore", detached: true });
      killer.once("error", (error) => {
        console.error(`background process cleanup failed: ${error.message}`);
        if (!exited) child.kill("SIGKILL");
        resolve();
      });
      killer.once("close", (code) => {
        if (code !== 0 && !exited) {
          console.error(`background tree cleanup returned ${code}; stopping the shell directly`);
          child.kill("SIGKILL");
        }
        resolve();
      });
    });
  } else {
    // The supervisor and its command have a private process group. Keep this
    // group alive until output closes, even if the shell leader exits first.
    process.kill(-process.pid, "SIGKILL");
  }
}

process.on("disconnect", () => {
  if (child) {
    child.stdout.unpipe(process.stdout);
    child.stderr.unpipe(process.stderr);
    child.stdout.resume();
    child.stderr.resume();
  }
  stop();
});
process.on("message", (message) => {
  if (message?.type === "stop") {
    if (child) stop();
    else process.disconnect();
    return;
  }
  if (message?.type !== "start" || child || !process.connected) return;
  child = spawn(message.command, [], {
    shell: message.shell, cwd: message.cwd, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Continue draining after the host dies. Stdio inherits no CLI-owned pipe
  // descriptors beyond the supervisor, and a broken downstream pipe is benign.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.once("error", (error) => console.error(`spawn failed: ${error.message}`));
  child.once("exit", () => { exited = true; });
  child.once("close", async (code, signal) => {
    finished = true;
    await killAttempt;
    process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
    if (process.connected) process.disconnect();
  });
});
