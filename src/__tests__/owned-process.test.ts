import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { terminateOwnedProcess } from "../utils/owned-process.js";

const native = vi.hoisted(() => ({
  run: undefined as (() => Promise<{ stdout: string; stderr: string; code?: number }>) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      void native
        .run?.()
        .then((result) =>
          callback(
            Object.assign(new Error("partial native termination"), { code: 128, ...result }),
          ),
        );
    },
  };
});

async function processFixture() {
  const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const closed = once(child, "close");
  await once(child.stdout, "data");
  return { child, closed };
}

it.skipIf(process.platform !== "win32")(
  "accepts a root which exited during the native termination request",
  async () => {
    const { child, closed } = await processFixture();
    native.run = async () => {
      child.kill("SIGKILL");
      await closed;
      return { stdout: "", stderr: `ERROR: The process "${child.pid}" not found.` };
    };
    try {
      await expect(terminateOwnedProcess(child)).resolves.toBeUndefined();
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  },
);

for (const code of [128, 255])
  it.skipIf(process.platform !== "win32")(
    `checks native action targets at exit ${code} without treating their parent SDK PID as a target`,
    async () => {
      const { child, closed } = await processFixture();
      native.run = async () => {
        child.kill("SIGKILL");
        await closed;
        return {
          code,
          stdout: `SUCCESS: terminated PID ${child.pid} (child of PID ${process.pid}).`,
          stderr: `ERROR: PID ${child.pid} no instance.`,
        };
      };
      try {
        await expect(terminateOwnedProcess(child)).resolves.toBeUndefined();
      } finally {
        child.kill("SIGKILL");
        await closed;
      }
    },
  );

it.skipIf(process.platform !== "win32")(
  "reports native failure when a reported target stays alive even after the CLI root closes",
  async () => {
    const root = await processFixture();
    const target = await processFixture();
    native.run = async () => {
      root.child.kill("SIGKILL");
      await root.closed;
      return {
        code: 255,
        stdout: `SUCCESS: terminated PID ${root.child.pid}.`,
        stderr: `ERROR: PID ${target.child.pid} access denied.`,
      };
    };
    try {
      await expect(terminateOwnedProcess(root.child)).rejects.toThrow("Failed to terminate");
      expect(target.child.exitCode).toBeNull();
      expect(target.child.signalCode).toBeNull();
    } finally {
      root.child.kill("SIGKILL");
      target.child.kill("SIGKILL");
      await Promise.all([root.closed, target.closed]);
    }
  },
);
