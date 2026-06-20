// ============================================================
// Tests: M8 breadth tools
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NotebookEditTool,
  LspDiagnosticsTool,
  createToolSearchTool,
  createMcpResourceTools,
  type MCPResourceProvider,
} from "../tools-m8.js";
import {
  EnterPlanModeTool,
  ExitPlanModeTool,
  AskUserQuestionTool,
} from "../tools-m8-interactive.js";
import { parseTscOutput, filterByFile, formatDiagnostics } from "../lsp.js";
import { markRead, resetReadTracker } from "../read-tracker.js";
import type { Tool, ToolContext, UserQuestion } from "../types.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: overrides.workspaceRoot ?? "/tmp/ws",
    sessionId: "sess-m8",
    permissionMode: "default",
    ...overrides,
  };
}

// --- 8.3 NotebookEdit ---

describe("NotebookEdit", () => {
  let dir: string;
  let nbPath: string;

  beforeEach(() => {
    resetReadTracker();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-nb-"));
    nbPath = path.join(dir, "n.ipynb");
    const nb = {
      cells: [
        { cell_type: "code", source: ["print(1)\n"], metadata: {}, outputs: [], execution_count: 1 },
        { cell_type: "markdown", source: ["# title\n"], metadata: {} },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    fs.writeFileSync(nbPath, JSON.stringify(nb), "utf-8");
    // satisfy read-before-edit
    markRead("sess-m8", nbPath, fs.statSync(nbPath).mtimeMs);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("replaces a cell's source", async () => {
    const r = await NotebookEditTool.call(
      { filePath: nbPath, cellIndex: 0, mode: "replace", source: "print(42)" },
      ctx({ workspaceRoot: dir }),
    );
    expect(r.error).toBeUndefined();
    const nb = JSON.parse(fs.readFileSync(nbPath, "utf-8"));
    expect(nb.cells[0].source).toEqual(["print(42)"]);
    expect(nb.cells[0].execution_count).toBeNull(); // cleared
  });

  it("inserts a cell after the given index", async () => {
    await NotebookEditTool.call(
      { filePath: nbPath, cellIndex: 0, mode: "insert", source: "x=1", cellType: "code" },
      ctx({ workspaceRoot: dir }),
    );
    const nb = JSON.parse(fs.readFileSync(nbPath, "utf-8"));
    expect(nb.cells).toHaveLength(3);
    expect(nb.cells[1].source).toEqual(["x=1"]);
  });

  it("deletes a cell", async () => {
    await NotebookEditTool.call(
      { filePath: nbPath, cellIndex: 1, mode: "delete" },
      ctx({ workspaceRoot: dir }),
    );
    const nb = JSON.parse(fs.readFileSync(nbPath, "utf-8"));
    expect(nb.cells).toHaveLength(1);
  });

  it("rejects non-ipynb files", async () => {
    const r = await NotebookEditTool.call(
      { filePath: path.join(dir, "a.txt"), cellIndex: 0 },
      ctx({ workspaceRoot: dir }),
    );
    expect(r.error).toContain(".ipynb");
  });

  it("rejects out-of-range index", async () => {
    const r = await NotebookEditTool.call(
      { filePath: nbPath, cellIndex: 9, mode: "replace", source: "x" },
      ctx({ workspaceRoot: dir }),
    );
    expect(r.error).toContain("out of range");
  });
});

// --- 8.4 LSP (pure parsing) ---

describe("LSP diagnostics parsing", () => {
  const sample =
    "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
    "src/b.ts(3,1): warning TS6133: 'x' is declared but never used.\n" +
    "Some unrelated line";

  it("parses tsc output into structured diagnostics", () => {
    const diags = parseTscOutput(sample);
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({
      file: "src/a.ts",
      line: 10,
      column: 5,
      severity: "error",
      code: "TS2322",
    });
  });

  it("filters by file", () => {
    const diags = parseTscOutput(sample);
    expect(filterByFile(diags, "b.ts")).toHaveLength(1);
  });

  it("formats a no-diagnostics report", () => {
    expect(formatDiagnostics([])).toContain("No diagnostics");
  });

  it("formats counts", () => {
    const diags = parseTscOutput(sample);
    expect(formatDiagnostics(diags)).toContain("1 error(s), 1 warning(s)");
  });

  it("tool reports missing tsconfig", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-lsp-"));
    const r = await LspDiagnosticsTool.call({}, ctx({ workspaceRoot: dir }));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(r.error).toContain("tsconfig.json");
  });
});

// --- 8.5 ToolSearch ---

describe("ToolSearch", () => {
  const fakeTools: Tool[] = [
    { name: "read", description: "Read a file", promptDescription: "read files from disk" } as Tool,
    { name: "grep", description: "Search contents", promptDescription: "search file contents with regex" } as Tool,
    { name: "web_search", description: "Search the web", promptDescription: "search the internet" } as Tool,
  ];
  const tool = createToolSearchTool(() => fakeTools);

  it("matches by name and description", async () => {
    const r = await tool.call({ query: "search web" }, ctx());
    expect(r.content).toContain("web_search");
  });

  it("returns a no-match message", async () => {
    const r = await tool.call({ query: "kubernetes" }, ctx());
    expect(r.content).toContain("No tools matched");
  });

  it("excludes itself from results", async () => {
    const withSelf = createToolSearchTool(() => [...fakeTools, tool]);
    const r = await withSelf.call({ query: "search" }, ctx());
    expect(r.content).not.toContain("tool_search");
  });
});

// --- 8.6 MCP resources ---

describe("MCP resource tools", () => {
  const provider: MCPResourceProvider = {
    listResources: async () => [
      { server: "fs", uri: "file:///a.txt", name: "a", mimeType: "text/plain" },
    ],
    readResource: async (uri) => (uri === "file:///a.txt" ? "hello" : null),
  };
  const [listTool, readTool] = createMcpResourceTools(provider);

  it("lists resources", async () => {
    const r = await listTool.call({}, ctx());
    expect(r.content).toContain("file:///a.txt");
  });

  it("reads a resource by uri", async () => {
    const r = await readTool.call({ uri: "file:///a.txt" }, ctx());
    expect(r.content).toBe("hello");
  });

  it("errors on missing resource", async () => {
    const r = await readTool.call({ uri: "file:///missing" }, ctx());
    expect(r.error).toContain("not found");
  });
});

// --- 8.2 Plan mode ---

describe("Plan mode tools", () => {
  it("enter_plan_mode flips context to plan", async () => {
    const c = ctx();
    await EnterPlanModeTool.call({}, c);
    expect(c.permissionMode).toBe("plan");
  });

  it("exit_plan_mode returns to default", async () => {
    const c = ctx({ permissionMode: "plan" });
    await ExitPlanModeTool.call({}, c);
    expect(c.permissionMode).toBe("default");
  });

  it("exit_plan_mode can target acceptEdits", async () => {
    const c = ctx({ permissionMode: "plan" });
    await ExitPlanModeTool.call({ to: "acceptEdits" }, c);
    expect(c.permissionMode).toBe("acceptEdits");
  });

  it("plan tools are read-only (allowed to run in plan mode)", () => {
    expect(EnterPlanModeTool.isReadOnly()).toBe(true);
    expect(ExitPlanModeTool.isReadOnly()).toBe(true);
  });
});

// --- 8.1 AskUserQuestion ---

describe("AskUserQuestion", () => {
  it("calls the injected callback and returns the selection", async () => {
    let received: UserQuestion | null = null;
    const c = ctx({
      askUserQuestion: async (q) => {
        received = q;
        return ["Option B"];
      },
    });
    const r = await AskUserQuestionTool.call(
      { question: "Pick one", options: ["Option A", "Option B"] },
      c,
    );
    expect(received).not.toBeNull();
    expect(r.content).toContain("Option B");
  });

  it("normalizes string options", async () => {
    const c = ctx({
      askUserQuestion: async (q) => [q.options[0]!.label],
    });
    const r = await AskUserQuestionTool.call(
      { question: "q", options: ["only"] },
      c,
    );
    expect(r.content).toContain("only");
  });

  it("degrades gracefully without a callback", async () => {
    const r = await AskUserQuestionTool.call(
      { question: "q", options: ["a", "b"] },
      ctx(),
    );
    expect(r.content).toContain("unavailable");
  });

  it("reports cancellation", async () => {
    const c = ctx({ askUserQuestion: async () => null });
    const r = await AskUserQuestionTool.call({ question: "q", options: ["a"] }, c);
    expect(r.content).toContain("cancelled");
  });

  it("errors with no options", async () => {
    const c = ctx({ askUserQuestion: async () => ["x"] });
    const r = await AskUserQuestionTool.call({ question: "q", options: [] }, c);
    expect(r.error).toContain("at least one option");
  });
});
