// ============================================================
// Tests: Tool Result Spill (M30)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_RESULT_CHARS, SPILL_DIR, spillIfLarge } from "../tools/result-spill.js";

describe("spillIfLarge (M30)", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-spill-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const opts = (extra: Partial<Parameters<typeof spillIfLarge>[1]> = {}) => ({
    toolName: "bash",
    workspaceRoot,
    sessionId: "sess1",
    ...extra,
  });

  it("returns content unchanged when under the budget", () => {
    const out = spillIfLarge("small output", opts({ maxChars: 1000 }));
    expect(out).toBe("small output");
    // Nothing written.
    expect(fs.existsSync(path.join(workspaceRoot, SPILL_DIR))).toBe(false);
  });

  it("returns content unchanged exactly at the budget (boundary)", () => {
    const content = "x".repeat(100);
    const out = spillIfLarge(content, opts({ maxChars: 100 }));
    expect(out).toBe(content);
  });

  it("never spills when maxChars is Infinity (Read opt-out)", () => {
    const content = "y".repeat(DEFAULT_MAX_RESULT_CHARS * 2);
    const out = spillIfLarge(content, opts({ maxChars: Number.POSITIVE_INFINITY }));
    expect(out).toBe(content);
    expect(fs.existsSync(path.join(workspaceRoot, SPILL_DIR))).toBe(false);
  });

  it("spills oversized content to disk and returns a head+tail preview + path", () => {
    const head = "HEAD".repeat(4000); // 16k
    const tail = "TAIL".repeat(2000); // 8k
    const content = `${head}${tail}`;
    const out = spillIfLarge(content, opts({ maxChars: 1000 }));

    // The preview is far shorter than the original.
    expect(out.length).toBeLessThan(content.length);
    // Head and tail are both represented.
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("read tool");

    // A spill file was written and contains the FULL original content.
    const dir = path.join(workspaceRoot, SPILL_DIR);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("sess1");
    expect(files[0]).toContain("bash");
    const written = fs.readFileSync(path.join(dir, files[0]!), "utf-8");
    expect(written).toBe(content);
    // The model-facing notice names the path.
    expect(out).toContain(path.join(dir, files[0]!));
  });

  it("uses the default cap when maxChars is omitted", () => {
    const under = "z".repeat(DEFAULT_MAX_RESULT_CHARS);
    expect(spillIfLarge(under, opts())).toBe(under);

    const over = "z".repeat(DEFAULT_MAX_RESULT_CHARS + 1);
    const out = spillIfLarge(over, opts());
    expect(out.length).toBeLessThan(over.length);
    expect(fs.readdirSync(path.join(workspaceRoot, SPILL_DIR))).toHaveLength(1);
  });

  it("degrades to in-memory truncation (no throw) when the disk write fails", () => {
    // Make the spill directory un-creatable by planting a FILE where the
    // `.ccr` directory would go — mkdirSync then throws ENOTDIR/EEXIST.
    fs.writeFileSync(path.join(workspaceRoot, ".ccr"), "blocker", "utf-8");

    const content = "Q".repeat(5000);
    const out = spillIfLarge(content, opts({ maxChars: 100 }));
    // Bounded preview, head+tail, and the fallback notice — but no throw.
    expect(out.length).toBeLessThan(content.length);
    expect(out.startsWith("Q")).toBe(true);
    expect(out.endsWith("Q")).toBe(true);
    expect(out).toContain("head + tail only");
  });
});
