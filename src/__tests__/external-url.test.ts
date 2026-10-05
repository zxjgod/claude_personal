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
  if (process.platform === "win32") {
    // CWD-hijack fix: an ABSOLUTE System32 path, never the bare name
    // (CreateProcess searches the current directory for bare names).
    expect(
      String(command).toLowerCase().endsWith("\\system32\\windowspowershell\\v1.0\\powershell.exe"),
    ).toBe(true);
    expect(String(command)).not.toBe("powershell.exe");
    expect(args).not.toContain(value);
    expect((options as { env: Record<string, string> }).env.CCR_EXTERNAL_URL).toBe(value);
  } else expect(args).toContain(value);
});
