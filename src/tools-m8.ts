// ============================================================
// M8 Tools — NotebookEdit, ToolSearch, LSP diagnostics, MCP resources
// ============================================================
// Breadth tools added in milestone M8. Kept in a separate file so tools.ts
// stays focused on the core file/shell tools. All file-touching tools reuse
// the workspace-resolution + read-tracker safeguards from tools.ts.
// ============================================================

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { recordChange } from "./change-tracker.js";
import {
  getLspClient,
  filterByFile as lspFilterByFile,
  formatDiagnostics as lspFormatDiagnostics,
} from "./lsp.js";
import { filterByFile, formatDiagnostics, parseTscOutput } from "./lsp-legacy.js";
import { checkReadBeforeEdit, refreshRead } from "./read-tracker.js";
import { createTool } from "./tool-registry.js";
import { relForDisplay, resolveInWorkspace, statMtimeMs } from "./tools.js";
import type { Tool, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);

// ============================================================
// 8.3 NotebookEdit — insert / replace / delete a Jupyter cell
// ============================================================

interface NotebookEditInput {
  filePath: string;
  /** 0-based index of the cell to operate on. */
  cellIndex: number;
  /** insert adds a new cell AFTER cellIndex (or at 0 if cellIndex < 0). */
  mode?: "replace" | "insert" | "delete";
  /** New source for replace/insert. Ignored for delete. */
  source?: string;
  /** Cell type for insert (defaults to "code"). */
  cellType?: "code" | "markdown";
  [key: string]: unknown;
}

interface NotebookCell {
  cell_type: string;
  source: string[] | string;
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

/** Split a source string into the line array .ipynb expects (keeps newlines). */
function toSourceLines(source: string): string[] {
  if (source === "") return [];
  const parts = source.split("\n");
  return parts.map((line, i) => (i < parts.length - 1 ? line + "\n" : line));
}

export const NotebookEditTool: Tool = createTool<NotebookEditInput>({
  name: "notebook_edit",
  description: "Edit a Jupyter notebook cell (replace / insert / delete)",
  promptDescription:
    "Edit a Jupyter (.ipynb) notebook cell. mode=replace overwrites the cell at " +
    "cellIndex; mode=insert adds a new cell after cellIndex (use -1 to prepend); " +
    "mode=delete removes it. source is the new cell text for replace/insert. " +
    "cellType (code|markdown) applies to insert. cellIndex is 0-based.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Path to the .ipynb file" },
      cellIndex: { type: "number", description: "0-based cell index" },
      mode: {
        type: "string",
        enum: ["replace", "insert", "delete"],
        description: "Operation; defaults to replace",
      },
      source: { type: "string", description: "New cell source (replace/insert)" },
      cellType: {
        type: "string",
        enum: ["code", "markdown"],
        description: "Cell type for insert; defaults to code",
      },
    },
    required: ["filePath", "cellIndex"],
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input, context): Promise<ToolResult> {
    const resolution = resolveInWorkspace(input.filePath, context.workspaceRoot);
    if (!resolution.ok) return { content: "", error: resolution.error };
    const filePath = resolution.path;

    if (!filePath.toLowerCase().endsWith(".ipynb")) {
      return { content: "", error: "notebook_edit only operates on .ipynb files" };
    }

    const mode = input.mode ?? "replace";
    try {
      const statBefore = statMtimeMs(filePath);
      const gate = checkReadBeforeEdit(context.sessionId, filePath, statBefore);
      if (!gate.ok) return { content: "", error: gate.reason! };

      const raw = fs.readFileSync(filePath, "utf-8");
      let nb: Notebook;
      try {
        nb = JSON.parse(raw);
      } catch {
        return { content: "", error: "File is not valid JSON / .ipynb" };
      }
      if (!Array.isArray(nb.cells)) {
        return { content: "", error: "Notebook has no cells array" };
      }

      const idx = input.cellIndex;

      if (mode === "delete") {
        if (idx < 0 || idx >= nb.cells.length) {
          return {
            content: "",
            error: `cellIndex ${idx} out of range (0..${nb.cells.length - 1})`,
          };
        }
        nb.cells.splice(idx, 1);
      } else if (mode === "insert") {
        if (typeof input.source !== "string") {
          return { content: "", error: "insert requires source" };
        }
        const newCell: NotebookCell = {
          cell_type: input.cellType ?? "code",
          source: toSourceLines(input.source),
          metadata: {},
        };
        if (newCell.cell_type === "code") {
          newCell.outputs = [];
          newCell.execution_count = null;
        }
        // Insert AFTER idx; idx = -1 prepends.
        const at = Math.max(0, Math.min(nb.cells.length, idx + 1));
        nb.cells.splice(at, 0, newCell);
      } else {
        // replace
        if (idx < 0 || idx >= nb.cells.length) {
          return {
            content: "",
            error: `cellIndex ${idx} out of range (0..${nb.cells.length - 1})`,
          };
        }
        if (typeof input.source !== "string") {
          return { content: "", error: "replace requires source" };
        }
        nb.cells[idx].source = toSourceLines(input.source);
        if (nb.cells[idx].cell_type === "code") {
          nb.cells[idx].outputs = [];
          nb.cells[idx].execution_count = null;
        }
      }

      const out = JSON.stringify(nb, null, 1) + "\n";
      fs.writeFileSync(filePath, out, "utf-8");
      const after = statMtimeMs(filePath);
      if (after !== undefined) refreshRead(context.sessionId, filePath, after);

      const rel = relForDisplay(filePath, context.workspaceRoot);
      recordChange(context.sessionId, rel, "modified", `notebook ${mode}`);

      return {
        content: `Notebook ${mode} applied to ${input.filePath} (cell ${idx}). Now ${nb.cells.length} cells.`,
      };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return { content: "", error: `File not found: "${input.filePath}"` };
      }
      return { content: "", error: `Error editing notebook: ${error.message}` };
    }
  },
});

