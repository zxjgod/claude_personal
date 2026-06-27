// ============================================================
// Fixture: a minimal MCP server over stdio (test double)
// ============================================================
// Used by integration-mcp.test.ts as a real "mock server". MCPManager connects
// to it via the stdio transport (command = node, args = [this file]), discovers
// its tools/resources, and round-trips a tool call — exercising the whole MCP
// integration path against the real @modelcontextprotocol/sdk, no network.
//
// Uses the low-level Server (not McpServer) so no zod schemas are needed.
// ============================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mock-stdio", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo back the provided message",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    {
      name: "add",
      description: "Add two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === "echo") {
    return { content: [{ type: "text", text: `echo: ${args.message}` }] };
  }
  if (name === "add") {
    return { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "mock://greeting", name: "greeting", mimeType: "text/plain" }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === "mock://greeting") {
    return {
      contents: [
        { uri: "mock://greeting", mimeType: "text/plain", text: "hello from mock resource" },
      ],
    };
  }
  return { contents: [] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
