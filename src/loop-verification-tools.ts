import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LoopCheckResult } from "./loop-completion.js";
import { executeSingleTool } from "./tool-executor.js";
import { clearCwd, getCwd, setCwd } from "./tools/session-cwd.js";
import { imageMediaType } from "./tools/utils/file.js";
import type { AskUserFn, HookRunner, Tool, ToolContext, ToolExecutionResult } from "./types.js";
import { activeWorkspace } from "./worktrees.js";

/** Completion checks use the same permissions, hooks and cancellation as ordinary tools. */
export function loopVerificationTools(
  tools: Tool[],
  context: ToolContext,
  askUser: AskUserFn,
  hooks?: HookRunner,
  display?: (result: ToolExecutionResult) => void,
) {
  const execute = async (
    name: string,
    input: Record<string, unknown>,
    contextOverride?: ToolContext,
  ) => {
    const result = await executeSingleTool(
      {
        id: `loop-check-${Date.now()}`,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      },
      tools,
      contextOverride ?? context,
      askUser,
      hooks,
      undefined,
      undefined,
      context.abortSignal,
    );
    display?.(result);
    return result;
  };
  return {
    runCheck: async (command: string): Promise<LoopCheckResult> => {
      const previous = getCwd(context.sessionId);
      setCwd(context.sessionId, activeWorkspace(context.sessionId, context.workspaceRoot));
      try {
        const result = await execute("Bash", { command, description: "Loop completion check" });
        return {
          name: command,
          passed: !result.error && !result.result?.error && !result.result?.metadata?.aborted,
          output: result.error ?? result.formatted,
        };
      } finally {
        if (previous) setCwd(context.sessionId, previous);
        else clearCwd(context.sessionId);
      }
    },
    runFileCheck: async (file: string): Promise<LoopCheckResult> => {
      const mediaType = imageMediaType(file);
      const isPdf = mediaType === "application/pdf";
      // Overriding media support only makes sense with a concrete modelConfig;
      // spreading an absent one would fabricate an invalid partial config.
      const fileContext: ToolContext =
        mediaType && context.modelConfig
          ? {
              ...context,
              modelConfig: {
                ...context.modelConfig,
                options: {
                  ...context.modelConfig.options,
                  supportsImages: !isPdf,
                },
              },
            }
          : context;
      const result = await execute(
        "Read",
        isPdf ? { filePath: file, pages: "1" } : { filePath: file, limit: 1 },
        fileContext,
      );
      if (result.error || result.result?.error)
        return {
          name: file,
          passed: false,
          output: result.error ?? result.result?.error ?? "File check failed.",
        };
      try {
        return {
          name: file,
          passed: true,
          output: createHash("sha256").update(readFileSync(file)).digest("hex"),
        };
      } catch (error) {
        return {
          name: file,
          passed: false,
          output: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
