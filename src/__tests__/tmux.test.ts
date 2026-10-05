import { describe, expect, it } from "vitest";
import { parseTmuxFlag } from "../cli-session-flags.js";
import {
  decideTmuxStartup,
  type OfficialPlatform,
  resolveOfficialPlatform,
  resolveTmuxStartup,
  type TmuxStartupDecision,
  tmuxInstallInstructions,
} from "../tmux.js";

/** process.argv shape: node, script, …rest */
const argv = (...rest: string[]): string[] => ["node", "/x/cli.js", ...rest];

const ALL_PLATFORMS: OfficialPlatform[] = ["macos", "linux", "wsl", "windows", "other"];

/** Narrow away the `absent` variant so tests can read `.message` directly. */
function messageOf(decision: TmuxStartupDecision): string {
  if (decision.kind === "absent") throw new Error("expected a message-bearing decision");
  return decision.message;
}

const reject = (...rest: string[]): { kind: string; message: string } => {
  const decision = decideTmuxStartup(parseTmuxFlag(argv(...rest)), "windows", false);
  return { kind: decision.kind, message: messageOf(decision) };
};

describe("parseTmuxFlag", () => {
  it("is absent with no --tmux on the line", () => {
    expect(parseTmuxFlag(argv("-p", "hi")).present).toBe(false);
  });

  it("detects the bare flag", () => {
    expect(parseTmuxFlag(argv("--tmux"))).toEqual({ present: true, worktreeRequested: false });
  });

  it("records the inline value", () => {
    expect(parseTmuxFlag(argv("--tmux=classic", "-w", "x"))).toEqual({
      present: true,
      value: "classic",
      worktreeRequested: true,
    });
  });

  it("records an arbitrary inline value verbatim", () => {
    expect(parseTmuxFlag(argv("--tmux=other", "-w", "x")).value).toBe("other");
  });

  it("sees all three worktree spellings", () => {
    expect(parseTmuxFlag(argv("--tmux", "-w")).worktreeRequested).toBe(true);
    expect(parseTmuxFlag(argv("--tmux", "--worktree")).worktreeRequested).toBe(true);
    expect(parseTmuxFlag(argv("--tmux", "--worktree=named")).worktreeRequested).toBe(true);
  });

  it("ignores --tmux inside a prompt string", () => {
    // official matches exact argv elements, so a -p payload is one element.
    expect(parseTmuxFlag(argv("-p", "run claude --tmux now")).present).toBe(false);
  });

  it("ignores --tmux in the node/script prefix", () => {
    expect(parseTmuxFlag(["--tmux", "/x/cli.js"]).present).toBe(false);
  });
});

describe("resolveOfficialPlatform", () => {
  it("maps node platforms onto official's tokens", () => {
    expect(resolveOfficialPlatform("darwin")).toBe("macos");
    expect(resolveOfficialPlatform("linux")).toBe("linux");
    expect(resolveOfficialPlatform("win32")).toBe("windows");
    expect(resolveOfficialPlatform("aix")).toBe("other");
  });

  it("defaults to the running platform", () => {
    expect(resolveOfficialPlatform()).toBe(resolveOfficialPlatform(process.platform));
  });
});

