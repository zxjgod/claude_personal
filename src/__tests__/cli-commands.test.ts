import { describe, expect, it } from "vitest";
import { OFFICIAL_SUBCOMMANDS, resolveCliCommand } from "../cli-commands.js";

const ALL_ALIASES = OFFICIAL_SUBCOMMANDS.flatMap((s) => s.aliases);

describe("OFFICIAL_SUBCOMMANDS table", () => {
  it("covers the twelve top-level official subcommands", () => {
    const names = OFFICIAL_SUBCOMMANDS.map((s) => s.aliases[0]);
    expect(names).toEqual([
      "agents",
      "auth",
      "auto-mode",
      "doctor",
      "gateway",
      "install",
      "mcp",
      "plugin",
      "project",
      "setup-token",
      "ultrareview",
      "update",
    ]);
  });

  it("registers every alias spelling (plugin|plugins, update|upgrade)", () => {
    expect(ALL_ALIASES).toContain("plugins");
    expect(ALL_ALIASES).toContain("upgrade");
    expect(ALL_ALIASES.length).toBe(14);
  });

  it("never leaves a refusal empty", () => {
    for (const s of OFFICIAL_SUBCOMMANDS) {
      expect(s.refusal.length).toBeGreaterThan(0);
      expect(s.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveCliCommand", () => {
  it.each(ALL_ALIASES)("refuses %s by first token", (alias) => {
    const d = resolveCliCommand([alias]);
    expect(d.kind).toBe("reject");
    expect(d).toMatchObject({ message: expect.stringContaining("not sent to the model") });
  });

  it("names the gap for auth, pointing at API-key config", () => {
    expect(resolveCliCommand(["auth"])).toMatchObject({
      message: expect.stringContaining("no auth command"),
    });
    expect(resolveCliCommand(["auth"])).toMatchObject({ message: expect.stringContaining(".env") });
  });

  it("points update at the package manager", () => {
    expect(resolveCliCommand(["update"])).toMatchObject({
      message: expect.stringContaining("npm"),
    });
  });

  it("points mcp at the config file", () => {
    expect(resolveCliCommand(["mcp"])).toMatchObject({
      message: expect.stringContaining(".claude/mcp.json"),
    });
  });

  it("names the missing cloud backend for ultrareview", () => {
    expect(resolveCliCommand(["ultrareview"])).toMatchObject({
      message: expect.stringContaining("no cloud backend"),
    });
  });

  it("matches the first token only, not a later positional", () => {
    expect(resolveCliCommand(["--debug", "doctor"])).toEqual({ kind: "absent" });
    expect(resolveCliCommand(["prompt", "doctor"])).toEqual({ kind: "absent" });
  });

  it("is absent for flags", () => {
    expect(resolveCliCommand(["-p", "hi"])).toEqual({ kind: "absent" });
    expect(resolveCliCommand(["--cloud"])).toEqual({ kind: "absent" });
    expect(resolveCliCommand([])).toEqual({ kind: "absent" });
  });

  it("is absent for ordinary prompts and near-misses", () => {
    expect(resolveCliCommand(["hello there"])).toEqual({ kind: "absent" });
    expect(resolveCliCommand(["doctorwho"])).toEqual({ kind: "absent" });
    expect(resolveCliCommand(["updates"])).toEqual({ kind: "absent" });
    expect(resolveCliCommand(["auth2"])).toEqual({ kind: "absent" });
  });

  it("does not shadow fast-path tokens", () => {
    // The bridge aliases are resolved by fast-path before this layer runs,
    // so they are absent here; the bg job subcommands are bg-startup's.
    expect(resolveCliCommand(["remote"])).toEqual({ kind: "absent" });
    expect(resolveCliCommand(["logs"])).toEqual({ kind: "absent" });
  });
});
