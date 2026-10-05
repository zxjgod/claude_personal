import { describe, expect, it } from "vitest";
import {
  BG_SUBCOMMAND_USAGE,
  BG_SUBCOMMANDS,
  BG_SUPERVISOR_NOUN,
  checkBgConflicts,
  fleetDisabledReason,
  fleetGateMessage,
  formatBackgroundedBanner,
  hasBgFlag,
  isAgentsFleetEnabled,
  notImplementedBanner,
  resolveBgStartup,
  resolveJobIdArg,
  selectsPrint,
} from "../bg-startup.js";

const argv = (...rest: string[]): string[] => rest;
const GATE_OFF = { env: { CLAUDE_CODE_DISABLE_AGENT_VIEW: "1" } };
const CLEAN = { env: {} as Record<string, string | undefined> };

describe("the feature gate", () => {
  it("is on by default", () => {
    expect(isAgentsFleetEnabled(CLEAN)).toBe(true);
    expect(fleetDisabledReason(CLEAN)).toBeNull();
  });

  it("is off via the env var, using official's wording", () => {
    expect(fleetDisabledReason(GATE_OFF)).toBe("is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW");
  });

  it("treats an empty env var as off", () => {
    // Official's env helper is a length test, not a boolean parse.
    expect(fleetDisabledReason({ env: { CLAUDE_CODE_DISABLE_AGENT_VIEW: "" } })).toBeNull();
  });

  it("is off via the setting, and only for exactly true", () => {
    expect(fleetDisabledReason({ env: {}, settings: { disableAgentView: true } })).toBe(
      "is disabled by the 'disableAgentView' setting",
    );
    expect(fleetDisabledReason({ env: {}, settings: { disableAgentView: "true" } })).toBeNull();
  });

  it("prefers the env var over the setting", () => {
    expect(fleetDisabledReason({ ...GATE_OFF, settings: { disableAgentView: true } })).toBe(
      "is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW",
    );
  });

  it("formats the refusal with the target quoted", () => {
    expect(fleetGateMessage("--background", GATE_OFF)).toBe(
      "'--background' is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW.",
    );
    expect(fleetGateMessage("stop", GATE_OFF)).toBe(
      "'stop' is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW.",
    );
  });

  it("falls back to the env-less wording when nothing explains it", () => {
    expect(fleetGateMessage("--bg", CLEAN)).toBe("'--bg' is not available in this environment.");
  });
});

describe("selectsPrint", () => {
  it("matches official's three unambiguous forms", () => {
    expect(selectsPrint("--print")).toBe(true);
    expect(selectsPrint("--print=1")).toBe(true);
    expect(selectsPrint("-p")).toBe(true);
    expect(selectsPrint("-pHi")).toBe(true);
  });

  it("does not match unrelated tokens", () => {
    for (const t of ["-P", "--printx", "--pretty", "-x", "prompt", "--print-only"]) {
      expect(selectsPrint(t)).toBe(false);
    }
  });
});

