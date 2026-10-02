import { pathToFileURL } from "node:url";
import { z } from "zod";
import { languageServerFor } from "../../language-servers.js";
import { getLspClient } from "../../lsp.js";
import { buildTool } from "../registry.js";
export const LspNavigationTool = buildTool({
  name: "lsp",
  description: "Navigate code symbols with a configured language server",
  promptDescription:
    "Use definition, references, hover, or symbols to inspect language semantics. Configured LSP servers support any language; TypeScript and JavaScript navigation also work with bundled tsserver. Positions are 1-based.",
  schema: z.strictObject({
    operation: z.enum(["definition", "references", "hover", "symbols", "diagnostics"]),
    filePath: z.string(),
    line: z.number().int().min(1).default(1),
    column: z.number().int().min(1).default(1),
  }),
  isReadOnly: true,
  isConcurrencySafe: false,
  getPath: (input) => input.filePath,
  async call(input, context) {
    try {
      const connection = await languageServerFor(context.workspaceRoot, input.filePath);
      if (connection) {
        const uri = pathToFileURL(connection.file).href;
        const params = {
          textDocument: { uri },
          position: { line: input.line - 1, character: input.column - 1 },
          context: { includeDeclaration: true },
        };
        const methods = {
          definition: "textDocument/definition",
          references: "textDocument/references",
          hover: "textDocument/hover",
          symbols: "textDocument/documentSymbol",
          diagnostics: "textDocument/diagnostic",
        };
        const result =
          input.operation === "diagnostics"
            ? (connection.server.diagnostics.get(uri) ??
              (await connection.server.request(methods.diagnostics, params)))
            : await connection.server.request(methods[input.operation], params);
        return { content: JSON.stringify(result, null, 2) };
      }
      if (/\.[cm]?[jt]sx?$/.test(input.filePath)) {
        const client = getLspClient(context.workspaceRoot);
        if (client)
          return {
            content: JSON.stringify(
              await client.navigate(input.operation, input.filePath, input.line, input.column),
              null,
              2,
            ),
          };
      }
      return {
        content: "",
        error:
          "No language server configured for this file. Add command, args and extensionToLanguage in .claude/lsp.json or a plugin lspServers manifest.",
      };
    } catch (error) {
      return { content: "", error: String(error) };
    }
  },
});
