// ============================================================
// Tests: @file reference expansion
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandFileRefs } from "../tools/utils/file-refs.js";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fileref-"));
  fs.writeFileSync(path.join(workspace, "hello.txt"), "hello world");
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;");
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("expandFileRefs", () => {
  it("attaches a referenced file's contents", () => {
    const r = expandFileRefs("look at @hello.txt please", workspace);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]).toContain("hello world");
    expect(r.attachments[0]).toContain('path="hello.txt"');
    expect(r.attachments[0]).toContain("Do not call the read tool for this file again");
  });

  it("resolves nested paths", () => {
    const r = expandFileRefs("@src/a.ts", workspace);
    expect(r.attachments[0]).toContain("export const a = 1;");
  });

  it("handles multiple distinct refs and dedupes repeats", () => {
    const r = expandFileRefs("@hello.txt and @hello.txt and @src/a.ts", workspace);
    expect(r.attachments).toHaveLength(2);
  });

  it("skips files outside the workspace", () => {
    const r = expandFileRefs("@../../etc/passwd", workspace);
    expect(r.attachments).toHaveLength(0);
    expect(r.notes.some((n) => n.includes("outside the workspace"))).toBe(true);
  });

  it("skips missing files with a note", () => {
    const r = expandFileRefs("@nope.txt", workspace);
    expect(r.attachments).toHaveLength(0);
    expect(r.notes.some((n) => n.includes("not found"))).toBe(true);
  });

  it("leaves text without refs untouched", () => {
    const r = expandFileRefs("just a normal message", workspace);
    expect(r.attachments).toHaveLength(0);
    expect(r.notes).toHaveLength(0);
  });

  it("does not treat an email address as a ref", () => {
    const r = expandFileRefs("ping me at user@example.com", workspace);
    expect(r.attachments).toHaveLength(0);
  });
});