describe("checkBgConflicts", () => {
  it("passes a clean command line", () => {
    expect(checkBgConflicts(argv("--bg", "do a thing"))).toBeNull();
  });

  it("reports the cloud conflict first, ahead of --print", () => {
    expect(checkBgConflicts(argv("--bg", "--print", "--cloud", "x"))).toBe(
      "--bg and --cloud are different backends. Use `claude --cloud '<task>'` directly to start a cloud session.",
    );
  });

  it("treats --remote as --cloud", () => {
    expect(checkBgConflicts(argv("--bg", "--remote"))).toContain(
      "--bg and --cloud are different backends",
    );
    expect(checkBgConflicts(argv("--bg", "--remote=1"))).toContain("different backends");
  });

  it("reports the --print conflict verbatim", () => {
    expect(checkBgConflicts(argv("--bg", "--print", "x"))).toBe(
      "--bg and --print conflict: --print never starts the interactive session that `claude agents` attaches to, so the job would be unattachable. The prompt is the positional — drop --print: `claude --bg '<task>'`.",
    );
  });

  it("honours an injected hasPrint", () => {
    expect(checkBgConflicts(argv("--bg"), { hasPrint: true })).toContain(
      "--bg and --print conflict",
    );
    expect(checkBgConflicts(argv("--bg", "--print"), { hasPrint: false })).toBeNull();
  });

  it.each([
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
  ])("refuses %s until the disclaimer is accepted", (flag) => {
    const expected =
      "--bg with bypassPermissions requires accepting the disclaimer first. Run `claude --dangerously-skip-permissions` once interactively.";
    expect(checkBgConflicts(argv("--bg", flag))).toBe(expected);
    expect(checkBgConflicts(argv("--bg", flag), { bypassAccepted: true })).toBeNull();
  });

  it("refuses permission-mode bypassPermissions too", () => {
    expect(checkBgConflicts(argv("--bg"), { permissionMode: "bypassPermissions" })).toContain(
      "requires accepting the disclaimer",
    );
    expect(
      checkBgConflicts(argv("--bg"), { permissionMode: "bypassPermissions", bypassAccepted: true }),
    ).toBeNull();
  });

  it("refuses auto mode until it is opted into", () => {
    expect(checkBgConflicts(argv("--bg"), { permissionMode: "auto" })).toBe(
      "--bg with auto mode requires opting in first. Run `claude --permission-mode auto` once interactively.",
    );
    expect(
      checkBgConflicts(argv("--bg"), { permissionMode: "auto", autoOptedIn: true }),
    ).toBeNull();
  });

  it("leaves other permission modes alone", () => {
    for (const mode of ["default", "acceptEdits", "plan"]) {
      expect(checkBgConflicts(argv("--bg"), { permissionMode: mode })).toBeNull();
    }
  });

  it("checks the conflicts in official's order", () => {
    // bypassPermissions is checked after --print, so --print wins.
    expect(checkBgConflicts(argv("--bg", "--print", "--dangerously-skip-permissions"))).toContain(
      "--print conflict",
    );
  });
});

describe("hasBgFlag", () => {
  it("accepts both spellings and rejects near-misses", () => {
    expect(hasBgFlag(argv("--bg"))).toBe(true);
    expect(hasBgFlag(argv("--background"))).toBe(true);
    expect(hasBgFlag(argv("--bg=true"))).toBe(false);
    expect(hasBgFlag(argv("--bgish"))).toBe(false);
  });
});

describe("resolveBgStartup", () => {
  it("is absent when nothing background-related is present", () => {
    expect(resolveBgStartup(argv("-p", "hi"), CLEAN)).toEqual({ kind: "absent" });
    expect(resolveBgStartup(argv("stopwatch"), CLEAN)).toEqual({ kind: "absent" });
  });

  it("routes each subcommand with its argument", () => {
    for (const name of BG_SUBCOMMANDS) {
      expect(resolveBgStartup(argv(name, "abc123"), CLEAN)).toEqual({
        kind: "subcommand",
        name,
        arg: "abc123",
      });
    }
  });

  it("reports a missing argument as undefined rather than guessing", () => {
    expect(resolveBgStartup(argv("stop"), CLEAN)).toEqual({
      kind: "subcommand",
      name: "stop",
      arg: undefined,
    });
  });

  it("refuses the flag, naming the gap", () => {
    const d = resolveBgStartup(argv("--bg", "do a thing"), CLEAN);
    expect(d.kind).toBe("reject");
    expect(d).toMatchObject({ message: expect.stringContaining(BG_SUPERVISOR_NOUN) });
  });

  it("quotes the flag the user actually typed", () => {
    expect(resolveBgStartup(argv("--background"), CLEAN)).toEqual({
      kind: "reject",
      message: notImplementedBanner("--background"),
    });
    expect(resolveBgStartup(argv("--bg"), CLEAN)).toEqual({
      kind: "reject",
      message: notImplementedBanner("--bg"),
    });
  });

  it("checks the gate BEFORE the conflicts, as official does", () => {
    // With the fleet off, --print is never mentioned — this ordering is
    // observable, and getting it backwards changes the message.
    expect(resolveBgStartup(argv("--bg", "--print"), GATE_OFF)).toEqual({
      kind: "reject",
      message: "'--bg' is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW.",
    });
  });

  it("gates subcommands too, with the subcommand as the target", () => {
    expect(resolveBgStartup(argv("logs", "abc"), GATE_OFF)).toEqual({
      kind: "reject",
      message: "'logs' is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW.",
    });
  });

  it("falls back to --bg as the gate target for an unrecognised spelling", () => {
    expect(resolveBgStartup(argv("--routine", "daily"), GATE_OFF)).toMatchObject({
      kind: "absent",
    });
  });
});

