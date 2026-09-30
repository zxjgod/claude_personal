// ============================================================
// Tests: live theme switching (applyTheme mutates the palette in place)
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, currentTheme, palette } from "../tui/theme.js";

afterEach(() => {
  applyTheme("dark"); // never leak a theme into other test files
});

describe("applyTheme", () => {
  it("dark is the default theme", () => {
    expect(currentTheme()).toBe("dark");
    expect(palette.commandSelected).toBe("#b1b9f9");
  });

  it("light switches palette values to the official light literals", () => {
    applyTheme("light");
    expect(currentTheme()).toBe("light");
    expect(palette.commandSelected).toBe("#4b50a8");
    expect(palette.success).toBe("#2c7a39"); // official light rgb(44,122,57)
    expect(palette.error).toBe("#ab2b3f");
    expect(palette.modeColors.plan).toBe("#006666"); // official light teal
    expect(palette.modeColors.acceptEdits).toBe("#8700ff");
  });

  it("switching back to dark restores the dark values", () => {
    const darkSuccess = palette.success;
    applyTheme("light");
    applyTheme("dark");
    expect(currentTheme()).toBe("dark");
    expect(palette.success).toBe(darkSuccess);
    expect(palette.commandSelected).toBe("#b1b9f9");
    expect(palette.modeColors.plan).toBe("#4ec9b0");
  });

  it("unknown names fall back to dark", () => {
    expect(applyTheme("solarized")).toBe("dark");
    expect(currentTheme()).toBe("dark");
  });

  it("palette identity is stable across switches (live mutation, not swap)", () => {
    const before = palette;
    applyTheme("light");
    expect(palette).toBe(before); // same object — render-time readers see new values
  });
});
