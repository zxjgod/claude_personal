// Tests: official Claude Code tool-parameter compatibility.
//
// Official spells tool arguments in snake_case (`file_path`); this project's
// internals are camelCase (`filePath`). Both must address the same argument,
// the official spelling must be what the model is TOLD to emit, and an alias
// must never become a way around a path check.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeSingleTool } from "../tool-executor.js";
import { NotebookEditTool } from "../tools/breadth/index.js";
import { EditTool } from "../tools/core/edit.js";
import { GrepTool } from "../tools/core/grep.js";
import { ReadTool } from "../tools/core/read.js";
import { WriteTool } from "../tools/core/write.js";
import { JobOutputTool } from "../tools/extended/jobs.js";
import { WebFetchTool } from "../tools/extended/web-fetch.js";

import {
  advertisedParamName,
  hookToolInput,
  normalizeOfficialParams,
  OFFICIAL_PARAM_ALIASES,
} from "../tools/utils/official-params.js";
import type { Tool, ToolResult } from "../types.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ccr-official-"));

/** Assert the tool validates, then run it — without a non-null assertion. */
const validated = (tool: Tool, input: Record<string, unknown>): Record<string, unknown> => {
  if (!tool.validateInput) throw new Error(`${tool.name} declares no validateInput`);
  return tool.validateInput(input) as Record<string, unknown>;
};

