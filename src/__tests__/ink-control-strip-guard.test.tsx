// Dependency-behavior guard: the TUI does not re-sanitize every string that
// flows into <Text>, because Ink strips the dangerous terminal control
// sequences (OSC titles, cursor/screen CSI, private modes, DCS/APC, bare ESC)
// from Text children at render time.
//
// Verified against the installed Ink version, the full behavior map is:
//   STRIPPED:  OSC (BEL/ST), erase/cursor/window CSI, private CSI, DCS, APC,
//              bare ESC
//   PRESERVED: SGR colors (required — chalk styling inside <Text> relies on
//              this), OSC 8 hyperlinks (Ink keeps links clickable), bare BEL
//
// The preserved set is safe ONLY because untrusted inputs are sanitized with
// sanitizeTerminalText before reaching <Text> (it strips SGR/OSC8/BEL too),
// while our own chalk styling is applied afterwards. If a future Ink upgrade
// changes either half of this map, the tests below fail loudly — that is the
// signal to re-audit the TUI layer.
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function frame(payload: string): string {
  const { lastFrame } = render(<Text>{`A${payload}B`}</Text>);
  return lastFrame() ?? "";
}

const STRIPPED: Array<[string, string]> = [
  ["OSC window title (BEL)", `${ESC}]0;pwned${BEL}`],
  ["OSC window title (ST)", `${ESC}]0;pwned${ESC}\\`],
  ["CSI erase display", `${ESC}[2J`],
  ["CSI erase line", `${ESC}[K`],
  ["CSI cursor up", `${ESC}[10A`],
  ["CSI cursor position", `${ESC}[5;5H`],
  ["CSI cursor hide (private)", `${ESC}[?25l`],
  ["CSI alt screen (private)", `${ESC}[?1049h`],
  ["CSI device status report", `${ESC}[6n`],
  ["CSI window manipulation", `${ESC}[8;24;80t`],
  ["DCS", `${ESC}P1;2|payload${ESC}\\`],
  ["APC", `${ESC}_Gpayload${ESC}\\`],
  ["bare ESC", `${ESC}x`],
];

describe("Ink <Text> control-sequence stripping (dependency guard)", () => {
  it("strips every sequence that can move the cursor, rewrite the screen, or set the title", () => {
    for (const [name, payload] of STRIPPED) {
      const out = frame(payload);
      expect(out, name).not.toContain(ESC);
      expect(out, name).not.toContain(BEL);
      expect(out, name).toBe("AB");
    }
  });

  it("preserves SGR styling and OSC 8 hyperlinks (chalk relies on this; untrusted input is sanitized instead)", () => {
    // SGR color passes through — our own chalk styling inside <Text> needs it.
    expect(frame(`${ESC}[31m`)).toContain(`${ESC}[31m`);
    // OSC 8 hyperlinks pass through — Ink keeps links clickable.
    expect(frame(`${ESC}]8;;https://example.com${BEL}`)).toContain(`${ESC}]8;;`);
  });
});
