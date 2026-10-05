import { afterEach, describe, expect, it } from "vitest";
import {
  AX_ENV_VAR,
  AX_FLAG,
  argvHasAxScreenReader,
  isAxScreenReaderEnabled,
  resetAxScreenReader,
  resolveAxScreenReader,
  VALUE_TAKING_FLAGS,
} from "../ax-screen-reader.js";

const NO_SETTINGS = { settings: undefined };
const argv = (...rest: string[]): string[] => ["node", "/x/cli.js", ...rest];

afterEach(() => {
  resetAxScreenReader();
  delete process.env[AX_ENV_VAR];
});

describe("argvHasAxScreenReader", () => {
  it("finds the bare flag", () => {
    expect(argvHasAxScreenReader(argv(AX_FLAG))).toBe(true);
  });

  it("is false without the flag", () => {
    expect(argvHasAxScreenReader(argv("-p", "hi"))).toBe(false);
  });

  it("matches whole elements, not substrings", () => {
    expect(argvHasAxScreenReader(argv("-p", `run claude ${AX_FLAG} now`))).toBe(false);
    expect(argvHasAxScreenReader(argv(`${AX_FLAG}=false`))).toBe(false);
  });

  it("stops at the -- separator", () => {
    expect(argvHasAxScreenReader(argv("--", AX_FLAG))).toBe(false);
    expect(argvHasAxScreenReader(argv(AX_FLAG, "--", "-p"))).toBe(true);
  });

  it("does not read the flag as another flag's value", () => {
    // `claude --model --ax-screen-reader` passes the flag text to --model.
    expect(argvHasAxScreenReader(argv("--model", AX_FLAG))).toBe(false);
  });

  it("still finds the flag after a value-taking flag consumed its value", () => {
    expect(argvHasAxScreenReader(argv("--model", "sonnet", AX_FLAG))).toBe(true);
  });

  it("knows the full value-taking set", () => {
    for (const flag of VALUE_TAKING_FLAGS) {
      expect(argvHasAxScreenReader(argv(flag, AX_FLAG))).toBe(false);
    }
  });
});

describe("resolveAxScreenReader precedence", () => {
  it("is off with nothing set", () => {
    expect(resolveAxScreenReader({ ...NO_SETTINGS, argv: argv("-p"), env: {} })).toEqual({
      enabled: false,
    });
  });

  it("takes the flag", () => {
    expect(resolveAxScreenReader({ argv: argv(AX_FLAG), env: {} })).toEqual({
      enabled: true,
      source: "flag",
    });
  });

  it("beats the env var and the settings key", () => {
    expect(
      resolveAxScreenReader({
        argv: argv(AX_FLAG),
        env: { [AX_ENV_VAR]: "" },
        settings: { screenReader: { axScreenReader: true } },
      }).source,
    ).toBe("flag");
  });

  it("beats an explicitly-empty env var", () => {
    // An empty env value DISABLES the mode, so only the flag can rescue it.
    expect(resolveAxScreenReader({ argv: argv(AX_FLAG), env: { [AX_ENV_VAR]: "" } }).enabled).toBe(
      true,
    );
    expect(resolveAxScreenReader({ argv: argv("-p"), env: { [AX_ENV_VAR]: "" } }).enabled).toBe(
      false,
    );
  });

  it("takes the env var over settings", () => {
    expect(
      resolveAxScreenReader({
        argv: argv("-p"),
        env: { [AX_ENV_VAR]: "1" },
        settings: { screenReader: { axScreenReader: false } },
      }),
    ).toEqual({ enabled: true, source: "env" });
  });

  it("takes settings last", () => {
    expect(
      resolveAxScreenReader({
        argv: argv("-p"),
        env: {},
        settings: { screenReader: { axScreenReader: true } },
      }),
    ).toEqual({ enabled: true, source: "settings" });
  });
});

describe("resolveAxScreenReader env truthiness", () => {
  // Official writes `e = t !== void 0 ? t : …` then tests `!e`, so the env
  // value is used verbatim: "0" and "false" are non-empty strings, i.e. ON.
  it.each(["1", "0", "false", "true", "no", "off", " "])("treats %j as enabled", (value) => {
    expect(resolveAxScreenReader({ argv: argv("-p"), env: { [AX_ENV_VAR]: value } })).toEqual({
      enabled: true,
      source: "env",
    });
  });

  it("treats only the empty string as disabled", () => {
    expect(resolveAxScreenReader({ argv: argv("-p"), env: { [AX_ENV_VAR]: "" } })).toEqual({
      enabled: false,
    });
  });
});

describe("resolveAxScreenReader settings strictness", () => {
  it("requires the nested key", () => {
    expect(
      resolveAxScreenReader({ argv: argv("-p"), env: {}, settings: { screenReader: {} } }).enabled,
    ).toBe(false);
  });

  it("requires exactly true", () => {
    for (const value of ["true", 1, {}, []]) {
      expect(
        resolveAxScreenReader({
          argv: argv("-p"),
          env: {},
          settings: { screenReader: { axScreenReader: value } },
        }).enabled,
      ).toBe(false);
    }
  });

  it("accepts true", () => {
    expect(
      resolveAxScreenReader({
        argv: argv("-p"),
        env: {},
        settings: { screenReader: { axScreenReader: true } },
      }).enabled,
    ).toBe(true);
  });

  it("survives a malformed settings object", () => {
    expect(
      resolveAxScreenReader({
        argv: argv("-p"),
        env: {},
        settings: { screenReader: "not-an-object" as unknown as { axScreenReader?: unknown } },
      }).enabled,
    ).toBe(false);
  });
});

describe("isAxScreenReaderEnabled", () => {
  it("caches the first answer", () => {
    expect(isAxScreenReaderEnabled({ screenReader: { axScreenReader: true } })).toBe(true);
    expect(isAxScreenReaderEnabled({ screenReader: { axScreenReader: false } })).toBe(true);
  });

  it("re-resolves after reset", () => {
    expect(isAxScreenReaderEnabled({ screenReader: { axScreenReader: false } })).toBe(false);
    resetAxScreenReader();
    expect(isAxScreenReaderEnabled({ screenReader: { axScreenReader: true } })).toBe(true);
  });

  it("defaults to off", () => {
    expect(isAxScreenReaderEnabled()).toBe(false);
  });

  it("reads the real process env after reset", () => {
    resetAxScreenReader();
    process.env[AX_ENV_VAR] = "1";
    expect(isAxScreenReaderEnabled()).toBe(true);
  });
});
