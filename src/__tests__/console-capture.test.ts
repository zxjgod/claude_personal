import { afterEach, describe, expect, it, vi } from "vitest";
import { captureConsole } from "../tui/run.js";

const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
});

describe("captureConsole async ownership", () => {
  it("keeps overlapping captures separate when they finish in reverse order", async () => {
    const outside = vi.fn();
    console.log = outside;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));

    const first = captureConsole(async () => {
      console.log("first:before");
      await firstGate;
      console.log("first:after");
      return "first";
    });
    const second = captureConsole(async () => {
      console.log("second:before");
      await secondGate;
      console.log("second:after");
      return "second";
    });
    console.log("not captured");

    releaseSecond();
    await expect(second).resolves.toEqual({
      lines: ["second:before", "second:after"],
      result: "second",
    });
    releaseFirst();
    await expect(first).resolves.toEqual({
      lines: ["first:before", "first:after"],
      result: "first",
    });
    expect(outside).toHaveBeenCalledWith("not captured");
    expect(outside).toHaveBeenCalledTimes(1);
  });
});
