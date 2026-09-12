// ============================================================
// Breadth Tools — NotebookEdit, ToolSearch, LSP diagnostics, MCP resources
// ============================================================
// (Originally milestone M8; directory renamed from m8/.) Kept in a separate
// file so tools.ts stays focused on the core file/shell tools. All
// file-touching tools reuse the workspace-resolution + read-tracker
// safeguards from tools.ts.
// ============================================================

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import { recordChange } from "../../change-tracker.js";
import { shadowBeforeWrite } from "../../checkpoint.js";
import {
  getLspClient,
  filterByFile as lspFilterByFile,
  formatDiagnostics as lspFormatDiagnostics,
} from "../../lsp.js";
import { filterByFile, formatDiagnostics, parseTscOutput } from "../../lsp-legacy.js";
import { checkReadBeforeEdit, refreshRead } from "../../read-tracker.js";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";
import {
  relForDisplay,
  resolveAllowedWorkspaceFile,
  resolveInWorkspace,
  statMtimeMs,
} from "../utils/path.js";

const execFileAsync = promisify(execFile);

// ============================================================
// 8.3 NotebookEdit — insert / replace / delete a Jupyter cell
// ============================================================

const NotebookSchema = z.strictObject({
  filePath: z.string().describe("Path to the .ipynb file"),
  cellIndex: z.number().int().describe("0-based index of the cell to operate on"),
  mode: z
    .enum(["replace", "insert", "delete"])
    .optional()
    .describe("Operation; defaults to replace"),
  source: z.string().optional().describe("New cell source (replace/insert)"),
  cellType: z
    .enum(["code", "markdown"])
    .optional()
    .describe("Cell type for insert; defaults to code"),
});

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

export const NotebookEditTool: Tool = buildTool({
  name: "notebook_edit",
  description: "Edit a Jupyter notebook cell (replace / insert / delete)",
  promptDescription:
    "Edit a Jupyter (.ipynb) notebook cell. mode=replace overwrites the cell at " +
    "cellIndex; mode=insert adds a new cell after cellIndex (use -1 to prepend); " +
    "mode=delete removes it. source is the new cell text for replace/insert. " +
    "cellType (code|markdown) applies to insert. cellIndex is 0-based.",
  schema: NotebookSchema,
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input, context): Promise<ToolResult> {
    const resolution = resolveInWorkspace(
      input.filePath,
      context.workspaceRoot,
      context.allowedDirectories,
    );
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
      shadowBeforeWrite(context.sessionId, filePath); // P0-3: shadow for rewind
      fs.writeFileSync(filePath, out, "utf-8");
      const after = statMtimeMs(filePath);
      if (after !== undefined) refreshRead(context.sessionId, filePath, after);

      const rel = relForDisplay(filePath, context.workspaceRoot);
      recordChange(context.sessionId, rel, "modified", `notebook ${mode}`);

      return {
        content: `Notebook ${mode} applied to ${input.filePath} (cell ${idx}). Now ${nb.cells.length} cells.`,
      };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return { content: "", error: `File not found: "${input.filePath}"` };
      }
      return { content: "", error: `Error editing notebook: ${errno.message}` };
    }
  },
});

// ============================================================
// 8.4 LSPTool — TypeScript diagnostics (lightweight, via tsc)
// ============================================================

const LspDiagnosticsSchema = z.strictObject({
  filePath: z.string().optional().describe("Optional file to filter diagnostics to"),
});

