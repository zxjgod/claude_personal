import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@vscode/ripgrep", () => {
  throw new Error("simulate missing binary");
});

import { GrepTool } from "../tools/core/grep.js";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-grep-fallback-"));
const workspace = path.join(fixture, "workspace");
fs.mkdirSync(workspace);
const context = {
  workspaceRoot: workspace,
  sessionId: "fallback",
  permissionMode: "default" as const,
};
afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

it("fallback rejects secrets and glob traversal while preserving valid searches", async () => {
  fs.writeFileSync(path.join(workspace, "public.txt"), "PROBE=PUBLIC");
  fs.writeFileSync(path.join(workspace, "credentials.json"), "PROBE=SECRET");
  fs.writeFileSync(path.join(fixture, "outside.txt"), "PROBE=OUTSIDE");
  // Surface the tool's error field on failure: a denied/failed search returns
  // content:"" too, and a bare toContain diff hides the real cause on CI.
  const first = await GrepTool.call({ pattern: "PROBE", path: "public.txt" }, context);
  expect(first.error ?? "no error").toBe("no error");
  expect(first.content).toContain("PUBLIC");
  const scan = await GrepTool.call({ pattern: "PROBE", glob: "**/*" }, context);
  expect(scan.content).toContain("PUBLIC");
  expect(scan.content).not.toContain("SECRET");
  expect(
    (await GrepTool.call({ pattern: "PROBE", glob: "../*.txt" }, context)).content,
  ).not.toContain("OUTSIDE");
});

// The Node.js fallback has its own result-collection loop, so official `offset`
// paging needs covering here separately — the ripgrep path is exercised in
// official-params.test.ts.
it("fallback honors official offset paging and context", async () => {
  // afterEach removed the shared fixture after the first test.
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "hits.txt"),
    ["m1", "x", "m2", "x", "m3", "x", "m4", "x", "m5"].join("\n"),
  );

  const seen: string[] = [];
  for (const offset of [0, 2, 4]) {
    const r = await GrepTool.call(
      { pattern: "^m", path: "hits.txt", head_limit: 2, offset },
      context,
    );
    seen.push(...r.content.split("\n").filter(Boolean));
  }
  expect(seen).toHaveLength(5);
  expect(new Set(seen).size).toBe(5);
  expect(seen[0]).toContain("m1");
  expect(seen[4]).toContain("m5");

  // The loop must collect offset + head_limit, or the last page would be short.
  const last = await GrepTool.call(
    { pattern: "^m", path: "hits.txt", head_limit: 2, offset: 4 },
    context,
  );
  expect(last.content.split("\n").filter(Boolean)).toHaveLength(1);
  expect(last.truncated).toBe(false);

  fs.writeFileSync(path.join(workspace, "ctx.txt"), ["before", "HIT", "after", "tail"].join("\n"));
  // Go through validateInput, as the executor does: official→internal parameter
  // normalization lives there, so calling `.call()` directly would skip the
  // `context` → `-C` rename and silently under-test the fallback.
  const grep = (args: Record<string, unknown>) => {
    if (!GrepTool.validateInput) throw new Error("grep declares no validateInput");
    return GrepTool.call(GrepTool.validateInput(args) as never, context);
  };
  const withContext = await grep({ pattern: "HIT", path: "ctx.txt", context: 1 });
  const withDashC = await grep({ pattern: "HIT", path: "ctx.txt", "-C": 1 });
  // Official `context` and the legacy `-C` must be indistinguishable.
  expect(withContext.content).toBe(withDashC.content);
  expect(withContext.content).toContain("before");
  expect(withContext.content).toContain("after");
  expect(withContext.content).not.toContain("tail");
});
