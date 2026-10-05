import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDiskEntries } from "../utils/disk-loader.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("disk-loader warn sanitization (untrusted disk content)", () => {
  afterEach(() => vi.restoreAllMocks());

  const makeRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-diskloader-"));
    fs.writeFileSync(path.join(root, "a.md"), "x");
    fs.writeFileSync(path.join(root, "b.md"), "y");
    return root;
  };

  const baseOpts = (root: string) => ({
    roots: [root],
    accepts: (d: fs.Dirent) => d.isFile(),
    nameOf: (d: fs.Dirent) => d.name,
    fileOf: (r: string, d: fs.Dirent) => path.join(r, d.name),
    register: () => {},
  });

  it("strips control sequences from the parse-error warn", () => {
    const root = makeRoot();
    try {
      const warnings: string[] = [];
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.join(" "));
      });
      loadDiskEntries({
        ...baseOpts(root),
        parse: () => {
          throw new Error(`invalid frontmatter${ESC}[2J${BEL}`);
        },
      });
      expect(warnings.length).toBeGreaterThan(0);
      const out = warnings.join("\n");
      expect(out).not.toContain(ESC);
      expect(out).not.toContain(BEL);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips control sequences from the duplicate-name warn", () => {
    const root = makeRoot();
    try {
      const warnings: string[] = [];
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.join(" "));
      });
      loadDiskEntries({
        ...baseOpts(root),
        parse: (entry) => entry.name,
        loadedName: () => `dup${ESC}]0;pwn${BEL}`,
      });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).not.toContain(ESC);
      expect(warnings[0]).not.toContain(BEL);
      expect(warnings[0]).toContain("dup");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
