// ============================================================
// Tests: M5 tool enhancements
// (Edit replace_all, MultiEdit atomicity, multimodal Read,
//  read-before-edit gate)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetReadTracker } from "../read-tracker.js";
import { EditTool, MultiEditTool, ReadTool } from "../tools.js";
import type { ToolContext } from "../types.js";

let tmpDir: string;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-test-"));
  ctx = {
    workspaceRoot: tmpDir,
    sessionId: "m5",
    permissionMode: "default",
  };
  resetReadTracker();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Edit replace_all", () => {
  it("replaces every occurrence when replace_all is true", async () => {
    const fp = path.join(tmpDir, "r.txt");
    fs.writeFileSync(fp, "a\na\na");
    await ReadTool.call({ filePath: "r.txt" }, ctx);

    const result = await EditTool.call(
      { filePath: "r.txt", old_string: "a", new_string: "b", replace_all: true },
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("3 occurrences");
    expect(fs.readFileSync(fp, "utf-8")).toBe("b\nb\nb");
  });

  it("still rejects non-unique matches without replace_all", async () => {
    const fp = path.join(tmpDir, "r2.txt");
    fs.writeFileSync(fp, "a\na");
    await ReadTool.call({ filePath: "r2.txt" }, ctx);

    const result = await EditTool.call(
      { filePath: "r2.txt", old_string: "a", new_string: "b" },
      ctx,
    );
    expect(result.error).toContain("2 matches");
  });

  it("treats replacement literally (no $ interpretation) across all matches", async () => {
    const fp = path.join(tmpDir, "r3.txt");
    fs.writeFileSync(fp, "X X");
    await ReadTool.call({ filePath: "r3.txt" }, ctx);

    await EditTool.call(
      { filePath: "r3.txt", old_string: "X", new_string: "$&", replace_all: true },
      ctx,
    );
    expect(fs.readFileSync(fp, "utf-8")).toBe("$& $&");
  });
});

describe("MultiEdit", () => {
  it("applies multiple edits atomically in order", async () => {
    const fp = path.join(tmpDir, "multi.txt");
    fs.writeFileSync(fp, "one two three");
    await ReadTool.call({ filePath: "multi.txt" }, ctx);

    const result = await MultiEditTool.call(
      {
        filePath: "multi.txt",
        edits: [
          { old_string: "one", new_string: "1" },
          { old_string: "two", new_string: "2" },
          { old_string: "three", new_string: "3" },
        ],
      },
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(fp, "utf-8")).toBe("1 2 3");
  });

  it("writes nothing if any edit fails (atomic rollback)", async () => {
    const fp = path.join(tmpDir, "atomic.txt");
    fs.writeFileSync(fp, "alpha beta");
    await ReadTool.call({ filePath: "atomic.txt" }, ctx);

    const result = await MultiEditTool.call(
      {
        filePath: "atomic.txt",
        edits: [
          { old_string: "alpha", new_string: "A" },
          { old_string: "NOPE", new_string: "X" }, // fails
        ],
      },
      ctx,
    );

    expect(result.error).toContain("Edit #2");
    // File must be untouched.
    expect(fs.readFileSync(fp, "utf-8")).toBe("alpha beta");
  });

  it("supports edits that build on previous edits' output", async () => {
    const fp = path.join(tmpDir, "chain.txt");
    fs.writeFileSync(fp, "foo");
    await ReadTool.call({ filePath: "chain.txt" }, ctx);

    const result = await MultiEditTool.call(
      {
        filePath: "chain.txt",
        edits: [
          { old_string: "foo", new_string: "bar" },
          { old_string: "bar", new_string: "baz" },
        ],
      },
      ctx,
    );
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(fp, "utf-8")).toBe("baz");
  });
});

describe("read-before-edit gate", () => {
  it("blocks editing a file that was not read this session", async () => {
    const fp = path.join(tmpDir, "unread.txt");
    fs.writeFileSync(fp, "hello");

    const result = await EditTool.call(
      { filePath: "unread.txt", old_string: "hello", new_string: "hi" },
      ctx,
    );
    expect(result.error).toContain("has not been read");
    expect(fs.readFileSync(fp, "utf-8")).toBe("hello");
  });

  it("blocks editing when the file changed since it was read", async () => {
    const fp = path.join(tmpDir, "changed.txt");
    fs.writeFileSync(fp, "v1");
    await ReadTool.call({ filePath: "changed.txt" }, ctx);

    // Simulate an external change with a newer mtime.
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(fp, "v2");
    fs.utimesSync(fp, future, future);

    const result = await EditTool.call(
      { filePath: "changed.txt", old_string: "v2", new_string: "v3" },
      ctx,
    );
    expect(result.error).toContain("changed on disk");
  });

  it("allows chained edits without re-reading (tracker refreshes)", async () => {
    const fp = path.join(tmpDir, "chain2.txt");
    fs.writeFileSync(fp, "a b");
    await ReadTool.call({ filePath: "chain2.txt" }, ctx);

    const r1 = await EditTool.call(
      { filePath: "chain2.txt", old_string: "a", new_string: "x" },
      ctx,
    );
    expect(r1.error).toBeUndefined();
    const r2 = await EditTool.call(
      { filePath: "chain2.txt", old_string: "b", new_string: "y" },
      ctx,
    );
    expect(r2.error).toBeUndefined();
    expect(fs.readFileSync(fp, "utf-8")).toBe("x y");
  });
});

describe("multimodal Read", () => {
  it("returns an image content block for a PNG", async () => {
    const fp = path.join(tmpDir, "pic.png");
    // Minimal PNG header bytes + filler.
    fs.writeFileSync(fp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));

    const result = await ReadTool.call({ filePath: "pic.png" }, ctx);
    expect(result.error).toBeUndefined();
    expect(result.images).toHaveLength(1);
    expect(result.images![0].source.media_type).toBe("image/png");
    expect(result.images![0].source.type).toBe("base64");
  });

  it("maps PDF to application/pdf", async () => {
    const fp = path.join(tmpDir, "doc.pdf");
    fs.writeFileSync(fp, Buffer.from("%PDF-1.4 fake"));

    const result = await ReadTool.call({ filePath: "doc.pdf" }, ctx);
    expect(result.images![0].source.media_type).toBe("application/pdf");
  });

  it("reads normal text files as text (no images)", async () => {
    const fp = path.join(tmpDir, "code.ts");
    fs.writeFileSync(fp, "const x = 1;");
    const result = await ReadTool.call({ filePath: "code.ts" }, ctx);
    expect(result.images).toBeUndefined();
    expect(result.content).toContain("const x = 1;");
  });
});