describe("formatBackgroundedBanner", () => {
  it("matches official's layout: id line then four padded hints", () => {
    const lines = formatBackgroundedBanner("806fef73").split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("backgrounded · 806fef73");
    expect(lines[1]).toBe("  claude agents             list sessions");
    expect(lines[2]).toBe("  claude attach 806fef73    open in this terminal");
    expect(lines[3]).toBe("  claude logs 806fef73      show recent output");
    expect(lines[4]).toBe("  claude stop 806fef73      stop this session");
  });

  it("appends a detail segment and a trailer", () => {
    const lines = formatBackgroundedBanner("806fef73", "(idle — send a prompt to start)").split(
      "\n",
    );
    expect(lines[0]).toBe("backgrounded · 806fef73 · (idle — send a prompt to start)");
  });

  it("concatenates with no separator when the id overflows the column", () => {
    // Official pads the command to 26 and stops there; a longer command
    // runs straight into the description with no added space. Faithful.
    const lines = formatBackgroundedBanner("a-very-long-background-id").split("\n");
    expect(lines[2]).toBe("  claude attach a-very-long-background-idopen in this terminal");
  });
});

describe("resolveJobIdArg", () => {
  const usage = BG_SUBCOMMAND_USAGE.stop.usage;

  it("reports usage when no id is given", () => {
    expect(resolveJobIdArg(undefined, usage)).toEqual({
      kind: "usage",
      message: "Usage: claude stop <id>",
    });
  });

  it("rejects an option in the id position", () => {
    expect(resolveJobIdArg("--all", usage)).toEqual({
      kind: "error",
      message: "unknown option '--all'\nUsage: claude stop <id>",
    });
  });

  it("reports no match, in official's wording", () => {
    expect(resolveJobIdArg("deadbeef", usage)).toEqual({
      kind: "error",
      message: "No job matching 'deadbeef'. Run 'claude agents' to list running sessions.",
    });
  });

  it("lets rm use the bare form, matching its own resolver", () => {
    expect(resolveJobIdArg("deadbeef", usage, [], { agentsHint: false })).toEqual({
      kind: "error",
      message: "No job matching 'deadbeef'",
    });
  });

  it("resolves a unique prefix", () => {
    expect(resolveJobIdArg("80", usage, ["806fef73", "a764094c"])).toEqual({
      kind: "id",
      id: "806fef73",
    });
  });

  it("reports an ambiguous prefix", () => {
    expect(resolveJobIdArg("8", usage, ["806fef73", "81234567"])).toEqual({
      kind: "error",
      message: "Ambiguous prefix '8', matches: 806fef73, 81234567",
    });
  });
});

describe("BG_SUBCOMMAND_USAGE", () => {
  it("gives kill the stop usage, because it is a pure alias", () => {
    expect(BG_SUBCOMMAND_USAGE.kill.usage).toBe(BG_SUBCOMMAND_USAGE.stop.usage);
  });

  it("keeps respawn's two-form usage", () => {
    expect(BG_SUBCOMMAND_USAGE.respawn.usage).toBe("claude respawn <id>|--all");
  });

  it("covers every subcommand", () => {
    for (const name of BG_SUBCOMMANDS) {
      expect(BG_SUBCOMMAND_USAGE[name].summary.length).toBeGreaterThan(0);
    }
  });
});
