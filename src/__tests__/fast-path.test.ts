import { describe, expect, it } from "vitest";
import {
  BRIDGE_ALIASES,
  BRIDGE_LOGIN_MESSAGE,
  CLOUD_TTY_MESSAGE,
  INTERNAL_WORKERS,
  resolveFastPath,
} from "../fast-path.js";

const argv = (...rest: string[]): string[] => rest;

describe("internal worker entry points", () => {
  it("covers all seven, in official's set", () => {
    expect(Object.keys(INTERNAL_WORKERS)).toEqual([
      "--claude-in-chrome-mcp",
      "--chrome-native-host",
      "--computer-use-mcp",
      "--daemon-worker",
      "--bg-pty-host",
      "--bg-spare",
      "--preload",
    ]);
  });

  it.each(Object.keys(INTERNAL_WORKERS))("refuses %s by first positional", (flag) => {
    const d = resolveFastPath(argv(flag));
    expect(d.kind).toBe("reject");
    expect(d).toMatchObject({ message: expect.stringContaining("internal claude worker") });
  });

  it("quotes official's bare error for --bg-spare", () => {
    expect(resolveFastPath(argv("--bg-spare"))).toMatchObject({
      message: expect.stringContaining("[bg-spare] missing claim sock path"),
    });
  });

  it("quotes official's bare error for --daemon-worker", () => {
    expect(resolveFastPath(argv("--daemon-worker"))).toMatchObject({
      message: expect.stringContaining("unknown worker kind: undefined"),
    });
  });

  it("omits the bare-error aside for workers that have none", () => {
    expect(resolveFastPath(argv("--preload"))).toMatchObject({
      message: expect.not.stringContaining("Invoked bare"),
    });
  });

  it("does not match an internal worker in a later position", () => {
    expect(resolveFastPath(argv("prompt", "--bg-spare"))).toEqual({ kind: "absent" });
  });
});

describe("bridge aliases", () => {
  it.each(BRIDGE_ALIASES)("refuses %s with official's login gate", (alias) => {
    expect(resolveFastPath(argv(alias))).toEqual({ kind: "reject", message: BRIDGE_LOGIN_MESSAGE });
  });

  it("only matches the first positional", () => {
    expect(resolveFastPath(argv("prompt", "sync"))).toEqual({ kind: "absent" });
  });

  it("uses official's verbatim wording", () => {
    expect(BRIDGE_LOGIN_MESSAGE).toContain("You must be logged in to use Remote Control.");
    expect(BRIDGE_LOGIN_MESSAGE).toContain("claude.ai subscriptions");
    expect(BRIDGE_LOGIN_MESSAGE).toContain("/login");
  });
});

describe("--cloud / --remote", () => {
  it("refuses --cloud with official's TTY message when not a TTY", () => {
    expect(resolveFastPath(argv("--cloud", "task"), { isTTY: false })).toEqual({
      kind: "reject",
      message: CLOUD_TTY_MESSAGE,
    });
  });

  it("refuses --remote the same way", () => {
    expect(resolveFastPath(argv("--remote"), { isTTY: false })).toEqual({
      kind: "reject",
      message: CLOUD_TTY_MESSAGE,
    });
  });

  it("matches the = form", () => {
    expect(resolveFastPath(argv("--cloud=x"), { isTTY: false })).toEqual({
      kind: "reject",
      message: CLOUD_TTY_MESSAGE,
    });
    expect(resolveFastPath(argv("--remote=x"), { isTTY: false })).toEqual({
      kind: "reject",
      message: CLOUD_TTY_MESSAGE,
    });
  });

  it("names the gap on a TTY instead of official's TTY message", () => {
    const d = resolveFastPath(argv("--cloud", "task"), { isTTY: true });
    expect(d.kind).toBe("reject");
    expect(d).toMatchObject({ message: expect.stringContaining("cloud backend") });
    expect(d).not.toEqual({ kind: "reject", message: CLOUD_TTY_MESSAGE });
    expect(d).toMatchObject({
      message: expect.not.stringContaining("requires an interactive terminal.\nNon-interactive"),
    });
  });

  it("quotes the flag the user typed", () => {
    expect(resolveFastPath(argv("--remote", "task"), { isTTY: true })).toMatchObject({
      message: expect.stringContaining("'--remote'"),
    });
  });

  it("defers to the bg resolver when --bg is present", () => {
    expect(resolveFastPath(argv("--bg", "--cloud", "x"), { isTTY: false })).toEqual({
      kind: "absent",
    });
  });

  it("finds the cloud flag anywhere in argv, not just first", () => {
    expect(resolveFastPath(argv("do a thing", "--cloud"), { isTTY: false })).toEqual({
      kind: "reject",
      message: CLOUD_TTY_MESSAGE,
    });
  });
});

describe("absence", () => {
  it("is absent for an ordinary prompt", () => {
    expect(resolveFastPath(argv("hi there"))).toEqual({ kind: "absent" });
    expect(resolveFastPath(argv("-p", "hi"))).toEqual({ kind: "absent" });
  });

  it("is absent for --bg itself (handled by the bg resolver)", () => {
    expect(resolveFastPath(argv("--bg", "x"))).toEqual({ kind: "absent" });
  });

  it("does not confuse a near-miss with an internal worker", () => {
    expect(resolveFastPath(argv("--bg-spare-extra"))).toEqual({ kind: "absent" });
    expect(resolveFastPath(argv("--preloader"))).toEqual({ kind: "absent" });
    expect(resolveFastPath(argv("synclog"))).toEqual({ kind: "absent" });
  });
});
