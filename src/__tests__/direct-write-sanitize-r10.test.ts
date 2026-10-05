import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPermissionPrompt } from "../tui/cli-renderer.js";
import { formatCommandMenuRow } from "../tui/command-menu-layout.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC52 = `${ESC}]52;c;SGVsbG8=${BEL}`;

describe("command menu rows (skill dir names + frontmatter descriptions)", () => {
  it("strips control sequences from name and description", () => {
    const evil = { name: `sk${ESC}[2Jill`, description: `does x${OSC52}` };
    const row = formatCommandMenuRow(evil, false, [evil], 120);
    expect(row).not.toContain(ESC);
    expect(row).not.toContain(BEL);
    expect(row).toContain("skill");
    expect(row).toContain("does x");
  });
});

describe("renderPermissionPrompt riskHint (LLM classifier output)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("strips control sequences from the risk hint", () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    renderPermissionPrompt("bash", { command: "ls" }, `careful${OSC52}indeed`);
    const out = written.join("");
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    expect(out).toContain("careful");
  });
});
