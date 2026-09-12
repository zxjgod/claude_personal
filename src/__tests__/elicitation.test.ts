import { ElicitRequestSchema, ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

describe("MCP elicitation protocol", () => {
  it("accepts form and URL request shapes", () => {
    const form = ElicitRequestSchema.parse({
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Choose",
        requestedSchema: {
          type: "object",
          properties: { project: { type: "string", enum: ["a"] } },
        },
      },
    });
    const url = ElicitRequestSchema.parse({
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Authorize",
        url: "https://example.com/auth",
        elicitationId: "e1",
      },
    });
    expect(form.params.mode).toBe("form");
    expect(url.params.mode).toBe("url");
  });
  it("validates accept, decline, and cancel results", () => {
    for (const action of ["accept", "decline", "cancel"] as const)
      expect(ElicitResultSchema.parse({ action }).action).toBe(action);
  });
});
