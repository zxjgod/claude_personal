import { execFile } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { handleUrlElicitation, openExternalUrl, validatedExternalUrl } from "../external-url.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command, _args, _options, callback) => callback(null)),
}));
beforeEach(() => vi.clearAllMocks());
it("rejects non-HTTP schemes, credentials and control characters", () => {
  for (const value of [
    "javascript:alert(1)",
    "file:///C:/fixture",
    "https://user@fixture.test/",
    "https://fixture.test/\nnext",
  ])
    expect(() => validatedExternalUrl(value)).toThrow();
});
it("opens no browser before consent and confirms authentication only after opening", async () => {
  const open = vi.fn(async () => {});
  const complete = vi.fn(async () => true);
  const request = { url: "https://fixture.test/auth?a=1&b=2", message: "Authenticate" };
  expect(
    await handleUrlElicitation(request, {
      confirmOpen: async () => false,
      open,
      confirmComplete: complete,
    }),
  ).toEqual({ action: "cancel" });
  expect(open).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  const order: string[] = [];
  expect(
    await handleUrlElicitation(request, {
      confirmOpen: async () => {
        order.push("consent");
        return true;
      },
      open: async () => {
        order.push("open");
      },
      confirmComplete: async () => {
        order.push("complete");
        return true;
      },
    }),
  ).toEqual({ action: "accept" });
  expect(order).toEqual(["consent", "open", "complete"]);
});
it("keeps a Windows URL out of the PowerShell command text", async () => {
  const value = "https://fixture.test/&echo.CCR_TEST";
  await openExternalUrl(value);
  const [command, args, options] = vi.mocked(execFile).mock.calls[0];
  const openerOptions = options as {
    env: Record<string, string>;
    timeout: number;
    killSignal: string;
  };
  if (process.platform === "win32") {
    // CWD-hijack fix: an ABSOLUTE System32 path, never the bare name
    // (CreateProcess searches the current directory for bare names).
    expect(
      String(command).toLowerCase().endsWith("\\system32\\windowspowershell\\v1.0\\powershell.exe"),
    ).toBe(true);
    expect(String(command)).not.toBe("powershell.exe");
    expect(args).not.toContain(value);
    expect(openerOptions.env.CCR_EXTERNAL_URL).toBe(value);
  } else expect(args).toContain(value);
  expect(Number.isFinite(openerOptions.timeout)).toBe(true);
  expect(openerOptions.timeout).toBeGreaterThan(0);
  expect(openerOptions.killSignal).toBe("SIGTERM");
});
it("rejects when the bounded opener is killed on timeout", async () => {
  const timeoutError = Object.assign(new Error("opener timed out"), {
    killed: true,
    signal: "SIGTERM",
  });
  vi.mocked(execFile).mockImplementationOnce(((
    _command: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null) => void,
  ) => callback(timeoutError)) as never);
  await expect(openExternalUrl("https://fixture.test/slow")).rejects.toMatchObject({
    killed: true,
    signal: "SIGTERM",
  });
});

// Exercise the real process lifecycle on POSIX: a helper that ignores SIGTERM
// must still be killed and the opener Promise must settle without waiting for
// execFile's own 10-second timeout. Windows uses its system PowerShell opener,
// which this test deliberately does not launch.
it.runIf(process.platform !== "win32")(
  "force-kills an opener that ignores SIGTERM",
  async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const realExecFile = actual.execFile;
    vi.doMock("node:child_process", () => ({
      ...actual,
      default: actual,
      execFile: ((command: string, args: string[], options: unknown, callback: unknown) => {
        if (command === "xdg-open")
          return realExecFile(
            process.execPath,
            ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
            options as never,
            callback as never,
          );
        return realExecFile(command, args, options as never, callback as never);
      }) as never,
    }));
    vi.resetModules();
    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      const { openExternalUrl: openWithRealProcesses } = await import("../external-url.js");
      const started = Date.now();
      await expect(openWithRealProcesses("https://fixture.test/stubborn")).rejects.toMatchObject({
        killed: true,
        signal: "SIGKILL",
      });
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  },
  12_000,
);