export const LspDiagnosticsTool: Tool = buildTool({
  name: "lsp_diagnostics",
  description: "Get TypeScript diagnostics for the project or a single file",
  promptDescription:
    "Run TypeScript diagnostics (tsc --noEmit) over the project and return " +
    "errors/warnings. Pass filePath to filter to one file. Use this to verify " +
    "a change type-checks before declaring it done. Requires a tsconfig.json.",
  schema: LspDiagnosticsSchema,
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
      const resolution = resolveAllowedWorkspaceFile(
        input.filePath,
        cwd,
        context.allowedDirectories,
      );
      if (!resolution.ok) return { content: "", error: resolution.error };
      const abs = resolution.path;
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
    } catch (error) {
      // tsc exits non-zero when diagnostics exist; its stdout still holds them.
      const execError = error as { stdout?: string; message?: string };
      output = execError.stdout || "";
      if (!output && execError.message) {
        return { content: "", error: `tsc failed: ${execError.message}` };
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
// 8.4b LSP completions — code completion via the live tsserver
// ============================================================

const LspCompletionsSchema = z.strictObject({
  filePath: z.string().describe("File to request completions for"),
  line: z.number().int().describe("1-based line number of the cursor"),
  column: z.number().int().describe("1-based column (character offset) of the cursor"),
});

export const LspCompletionsTool: Tool = buildTool({
  name: "lsp_completions",
  description: "Get TypeScript code completions at a cursor position",
  promptDescription:
    "Request code completions at a specific cursor position from the live " +
    "tsserver. filePath is the file; line and column are 1-based. Returns up to " +
    "50 completion names (with kind and insertText). Requires a tsconfig.json.",
  schema: LspCompletionsSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input, context): Promise<ToolResult> {
    const cwd = context.workspaceRoot;
    if (!fs.existsSync(`${cwd}/tsconfig.json`)) {
      return {
        content: "",
        error: "No tsconfig.json in workspace — lsp_completions needs a TypeScript project.",
      };
    }
    const resolution = resolveAllowedWorkspaceFile(input.filePath, cwd, context.allowedDirectories);
    if (!resolution.ok) return { content: "", error: resolution.error };
    const client = getLspClient(cwd);
    if (!client) {
      return { content: "", error: "tsserver unavailable — cannot fetch completions." };
    }
    try {
      const items = await client.getCompletions(resolution.path, input.line, input.column);
      if (items.length === 0) return { content: "No completions." };
      const lines = items.map(
        (i) =>
          `- ${i.name}${i.kind ? ` [${i.kind}]` : ""}${i.insertText ? ` → ${i.insertText}` : ""}`,
      );
      return { content: `Completions (${items.length}):\n${lines.join("\n")}` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { content: "", error: `Completion failed: ${message}` };
    }
  },
});

// ============================================================
// 8.5 ToolSearch — discover tools by description (factory)
// ============================================================
// ToolSearch needs the live tool list, so it's built via a factory that the
// CLI calls with a getter into the registry. Matching is a simple scored
// substring/keyword search over name + description + prompt description.

export function createToolSearchTool(getTools: () => Tool[]): Tool {
  const ToolSearchSchema = z.strictObject({
    query: z.string().describe("Keywords describing what you want to do"),
  });
  return buildTool({
    name: "tool_search",
    description: "Search available tools by keyword",
    promptDescription:
      "Search the available tools by keyword when you're unsure which tool fits. " +
      "Returns matching tool names with their descriptions. Useful as the tool " +
      "set grows (core + MCP).",
    schema: ToolSearchSchema,
    isReadOnly: true,
    isConcurrencySafe: true,

    async call(input): Promise<ToolResult> {
      const query = input.query.toLowerCase().trim();
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
  listPrompts?(): Promise<Array<{ server: string; name: string; description?: string }>>;
  getPrompt?(name: string, args?: Record<string, string>): Promise<string | null>;
}

export function createMcpResourceTools(provider: MCPResourceProvider): Tool[] {
  const ListMcpResourcesSchema = z.strictObject({});
  const listTool = buildTool({
    name: "mcp_list_resources",
    description: "List resources exposed by connected MCP servers",
    promptDescription:
      "List all resources exposed by connected MCP servers (uri, name, server). " +
      "Use mcp_read_resource to fetch one by uri.",
    schema: ListMcpResourcesSchema,
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

  const ReadMcpResourceSchema = z.strictObject({
    uri: z.string().describe("Resource URI to read"),
  });
  const readTool = buildTool({
    name: "mcp_read_resource",
    description: "Read an MCP resource by URI",
    promptDescription: "Read the contents of an MCP resource by its uri (from mcp_list_resources).",
    schema: ReadMcpResourceSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    async call(input): Promise<ToolResult> {
      const uri = input.uri.trim();
      if (!uri) return { content: "", error: "uri is required" };
      const text = await provider.readResource(uri);
      if (text === null) {
        return { content: "", error: `Resource not found: ${uri}` };
      }
      return { content: text };
    },
  });

  const promptTools: Tool[] = [];
  if (provider.listPrompts && provider.getPrompt) {
    const listPrompts = buildTool({
      name: "mcp_list_prompts",
      description: "List prompts exposed by connected MCP servers",
      promptDescription:
        "List MCP server prompts available as reusable slash-style prompt templates.",
      schema: z.strictObject({}),
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(): Promise<ToolResult> {
        const prompts = await provider.listPrompts!();
        return {
          content: prompts.length
            ? prompts
                .map(
                  (p) => `- [${p.server}] ${p.name}${p.description ? ` — ${p.description}` : ""}`,
                )
                .join("\n")
            : "No MCP prompts available.",
        };
      },
    });
    const getPrompt = buildTool({
      name: "mcp_get_prompt",
      description: "Render an MCP prompt by name",
      promptDescription:
        "Fetch a prompt template from an MCP server. name is the prompt name; arguments are optional string values.",
      schema: z.strictObject({ name: z.string(), arguments: z.record(z.string()).optional() }),
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input): Promise<ToolResult> {
        const text = await provider.getPrompt!(input.name, input.arguments);
        return text === null
          ? { content: "", error: `MCP prompt not found: ${input.name}` }
          : { content: text };
      },
    });
    promptTools.push(listPrompts, getPrompt);
  }
  return [listTool, readTool, ...promptTools];
}