// ============================================================
// 8.4 LSPTool — TypeScript diagnostics (lightweight, via tsc)
// ============================================================

interface LspDiagnosticsInput {
  /** Optional file path; when set, diagnostics are filtered to that file. */
  filePath?: string;
  [key: string]: unknown;
}

export const LspDiagnosticsTool: Tool = createTool<LspDiagnosticsInput>({
  name: "lsp_diagnostics",
  description: "Get TypeScript diagnostics for the project or a single file",
  promptDescription:
    "Run TypeScript diagnostics (tsc --noEmit) over the project and return " +
    "errors/warnings. Pass filePath to filter to one file. Use this to verify " +
    "a change type-checks before declaring it done. Requires a tsconfig.json.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Optional file to filter diagnostics to",
      },
    },
    required: [],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    const cwd = context.workspaceRoot;
    if (!fs.existsSync(`${cwd}/tsconfig.json`)) {
      return {
        content: "",
        error: "No tsconfig.json in workspace — lsp_diagnostics needs a TypeScript project.",
      };
    }

    // --- Real LSP path (M14.5) -------------------------------------------------
    // Try the long-lived tsserver connection first. Only the single-file
    // case is supported over LSP here; whole-project diagnostics fall
    // through to the tsc shell-out (tsserver drives diagnostics per open
    // document). The Diagnostic shape is identical, so output is uniform.
    if (typeof input.filePath === "string" && input.filePath) {
      const resolved = `${cwd}/${input.filePath}`.replace(/\\/g, "/").replace(/\/+/g, "/");
      const abs =
        input.filePath.startsWith(cwd) || path.isAbsolute(input.filePath)
          ? input.filePath
          : resolved;
      const client = getLspClient(cwd);
      if (client) {
        try {
          const diags = await client.getDiagnostics(abs, 15_000);
          return { content: lspFormatDiagnostics(lspFilterByFile(diags, input.filePath)) };
        } catch {
          // Fall through to tsc on any LSP failure.
        }
      }
    }

    // --- tsc fallback ----------------------------------------------------------
    let output = "";
    try {
      const { stdout } = await execFileAsync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
        cwd,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        shell: process.platform === "win32",
      });
      output = stdout;
    } catch (error: any) {
      // tsc exits non-zero when diagnostics exist; its stdout still holds them.
      output = (error.stdout as string) || "";
      if (!output && error.message) {
        return { content: "", error: `tsc failed: ${error.message}` };
      }
    }

    let diagnostics = parseTscOutput(output);
    if (typeof input.filePath === "string" && input.filePath) {
      diagnostics = filterByFile(diagnostics, input.filePath);
    }
    return { content: formatDiagnostics(diagnostics) };
  },
});

