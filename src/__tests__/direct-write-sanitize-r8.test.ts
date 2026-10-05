import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserPrompters } from "../cli-prompts.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ROOT = path.resolve(__dirname, "..");
const readSrc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

describe("cli-prompts non-TTY question print (model input)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("strips control sequences from header/question/labels but returns original labels", async () => {
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.join(" "));
    });
    const prompters = createUserPrompters({
      isInteractive: false,
      askQuestion: async () => "1",
    });
    const evil = `evil${ESC}]8;;http://x${BEL}link`;
    const answers = await prompters.askUserQuestion({
      header: `H${ESC}[2J`,
      question: evil,
      options: [{ label: `yes${ESC}]0;pwn${BEL}` }, { label: "no" }],
      multiSelect: false,
    });
    const out = printed.join("\n");
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    // The RETURN value keeps the original label — display is sanitized, the
    // model-facing answer is not (round-trip key semantics).
    expect(answers).toEqual([`yes${ESC}]0;pwn${BEL}`]);
  });
});

describe("source guards — untrusted interpolation sanitized at raw-write surfaces", () => {
  it("cli-prompts sanitizes the model-proposed 'always allow' echo", () => {
    const src = readSrc("cli-prompts.ts");
    const echoes = src.match(/已记住: \$\{sanitizeTerminalText\(/g) ?? [];
    expect(echoes.length).toBe(2);
  });

  it("cli-interactive sanitizes both TTY menus (permission + select)", () => {
    const src = readSrc(path.join("tui", "cli-interactive.ts"));
    // promptPermissionMenu: header/detail/riskHint sanitized once up front
    expect(src).toContain("sanitizeTerminalText(opts.detail)");
    expect(src).toContain("sanitizeTerminalText(opts.riskHint)");
    // promptSelectMenu: header/question + option labels/descriptions
    expect(src).toContain("sanitizeTerminalText(opts.question)");
    expect(src).toContain("label: sanitizeTerminalText(opt.label)");
    // Region.paint must still write raw lines — the sanitize is upstream of it.
    expect(src).toContain("out.write(lines.join");
  });

  it("mcp trust-prompt descriptions are sanitized at the builder", () => {
    const src = readSrc(path.join("mcp", "index.ts"));
    expect(src).toMatch(/return sanitizeTerminalText\(\s*`?\$\{name\} \(\$\{server\.type\}\)/);
  });

  it("commands.ts sanitizes fork-skill output and load errors", () => {
    const src = readSrc("commands.ts");
    expect(src).toContain("const out = sanitizeTerminalText(result.content)");
    expect(src).toContain("failed to load: ${sanitizeTerminalText(detail)}");
  });

  it("cli-tools sanitizes disk skill names in the load report", () => {
    const src = readSrc("cli-tools.ts");
    expect(src).toContain("loaded.map(sanitizeTerminalText)");
  });
});
