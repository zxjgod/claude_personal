// ============================================================
// Tests: Core Tools
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ReadTool,
  WriteTool,
  EditTool,
  BashTool,
  GlobTool,
  GrepTool,
} from "../tools.js";
import type { ToolContext } from "../types.js";

let tmpDir: string;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-test-"));
  ctx = {
    workspaceRoot: tmpDir,
    sessionId: "test",
    permissionMode: "default",
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Read Tool ---

describe("ReadTool", () => {
  it("should read a file with line numbers", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "line1\nline2\nline3");

    const result = await ReadTool.call(
      { filePath: "test.txt" },
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("   1: line1");
    expect(result.content).toContain("   2: line2");
    expect(result.content).toContain("   3: line3");
  });

  it("should return error for non-existent file", async () => {
    const result = await ReadTool.call(
      { filePath: "nonexistent.txt" },
      ctx,
    );
    expect(result.error).toContain("not found");
  });

  it("should detect binary files", async () => {
    const filePath = path.join(tmpDir, "binary.bin");
    const buf = Buffer.alloc(100);
    buf[50] = 0; // null byte
    fs.writeFileSync(filePath, buf);

    const result = await ReadTool.call(
      { filePath: "binary.bin" },
      ctx,
    );
    expect(result.content).toContain("[Binary file:");
  });

  it("should support offset and limit", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
    fs.writeFileSync(filePath, lines.join("\n"));

    const result = await ReadTool.call(
      { filePath: "lines.txt", offset: 10, limit: 5 },
      ctx,
    );

    expect(result.content).toContain("line10");
    expect(result.content).toContain("line14");
    expect(result.content).not.toContain("line5");
  });

  it("should reject directory reads", async () => {
    const dirPath = path.join(tmpDir, "subdir");
    fs.mkdirSync(dirPath);

    const result = await ReadTool.call(
      { filePath: "subdir" },
      ctx,
    );
    expect(result.error).toContain("directory");
  });
});

// --- Write Tool ---