// ============================================================
// 8.5 ToolSearch — discover tools by description (factory)
// ============================================================
// ToolSearch needs the live tool list, so it's built via a factory that the
// CLI calls with a getter into the registry. Matching is a simple scored
// substring/keyword search over name + description + prompt description.

export function createToolSearchTool(getTools: () => Tool[]): Tool {
  interface ToolSearchInput {
    query: string;
    [key: string]: unknown;
  }
  return createTool<ToolSearchInput>({
    name: "tool_search",
    description: "Search available tools by keyword",
    promptDescription:
      "Search the available tools by keyword when you're unsure which tool fits. " +
      "Returns matching tool names with their descriptions. Useful as the tool " +
      "set grows (core + MCP).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords describing what you want to do" },
      },
      required: ["query"],
    },
    isReadOnly: true,
    isConcurrencySafe: true,

    async call(input): Promise<ToolResult> {
      const query = String(input.query || "")
        .toLowerCase()
        .trim();
      if (!query) return { content: "", error: "query is required" };
      const terms = query.split(/\s+/).filter(Boolean);

      const scored = getTools()
        .filter((t) => t.name !== "tool_search")
        .map((t) => {
          const haystack = `${t.name} ${t.description} ${t.promptDescription}`.toLowerCase();
          let score = 0;
          for (const term of terms) {
            if (t.name.toLowerCase().includes(term)) score += 3;
            else if (haystack.includes(term)) score += 1;
          }
          return { tool: t, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

      if (scored.length === 0) {
        return { content: `No tools matched "${input.query}".` };
      }
      const lines = scored.map((s) => `- ${s.tool.name} — ${s.tool.promptDescription}`);
      return { content: `Matching tools:\n${lines.join("\n")}` };
    },
  });
}

// ============================================================
// 8.6 MCP Resource tools — list / read MCP resources (factory)
// ============================================================
// Structural interface so this module doesn't depend on the concrete
// MCPManager (avoids a cycle and keeps it testable with a fake).

export interface MCPResourceProvider {
  listResources(): Promise<
    Array<{ server: string; uri: string; name?: string; mimeType?: string }>
  >;
  readResource(uri: string): Promise<string | null>;
}

export function createMcpResourceTools(provider: MCPResourceProvider): Tool[] {
  const listTool = createTool({
    name: "mcp_list_resources",
    description: "List resources exposed by connected MCP servers",
    promptDescription:
      "List all resources exposed by connected MCP servers (uri, name, server). " +
      "Use mcp_read_resource to fetch one by uri.",
    inputSchema: { type: "object", properties: {}, required: [] },
    isReadOnly: true,
    isConcurrencySafe: true,
    async call(): Promise<ToolResult> {
      const resources = await provider.listResources();
      if (resources.length === 0) {
        return { content: "No MCP resources available." };
      }
      const lines = resources.map(
        (r) =>
          `- [${r.server}] ${r.uri}${r.name ? ` (${r.name})` : ""}${r.mimeType ? ` <${r.mimeType}>` : ""}`,
      );
      return { content: `MCP resources (${resources.length}):\n${lines.join("\n")}` };
    },
  });

  interface ReadResourceInput {
    uri: string;
    [key: string]: unknown;
  }
  const readTool = createTool<ReadResourceInput>({
    name: "mcp_read_resource",
    description: "Read an MCP resource by URI",
    promptDescription: "Read the contents of an MCP resource by its uri (from mcp_list_resources).",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string", description: "Resource URI to read" } },
      required: ["uri"],
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async call(input): Promise<ToolResult> {
      const uri = String(input.uri || "").trim();
      if (!uri) return { content: "", error: "uri is required" };
      const text = await provider.readResource(uri);
      if (text === null) {
        return { content: "", error: `Resource not found: ${uri}` };
      }
      return { content: text };
    },
  });

  return [listTool, readTool];
}
