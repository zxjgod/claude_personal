// Tests: NotebookEdit cell addressing by `cell_id` (official) vs `cellIndex`.
//
// Official addresses a cell by its content id (nbformat 4.5+); this project
// historically used a 0-based index. Both are supported, and the invariant that
// matters is that they stay DISTINCT: treating one as the other would edit
// whichever cell happened to sit at that number, which is silent data loss.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { markRead } from "../read-tracker.js";
import { executeSingleTool } from "../tool-executor.js";
import { NotebookEditTool } from "../tools/breadth/index.js";

const SESSION = "nb-cell-id";

function makeNotebook(dir: string, name = "a.ipynb"): string {
  const nb = path.join(dir, name);
  fs.writeFileSync(
    nb,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          id: "aaa11111",
          source: ["one"],
          metadata: {},
          outputs: [],
          execution_count: null,
        },
        {
          cell_type: "code",
          id: "bbb22222",
          source: ["two"],
          metadata: {},
          outputs: [],
          execution_count: null,
        },
        { cell_type: "markdown", id: "ccc33333", source: ["three"], metadata: {} },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
  );
  return nb;
}

describe("NotebookEdit cell_id addressing", () => {
  let dir: string;
  let nb: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-nbcell-"));
    nb = makeNotebook(dir);
  });

  const call = async (args: Record<string, unknown>) => {
    // Re-mark on every call: a successful op rewrites the file, which changes
    // its mtime and would otherwise trip read-before-edit.
    markRead(SESSION, nb, fs.statSync(nb).mtimeMs);
    return await executeSingleTool(
      {
        id: "1",
        function: { name: "notebook_edit", arguments: JSON.stringify(args) },
      } as never,
      [NotebookEditTool],
      {
        cwd: dir,
        workspaceRoot: dir,
        allowedDirectories: [dir],
        permissionMode: "acceptEdits",
        sessionId: SESSION,
      } as never,
      async () => true,
    );
  };

  const cells = (): { id?: string; source: string[]; cell_type: string }[] =>
    JSON.parse(fs.readFileSync(nb, "utf-8")).cells;
  const texts = (): string[] =>
    cells().map((c) => (Array.isArray(c.source) ? c.source.join("") : c.source));

  it("advertises cell_id and does not require cellIndex", () => {
    const props = NotebookEditTool.inputSchema.properties as Record<string, unknown>;
    expect(props.cell_id).toBeDefined();
    expect(props.cellIndex).toBeDefined();
    // Official makes cell_id optional; a notebook can be targeted by either.
    expect(NotebookEditTool.inputSchema.required ?? []).not.toContain("cellIndex");
  });

  it("replaces the cell carrying the given id", async () => {
    const r = await call({
      notebook_path: nb,
      cell_id: "bbb22222",
      new_source: "TWO-EDITED",
      edit_mode: "replace",
    });
    expect(r.isError).toBeFalsy();
    expect(texts()).toEqual(["one", "TWO-EDITED", "three"]);
  });

  it("inserts AFTER the addressed cell, per official semantics", async () => {
    const r = await call({
      notebook_path: nb,
      cell_id: "aaa11111",
      new_source: "INS",
      edit_mode: "insert",
      cell_type: "markdown",
    });
    expect(r.isError).toBeFalsy();
    expect(texts()).toEqual(["one", "INS", "two", "three"]);
    expect(cells()[1].cell_type).toBe("markdown");
  });

  it("prepends when neither cell_id nor cellIndex is given (official behavior)", async () => {
    const r = await call({ notebook_path: nb, new_source: "TOP", edit_mode: "insert" });
    expect(r.isError).toBeFalsy();
    expect(texts()).toEqual(["TOP", "one", "two", "three"]);
  });

  it("deletes the cell carrying the given id", async () => {
    const r = await call({ notebook_path: nb, cell_id: "ccc33333", edit_mode: "delete" });
    expect(r.isError).toBeFalsy();
    expect(texts()).toEqual(["one", "two"]);
  });

  it("reports an unknown cell_id instead of guessing a cell", async () => {
    const r = await call({
      notebook_path: nb,
      cell_id: "zzz99999",
      new_source: "x",
      edit_mode: "replace",
    });
    expect(r.isError).toBe(true);
    expect(String(r.formatted)).toContain("zzz99999");
    // Nothing may have changed.
    expect(texts()).toEqual(["one", "two", "three"]);
  });

  it("does not treat a numeric-looking cell_id as an index", async () => {
    // Regression guard for the whole reason cell_id is not an alias: "0" must
    // not silently edit cell 0.
    const r = await call({
      notebook_path: nb,
      cell_id: "0",
      new_source: "x",
      edit_mode: "replace",
    });
    expect(r.isError).toBe(true);
    expect(texts()).toEqual(["one", "two", "three"]);
  });

  it("mints an id for inserted cells so they are addressable next call", async () => {
    await call({ notebook_path: nb, cell_id: "aaa11111", new_source: "INS", edit_mode: "insert" });
    const inserted = cells()[1];
    expect(inserted.id).toBeTruthy();
    // The freshly minted id really does round-trip.
    const r = await call({
      notebook_path: nb,
      cell_id: inserted.id,
      new_source: "INS-EDITED",
      edit_mode: "replace",
    });
    expect(r.isError).toBeFalsy();
    expect(texts()).toEqual(["one", "INS-EDITED", "two", "three"]);
  });

  it("prefers an explicit cellIndex when both are given", async () => {
    const r = await call({
      notebook_path: nb,
      cell_id: "aaa11111",
      cellIndex: 2,
      new_source: "THREE-EDITED",
      mode: "replace",
    });
    expect(r.isError).toBeFalsy();
    expect(texts()).toEqual(["one", "two", "THREE-EDITED"]);
  });

  it("still supports the legacy cellIndex spelling", async () => {
    const r = await call({ filePath: nb, cellIndex: 0, source: "VIA-INDEX", mode: "replace" });
    expect(r.isError).toBeFalsy();
    expect(texts()).toEqual(["VIA-INDEX", "two", "three"]);
  });

  it("requires one of cell_id / cellIndex for non-insert operations", async () => {
    const r = await call({ notebook_path: nb, new_source: "x", edit_mode: "replace" });
    expect(r.isError).toBe(true);
    expect(String(r.formatted)).toContain("cellIndex");
  });
});