describe("tmuxInstallInstructions", () => {
  it("uses brew on macos", () => {
    const hint = tmuxInstallInstructions("macos");
    expect(hint).toMatch(/brew install tmux/);
    expect(hint).toMatch(/tmux new-session -s claude$/);
  });

  it("offers apt AND dnf on linux and wsl", () => {
    for (const platform of ["linux", "wsl"] as OfficialPlatform[]) {
      const hint = tmuxInstallInstructions(platform);
      expect(hint).toMatch(/sudo apt install tmux {4}# Ubuntu\/Debian/);
      expect(hint).toMatch(/sudo dnf install tmux {4}# Fedora\/RHEL/);
      expect(hint).not.toMatch(/brew/);
    }
  });

  it("routes windows through WSL", () => {
    expect(tmuxInstallInstructions("windows")).toMatch(/requires WSL/);
  });

  it("falls back to the generic package-manager line", () => {
    expect(tmuxInstallInstructions("other")).toMatch(
      /install tmux using your system's package manager/,
    );
  });

  it("always ends with the same session hint", () => {
    for (const platform of ALL_PLATFORMS) {
      expect(tmuxInstallInstructions(platform)).toMatch(/Then start a tmux session with: /);
    }
  });
});

describe("decideTmuxStartup", () => {
  it("does nothing without the flag", () => {
    expect(decideTmuxStartup(parseTmuxFlag(argv("-w")), "windows", false).kind).toBe("absent");
  });

  it("rejects a bare --tmux with no worktree flag", () => {
    expect(reject("--tmux")).toEqual({
      kind: "reject",
      message: "Error: --tmux requires --worktree",
    });
  });

  it("rejects --tmux=classic with no worktree flag as an unknown option", () => {
    expect(reject("--tmux=classic")).toEqual({
      kind: "reject",
      message: "error: unknown option '--tmux=classic'",
    });
  });

  it("rejects on Windows once a worktree flag is present", () => {
    for (const args of [
      ["--tmux", "-w"],
      ["--tmux", "--worktree"],
      ["--tmux=classic", "-w"],
    ]) {
      expect(reject(...args)).toEqual({
        kind: "reject",
        message: "Error: --tmux is not supported on Windows",
      });
    }
  });

  it("never reaches the platform gate without a worktree flag", () => {
    // The fast path needs one, so the worktree error always wins.
    expect(reject("--tmux").message).toBe("Error: --tmux requires --worktree");
  });

  it("reports a missing tmux with platform instructions", () => {
    const decision = decideTmuxStartup(parseTmuxFlag(argv("--tmux", "-w")), "linux", false);
    expect(decision.kind).toBe("reject");
    const message = messageOf(decision);
    expect(message).toMatch(/^Error: tmux is not installed\.\n/);
    expect(message).toMatch(/sudo apt install tmux/);
  });

  it("names the missing dependency instead of hiding it", () => {
    const decision = decideTmuxStartup(parseTmuxFlag(argv("--tmux", "-w")), "macos", false);
    expect(messageOf(decision)).toMatch(/brew install tmux/);
  });

  it("does not blame tmux on Windows even when the probe says missing", () => {
    // Platform gate precedes the probe, matching the binary's order.
    expect(reject("--tmux", "-w").message).toBe("Error: --tmux is not supported on Windows");
  });

  it("rejects a non-classic value even with a worktree flag", () => {
    // The fast path only matches the literal "classic".
    expect(reject("--tmux=other", "-w")).toEqual({
      kind: "reject",
      message: "error: unknown option '--tmux=other'",
    });
  });

  it("admits the gap when tmux is present but panes are not implemented", () => {
    const decision = decideTmuxStartup(parseTmuxFlag(argv("--tmux", "-w")), "linux", true);
    expect(decision.kind).toBe("not-implemented");
    const message = messageOf(decision);
    expect(message).toMatch(/does not implement/);
    expect(message).toMatch(/tmux IS installed/);
  });
});

describe("resolveTmuxStartup", () => {
  it("skips the probe entirely when the flag is absent", async () => {
    let probed = false;
    const decision = await resolveTmuxStartup(argv("-w", "x"), {
      platform: "windows",
      probe: async () => {
        probed = true;
        return true;
      },
    });
    expect(decision.kind).toBe("absent");
    expect(probed).toBe(false);
  });

  it("passes the probe result through", async () => {
    const missing = await resolveTmuxStartup(argv("--tmux", "-w"), {
      platform: "linux",
      probe: async () => false,
    });
    expect(messageOf(missing)).toMatch(/tmux is not installed/);

    const present = await resolveTmuxStartup(argv("--tmux", "-w"), {
      platform: "linux",
      probe: async () => true,
    });
    expect(present.kind).toBe("not-implemented");
  });

  it("forwards the timeout to the probe", async () => {
    let seen = 0;
    await resolveTmuxStartup(argv("--tmux", "-w"), {
      platform: "linux",
      timeoutMs: 1234,
      probe: async (timeout) => {
        seen = timeout;
        return false;
      },
    });
    expect(seen).toBe(1234);
  });

  it("rejects before probing on the win32 fast path", async () => {
    // Platform gate wins, so a Windows machine never spawns tmux -V.
    let probed = false;
    const decision = await resolveTmuxStartup(argv("--tmux", "-w"), {
      platform: "windows",
      probe: async () => {
        probed = true;
        return true;
      },
    });
    expect(messageOf(decision)).toBe("Error: --tmux is not supported on Windows");
    expect(probed).toBe(false);
  });
});