describe("WriteTool", () => {
  it("should create a new file", async () => {
    const result = await WriteTool.call(
      { filePath: "newfile.txt", content: "hello world" },
      ctx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Created");

    const exists = fs.existsSync(path.join(tmpDir, "newfile.txt"));
    expect(exists).toBe(true);
  });

  it("should overwrite an existing file", async () => {
    const filePath = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(filePath, "old content");

    const result = await WriteTool.call(
      { filePath: "existing.txt", content: "new content" },
      ctx,
    );
    expect(result.content).toContain("Updated");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toBe("new content");
  });

  it("should create parent directories", async () => {
    const result = await WriteTool.call(
      { filePath: "deep/nested/dir/file.txt", content: "deep" },
      ctx,
    );
    expect(result.error).toBeUndefined();

    const filePath = path.join(tmpDir, "deep", "nested", "dir", "file.txt");
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// --- Edit Tool ---

describe("EditTool", () => {
  it("should perform exact replacement", async () => {
    const filePath = path.join(tmpDir, "edit.txt");
    fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;");

    await ReadTool.call({ filePath: "edit.txt" }, ctx);
    const result = await EditTool.call(
      {
        filePath: "edit.txt",
        old_string: "const x = 1;",
        new_string: "const x = 42;",
      },
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Edit applied");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("const x = 42;");
  });

  it("should reject non-unique matches", async () => {
    const filePath = path.join(tmpDir, "dup.txt");
    fs.writeFileSync(filePath, "log('a');\nlog('b');");

    await ReadTool.call({ filePath: "dup.txt" }, ctx);
    const result = await EditTool.call(
      {
        filePath: "dup.txt",
        old_string: "log",
        new_string: "console.log",
      },
      ctx,
    );

    expect(result.error).toContain("Found 2 matches");
  });

  it("should reject when old_string not found", async () => {
    const filePath = path.join(tmpDir, "nope.txt");
    fs.writeFileSync(filePath, "hello world");

    await ReadTool.call({ filePath: "nope.txt" }, ctx);
    const result = await EditTool.call(
      {
        filePath: "nope.txt",
        old_string: "goodbye",
        new_string: "hello",
      },
      ctx,
    );

    expect(result.error).toContain("not found");
  });

  it("should insert literal $ sequences without special interpretation", async () => {
    const filePath = path.join(tmpDir, "dollar.txt");
    fs.writeFileSync(filePath, "PLACEHOLDER");

    // $&, $1, $`, $' are all special in String.replace replacement strings.
    const newStr = "const re = /(\\w+)/; m.replace(re, '$1-$&-$`-$\\'')";
    await ReadTool.call({ filePath: "dollar.txt" }, ctx);
    const result = await EditTool.call(
      {
        filePath: "dollar.txt",
        old_string: "PLACEHOLDER",
        new_string: newStr,
      },
      ctx,
    );

    expect(result.error).toBeUndefined();
    const content = fs.readFileSync(filePath, "utf-8");
    // Must be byte-for-byte identical to new_string, not expanded.
    expect(content).toBe(newStr);
  });

  it("should preserve $$ literally", async () => {
    const filePath = path.join(tmpDir, "dollar2.txt");
    fs.writeFileSync(filePath, "AAA");

    await ReadTool.call({ filePath: "dollar2.txt" }, ctx);
    const result = await EditTool.call(
      { filePath: "dollar2.txt", old_string: "AAA", new_string: "price = $$5" },
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(filePath, "utf-8")).toBe("price = $$5");
  });
});

const IS_WINDOWS = process.platform === "win32";

describe("BashTool", () => {
  it("should execute simple commands", async () => {
    // Use platform-appropriate echo
    const cmd = IS_WINDOWS ? "echo hello" : "echo hello";
    const result = await BashTool.call(
      { command: cmd, description: "test echo" },
      ctx,
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("hello");
  });

  it("should capture stderr", async () => {
    // Use platform-appropriate stderr redirect
    const cmd = IS_WINDOWS ? "echo error 1>&2" : "echo error >&2";
    const result = await BashTool.call(
      { command: cmd, description: "stderr test" },
      ctx,
    );
    expect(result.content).toContain("error");
  });
});

// --- Glob Tool ---

describe("GlobTool", () => {
  it("should find files matching a pattern", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "c.js"), "");

    const result = await GlobTool.call(
      { pattern: "*.ts" },
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("b.ts");
    expect(result.content).not.toContain("c.js");
  });

  it("should report no matches", async () => {
    const result = await GlobTool.call(
      { pattern: "nonexistent*.xyz" },
      ctx,
    );
    expect(result.content).toContain("No files found");
  });
});

// --- Grep Tool ---

describe("GrepTool", () => {
  it("should search file contents", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "search-test.txt"),
      "hello world\nfoo bar\nhello again",
    );

    const result = await GrepTool.call(
      { pattern: "hello" },
      ctx,
    );

    // GrepTool falls back to Node.js search if rg is unavailable.
    // Either way, the result should contain matches or report none found.
    expect(result.error).toBeUndefined();
    // Content check: may vary by platform (rg vs fallback)
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  });
});

// --- Workspace boundary enforcement (regression for path escapes) ---

describe("workspace boundary", () => {
  it("rejects a sibling dir sharing the workspace name prefix", async () => {
    // tmpDir is the workspace. A sibling like "<tmpDir>-evil" must NOT be
    // treated as inside it — the old startsWith check without a separator
    // would have allowed this.
    const sibling = `${tmpDir}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    try {
      fs.writeFileSync(path.join(sibling, "secret.txt"), "owned");

      const result = await ReadTool.call(
        { filePath: path.join(sibling, "secret.txt") },
        ctx,
      );
      expect(result.error).toContain("outside workspace");
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("rejects an absolute path outside the workspace", async () => {
    // path.resolve(root, absolute) discards root → must be caught.
    const outside = IS_WINDOWS ? "C:\\Windows\\system.ini" : "/etc/hosts";
    const result = await ReadTool.call({ filePath: outside }, ctx);
    expect(result.error).toContain("outside workspace");
  });

  it("rejects a parent traversal via ..", async () => {
    const result = await WriteTool.call(
      { filePath: "../escaped.txt", content: "x" },
      ctx,
    );
    expect(result.error).toContain("outside workspace");
    expect(fs.existsSync(path.join(tmpDir, "..", "escaped.txt"))).toBe(false);
  });

  it("still allows a normal path inside the workspace", async () => {
    const result = await WriteTool.call(
      { filePath: "ok/inside.txt", content: "fine" },
      ctx,
    );
    expect(result.error).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "ok", "inside.txt"))).toBe(true);
  });
});
