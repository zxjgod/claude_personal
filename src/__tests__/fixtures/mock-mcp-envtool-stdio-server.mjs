// ============================================================
// Fixture: a minimal MCP server over stdio whose single tool is
// configured from the environment (test double).
// ============================================================
// Used by mcp-tool-result.test.ts to exercise two MCPManager paths
// that the shared mock server cannot reach:
//   - wrapped-name collisions across servers (`mcp__${server}__${tool}`
//     is ambiguous when a name contains `__`), and
//   - a remote tool reporting failure via `isError: true` rather than
//     by throwing (protocol-level error, not a transport error).
//
// MOCK_MCP_TOOL       — the tool name it advertises
// MOCK_MCP_DESCRIPTION— its description (varies the definition hash)
// MOCK_MCP_TAG        — echoed back in the result text, so a test can tell
//                       which server instance actually served the call
// ============================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const toolName = process.env.MOCK_MCP_TOOL || "probe";
const description = process.env.MOCK_MCP_DESCRIPTION || "probe tool";
const tag = process.env.MOCK_MCP_TAG || "default";

const server = new Server({ name: "mock-envtool", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: toolName,
      description,
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" }, fail: { type: "boolean" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { arguments: args = {} } = req.params;
  const text = `${tag}:${args.message}`;
  if (args.fail) return { content: [{ type: "text", text: `${tag}:tool refused` }], isError: true };
  return { content: [{ type: "text", text }] };
});

await server.connect(new StdioServerTransport());