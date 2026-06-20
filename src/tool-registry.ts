// ============================================================
// Tool Registry — Manages all available tools
// ============================================================

import type { Tool, ToolInput, ToolContext, ToolResult, PermissionResult } from "./types.js";

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  getEnabledTools(): Tool[] {
    return Array.from(this.tools.values()).filter((t) => t.isEnabled());
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Generate the "AVAILABLE TOOLS" section for system prompt
   */
  formatToolsForLLM(): string {
    return this.getEnabledTools()
      .map(
        (t) =>
          `${t.name} — ${t.promptDescription}\n  Parameters: ${JSON.stringify(t.inputSchema.properties)}`,
      )
      .join("\n\n");
  }

  /**
   * Convert to OpenAI function calling format
   */
  formatToolsForOpenAI(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: object };
  }> {
    return this.getEnabledTools().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.promptDescription,
        parameters: t.inputSchema,
      },
    }));
  }

  /**
   * Get the count of enabled tools
   */
  get enabledCount(): number {
    return this.getEnabledTools().length;
  }
}

// ============================================================
// Base Tool Implementation Helper
// ============================================================

export interface BaseToolConfig<T extends ToolInput = ToolInput> {
  name: string;
  description: string;
  promptDescription: string;
  inputSchema: Tool["inputSchema"];
  isReadOnly: boolean;
  requiresApproval?: boolean;
  isConcurrencySafe: boolean;
  call: (input: T, context: ToolContext) => Promise<ToolResult>;
  formatResult?: (result: ToolResult) => string;
  checkPermissions?: (
    input: T,
    context: ToolContext,
  ) => Promise<PermissionResult>;
}

export function createTool<T extends ToolInput = ToolInput>(
  config: BaseToolConfig<T>,
): Tool<T> {
  return {
    name: config.name,
    description: config.description,
    promptDescription: config.promptDescription,
    inputSchema: config.inputSchema,
    isEnabled: () => true, // Can be overridden
    isReadOnly: () => config.isReadOnly,
    requiresApproval: () => config.requiresApproval ?? !config.isReadOnly,
    isConcurrencySafe: () => config.isConcurrencySafe,
    call: config.call,
    formatResult:
      config.formatResult ??
      ((result: ToolResult): string => {
        if (result.error) {
          return `Error: ${result.error}`;
        }
        const metadata = result.metadata
          ? `\n[${result.metadata.durationMs ?? 0}ms]`
          : "";
        const truncated = result.truncated
          ? "\n[... result too long, truncated]"
          : "";
        return result.content + metadata + truncated;
      }),
    checkPermissions: config.checkPermissions ??
      (async (): Promise<PermissionResult> => ({ allowed: true })),
  };
}