describe("official tool-parameter compatibility", () => {
  describe("advertised schema", () => {
    it("advertises the official spelling as canonical; required-ness is enforced by validateInput", () => {
      const props = ReadTool.inputSchema.properties as Record<string, { description?: string }>;
      expect(props.file_path).toBeDefined();
      // Review fix: JSON Schema `required` is a literal key list — marking the
      // official spelling required makes provider-side strict validation
      // REJECT calls that use the advertised filePath alias. Neither spelling
      // is in `required`; our own validateInput enforces presence instead.
      expect(ReadTool.inputSchema.required ?? []).not.toContain("file_path");
      expect(ReadTool.inputSchema.required ?? []).not.toContain("filePath");
      expect(() => validated(ReadTool, {})).toThrow();
    });

    it("keeps the legacy camelCase as an accepted, clearly-labelled alias", () => {
      const props = ReadTool.inputSchema.properties as Record<string, { description?: string }>;
      expect(props.filePath).toBeDefined();
      expect(props.filePath.description).toContain("legacy alias");
      expect(props.filePath.description).toContain("file_path");
    });

    it("applies the rename to every aliased tool", () => {
      for (const [name, aliases] of Object.entries(OFFICIAL_PARAM_ALIASES)) {
        expect(Object.keys(OFFICIAL_PARAM_ALIASES)).toContain(name);
        for (const { official, internal } of aliases) {
          expect(official).not.toBe(internal);
        }
      }
      const notebook = NotebookEditTool.inputSchema.properties as Record<string, unknown>;
      expect(notebook.notebook_path).toBeDefined();
      expect(notebook.new_source).toBeDefined();
      expect(notebook.edit_mode).toBeDefined();
      const jobs = JobOutputTool.inputSchema.properties as Record<string, unknown>;
      expect(jobs.task_id).toBeDefined();
      expect(jobs.block).toBeDefined();
      // Aliased params are dropped from `required` (see above) — presence is
      // enforced by validateInput instead.
      expect(JobOutputTool.inputSchema.required ?? []).not.toContain("task_id");
      const fetch = WebFetchTool.inputSchema.properties as Record<string, unknown>;
      expect(fetch.prompt).toBeDefined();
      // prompt is an aliased param (internal fetchInfo) → not in `required`.
      expect(WebFetchTool.inputSchema.required ?? []).not.toContain("prompt");
      // Official Grep `context` is our -C; official `offset` is real, not an alias.
      const grep = GrepTool.inputSchema.properties as Record<string, unknown>;
      expect(grep.context).toBeDefined();
      expect(grep.offset).toBeDefined();
    });
  });

  describe("input normalization", () => {
    it("accepts the official spelling", () => {
      const out = validated(ReadTool, { file_path: "/tmp/a.txt" });
      expect(out.filePath).toBe("/tmp/a.txt");
      expect(out.file_path).toBeUndefined();
    });

    it("still accepts the legacy camelCase", () => {
      const out = validated(ReadTool, { filePath: "/tmp/a.txt" });
      expect(out.filePath).toBe("/tmp/a.txt");
    });

    it("keeps the internal value when both spellings are present", () => {
      const out = validated(ReadTool, {
        filePath: "/internal",
        file_path: "/official",
      });
      expect(out.filePath).toBe("/internal");
      expect(out.file_path).toBeUndefined();
    });

    it("does not mutate the caller's object", () => {
      const input = { file_path: "/tmp/a.txt" };
      validated(ReadTool, input);
      expect(input).toEqual({ file_path: "/tmp/a.txt" });
    });

    it("returns the same reference when no alias applies", () => {
      const input = { pattern: "x" };
      expect(normalizeOfficialParams("glob", input)).toBe(input);
    });

    it("renames every NotebookEdit official argument", () => {
      const out = validated(NotebookEditTool, {
        notebook_path: "/tmp/n.ipynb",
        new_source: "print(1)",
        edit_mode: "replace",
        cell_type: "code",
        cellIndex: 0,
      });
      expect(out.filePath).toBe("/tmp/n.ipynb");
      expect(out.source).toBe("print(1)");
      expect(out.mode).toBe("replace");
      expect(out.cellType).toBe("code");
    });

    it("renames TaskOutput's task_id/block/timeout", () => {
      const out = validated(JobOutputTool, {
        task_id: "j1",
        block: true,
        timeout: 5000,
      });
      expect(out.job_id).toBe("j1");
      expect(out.wait).toBe(true);
      expect(out.timeout_ms).toBe(5000);
    });

    // Once `cellId` is a real content-addressed lookup (not the 0-based
    // `cellIndex`), the rename is safe and cell_id must be accepted. The reason
    // it was once refused is preserved in notebook-edit-cell-id.test.ts, which
    // pins the invariant that a cell_id is never read as an index.
    it("aliases NotebookEdit cell_id onto the content-addressed cellId", () => {
      expect(
        validated(NotebookEditTool, { notebook_path: "/tmp/n.ipynb", cell_id: "abc" }).cellId,
      ).toBe("abc");
    });
  });

  describe("error messages", () => {
    it("names the advertised parameter, not the internal one", () => {
      expect(() => validated(ReadTool, {})).toThrow(/file_path/);
      expect(() => validated(ReadTool, {})).not.toThrow(/filePath/);
    });

    it("advertisedParamName falls back to the internal name", () => {
      expect(advertisedParamName("read", "filePath")).toBe("file_path");
      expect(advertisedParamName("read", "limit")).toBe("limit");
      expect(advertisedParamName("glob", "pattern")).toBe("pattern");
    });
  });

  describe("hook envelope", () => {
    it("exposes both spellings so official ${tool_input.file_path} resolves", () => {
      const out = hookToolInput("read", { filePath: "/tmp/a.txt" });
      expect(out.file_path).toBe("/tmp/a.txt");
      expect(out.filePath).toBe("/tmp/a.txt");
    });

    it("returns the same reference when nothing is aliased", () => {
      const input = { pattern: "x" };
      expect(hookToolInput("glob", input)).toBe(input);
    });

    it("does not overwrite an explicit official value", () => {
      const out = hookToolInput("read", { file_path: "/official", filePath: "/internal" });
      expect(out.file_path).toBe("/official");
    });
  });

  describe("end-to-end through the executor", () => {
    it("reads a real file when the model uses file_path", async () => {
      const dir = tmp();
      const file = path.join(dir, "a.txt");
      fs.writeFileSync(file, "hello\n");
      const ctx = {
        cwd: dir,
        workspaceRoot: dir,
        allowedDirectories: [dir],
        permissionMode: "default",
        sessionId: "official-probe",
      } as never;
      const result = await executeSingleTool(
        {
          id: "1",
          function: { name: "read", arguments: JSON.stringify({ file_path: file }) },
        } as never,
        [ReadTool],
        ctx,
        async () => false,
      );
      expect(result.isError).toBeFalsy();
      expect(result.formatted).toContain("hello");
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("edits a real file when the model uses file_path", async () => {
      const dir = tmp();
      const file = path.join(dir, "a.txt");
      fs.writeFileSync(file, "hello\n");
      const sessionId = "official-probe-edit";
      const ctx = {
        cwd: dir,
        workspaceRoot: dir,
        allowedDirectories: [dir],
        permissionMode: "acceptEdits",
        sessionId,
      } as never;
      // Read first: Edit enforces the read-before-edit gate, so the official
      // spelling has to work on both halves of that round trip.
      await executeSingleTool(
        {
          id: "1",
          function: { name: "read", arguments: JSON.stringify({ file_path: file }) },
        } as never,
        [ReadTool],
        ctx,
        async () => false,
      );
      const result = await executeSingleTool(
        {
          id: "2",
          function: {
            name: "edit",
            arguments: JSON.stringify({ file_path: file, old_string: "hello", new_string: "bye" }),
          },
        } as never,
        [EditTool],
        ctx,
        async () => true,
      );
      expect(result.isError).toBeFalsy();
      expect(fs.readFileSync(file, "utf-8")).toContain("bye");
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("still blocks an official-named path outside the workspace", async () => {
      // The alias must not become a boundary bypass: normalization happens
      // before the permission check, so `file_path` gets the same treatment.
      const dir = tmp();
      const ctx = {
        cwd: dir,
        workspaceRoot: dir,
        allowedDirectories: [dir],
        permissionMode: "default",
        sessionId: "official-probe-boundary",
      } as never;
      const result = await executeSingleTool(
        {
          id: "1",
          function: {
            name: "read",
            arguments: JSON.stringify({
              file_path: path.join(dir, "..", "..", "windows", "win.ini"),
            }),
          },
        } as never,
        [ReadTool],
        ctx,
        async () => false,
      );
      expect(result.isError).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("writes a real file when the model uses file_path", async () => {
      const dir = tmp();
      const file = path.join(dir, "b.txt");
      const ctx = {
        cwd: dir,
        workspaceRoot: dir,
        allowedDirectories: [dir],
        permissionMode: "acceptEdits",
        sessionId: "official-probe-write",
      } as never;
      const result = await executeSingleTool(
        {
          id: "1",
          function: {
            name: "write",
            arguments: JSON.stringify({ file_path: file, content: "written" }),
          },
        } as never,
        [WriteTool],
        ctx,
        async () => true,
      );
      expect(result.isError).toBeFalsy();
      expect(fs.readFileSync(file, "utf-8")).toBe("written");
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  // Official Grep `offset` pages past a previous call's head_limit window, and
  // official `context` is the same knob as our -C. Both were missing entirely:
  // official's GrepInput declares `context` and `offset`, and advertising them
  // would have been a lie until now.
  describe("Grep context/offset", () => {
    const grepCtx = (dir: string) =>
      ({
        cwd: dir,
        workspaceRoot: dir,
        allowedDirectories: [dir],
        permissionMode: "default",
        sessionId: "official-grep",
      }) as never;

    const runGrep = (args: Record<string, unknown>, dir: string) =>
      executeSingleTool(
        { id: "g", function: { name: "Grep", arguments: JSON.stringify(args) } } as never,
        [GrepTool],
        grepCtx(dir),
        async () => true,
      );

    // `formatted` appends a `[12ms]` duration footer; compare the raw content so
    // line counts and equality are not polluted by it.
    const resultOf = (r: { result?: ToolResult }) => {
      if (!r.result) throw new Error("tool returned no result");
      return r.result;
    };
    const linesOf = (r: { result?: ToolResult }) =>
      String(resultOf(r).content).split("\n").filter(Boolean);

    it("paginates: offset walks the whole result set exactly once", async () => {
      const dir = tmp();
      // 7 matching lines, one per line, in a single file.
      fs.writeFileSync(
        path.join(dir, "hits.txt"),
        ["m1", "x", "m2", "x", "m3", "x", "m4", "x", "m5", "x", "m6", "x", "m7"].join("\n"),
      );

      const seen: string[] = [];
      for (const offset of [0, 3, 6]) {
        const r = await runGrep({ pattern: "^m", path: dir, head_limit: 3, offset }, dir);
        expect(r.isError).toBeFalsy();
        seen.push(...linesOf(r));
      }
      // Every hit once, in order — no duplicates, no gaps, none dropped.
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect(seen[0]).toContain("m1");
      expect(seen[6]).toContain("m7");

      // A page past the end is empty, not an error.
      const past = await runGrep({ pattern: "^m", path: dir, head_limit: 3, offset: 99 }, dir);
      expect(past.isError).toBeFalsy();
      expect(resultOf(past).content).toContain("No matches found.");

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reports truncated only while results remain beyond the window", async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, "hits.txt"), ["m1", "m2", "m3", "m4", "m5"].join("\n"));

      const partial = await runGrep({ pattern: "^m", path: dir, head_limit: 2, offset: 0 }, dir);
      expect(resultOf(partial).truncated).toBe(true);

      // The final page is complete — nothing is being held back.
      const last = await runGrep({ pattern: "^m", path: dir, head_limit: 10, offset: 2 }, dir);
      expect(resultOf(last).truncated).toBe(false);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("accepts official `context` and treats it as lines before AND after", async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, "ctx.txt"), ["before", "HIT", "after", "tail"].join("\n"));

      const official = await runGrep({ pattern: "HIT", path: dir, context: 1 }, dir);
      const legacy = await runGrep({ pattern: "HIT", path: dir, "-C": 1 }, dir);

      expect(official.isError).toBeFalsy();
      expect(resultOf(official).content).toBe(resultOf(legacy).content);
      const text = resultOf(official).content;
      expect(text).toContain("before");
      expect(text).toContain("after");
      expect(text).not.toContain("tail");

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("offset applies to files_with_matches too", async () => {
      const dir = tmp();
      for (const n of ["a", "b", "c"]) fs.writeFileSync(path.join(dir, `${n}.txt`), "m\n");

      const all = await runGrep(
        { pattern: "m", path: dir, output_mode: "files_with_matches" },
        dir,
      );
      const full = linesOf(all);
      expect(full).toHaveLength(3);

      // `offset` drops from the front of the result sequence. Compare as SETS:
      // two separate rg invocations do not return files in a stable order
      // (readdir order varies), so comparing positionally ACROSS calls is flaky
      // by construction. The real contract is "one fewer, and only real files".
      const paged = await runGrep(
        { pattern: "m", path: dir, output_mode: "files_with_matches", offset: 1 },
        dir,
      );
      const lines = linesOf(paged);
      expect(lines).toHaveLength(2);
      expect(new Set(lines)).toEqual(new Set(full.filter((l) => lines.includes(l))));

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
