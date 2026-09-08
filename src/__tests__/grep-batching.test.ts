import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrepTool } from "../tools/core/grep.js";
import type { ToolContext } from "../types.js";

let fixture: string;
let ctx: ToolContext;
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-grep-batch-"));
  ctx = { workspaceRoot: fixture, sessionId: "grep-batching", permissionMode: "default" };
});
afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

describe("Grep batching bounds", () => {
  it("marks results truncated when the 10MB accumulation cap stops later batches", async () => {
    // 80 files × one 300KB matching line = 3 batches. Batch 1 (32 files) is
    // ≈9.6MB (under the per-process maxBuffer); batch 2 pushes the total past
    // 10MB, so batch 3 (files 65–80) never runs. 64 lines < headLimit, so
    // only the size cap can set `truncated` — before the fix it stayed false.
    for (let i = 0; i < 80; i++) {
      fs.writeFileSync(
        path.join(fixture, `f${String(i).padStart(2, "0")}.txt`),
        "a".repeat(300_000),
      );
    }
    const result = await GrepTool.call({ pattern: "aaa" }, ctx);
    expect(result.error).toBeUndefined();
    expect(result.metadata?.linesRead).toBe(64);
    expect(result.truncated).toBe(true);
  });

  it("reports a missing search path cleanly instead of rerouting into the fallback", async () => {
    const result = await GrepTool.call({ pattern: "x", path: "no/such/dir" }, ctx);
    expect(result.error).toContain("Path not found");
  });
});
