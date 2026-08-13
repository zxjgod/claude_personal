// ============================================================
// Tool Registry — Manages all available tools
// ============================================================

import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { PermissionResult, Tool, ToolContext, ToolInput, ToolResult } from "../types.js";
import { DEFAULT_MAX_RESULT_CHARS } from "./truncation.js";

/** Where a tool came from — drives /tools-style listings. */
export type ToolSource = "core" | "mcp";

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  // Registration-order source records, so /tools can show where each tool
  // came from without a second hand-maintained array in cli.ts (which could
  // drift from what the loop actually uses).
  private sources: Array<{ tool: Tool; source: ToolSource }> = [];

  register(tool: Tool, source: ToolSource = "core"): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    this.sources.push({ tool, source });
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.sources = this.sources.filter((s) => s.tool.name !== name);
  }

  getEnabledTools(): Tool[] {
    return Array.from(this.tools.values()).filter((t) => t.isEnabled());
  }

  /**
   * Every registered tool in registration order, tagged with its source
   * ("core" | "mcp"). Single source of truth for /tools-style listings.
   */
  listSources(): Array<{ tool: Tool; source: ToolSource }> {
    return this.sources;
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get the count of enabled tools
   */
  get enabledCount(): number {
    return this.getEnabledTools().length;
  }
}

// ============================================================
// M28 · Tool contract — fail-closed defaults + strict validation
// ============================================================

/**
 * Raised when a tool's input fails semantic validation (M28). The executor
 * maps this to a model-facing <tool_use_error> envelope so the model can
 * correct its arguments, rather than crashing the loop.
 */
export class InputValidationError extends Error {
  constructor(
    message: string,
    readonly toolName: string,
  ) {
    super(message);
    this.name = "InputValidationError";
  }
}

/**
 * Wrap an error message in the kernel's <tool_use_error> envelope. The model
 * is trained to treat this as a recoverable tool failure (kernel §2). Kept as
 * a single helper so the envelope format lives in exactly one place.
 */
export function toolUseError(message: string): string {
  return `<tool_use_error>${message}</tool_use_error>`;
}

/**
 * Fail-closed capability defaults (M28). Any capability a tool author forgets
 * to declare lands in its SAFEST state: not read-only (so it routes through
 * approval), not concurrency-safe (so it runs serially), not auto-approved.
 * A permissive default here would silently widen the blast radius of every
 * future tool — the escape valve must always be opt-in.
 */
export const TOOL_DEFAULTS = {
  isReadOnly: false,
  isConcurrencySafe: false,
  requiresApproval: undefined as boolean | undefined,
  interruptBehavior: "kill" as "kill" | "wait",
  maxResultSizeChars: DEFAULT_MAX_RESULT_CHARS,
} as const;

// ============================================================
// Base Tool Implementation Helper
// ============================================================

/** Fields shared by both the legacy createTool and the Zod-backed buildTool. */
interface CommonToolConfig<T extends ToolInput> {
  name: string;
  description: string;
  promptDescription: string;
  /**
   * Read-only flag. A boolean for the common static case, or a predicate over
   * the input for data-driven tools (M29) — Bash is read-only for `cat`, not
   * `rm`. Omitted → fail-closed (mutating).
   */
  isReadOnly?: boolean | ((input: T) => boolean);
  requiresApproval?: boolean;
  /**
   * Concurrency-safe flag. Boolean or input predicate (M29). Omitted →
   * fail-closed (not safe, runs serially).
   */
  isConcurrencySafe?: boolean | ((input: T) => boolean);
  isDestructive?: (input: T) => boolean;
  aliases?: string[];
  searchHint?: string;
  interruptBehavior?: "kill" | "wait";
  getPath?: (input: T) => string | undefined;
  /** Soft cap on model-facing result chars (M30); over this, results spill to disk. */
  maxResultSizeChars?: number;
  call: (input: T, context: ToolContext) => Promise<ToolResult>;
  formatResult?: (result: ToolResult) => string;
  checkPermissions?: (input: T, context: ToolContext) => Promise<PermissionResult>;
}

/** Default result formatter shared by every tool. */
function defaultFormatResult(result: ToolResult): string {
  if (result.error) {
    return `Error: ${result.error}`;
  }
  const metadata = result.metadata ? `\n[${result.metadata.durationMs ?? 0}ms]` : "";
  const truncated = result.truncated ? "\n[... result too long, truncated]" : "";
  return result.content + metadata + truncated;
}

/**
 * Assemble a Tool from common config + a resolved inputSchema, applying
 * fail-closed TOOL_DEFAULTS for any capability the author left unspecified.
 * Both createTool and buildTool funnel through here so the defaults live in
 * exactly one place.
 */
function finalizeTool<T extends ToolInput>(
  config: CommonToolConfig<T>,
  inputSchema: Tool["inputSchema"],
  validateInput: ((input: Record<string, unknown>) => T) | undefined,
): Tool<T> {
  // Normalize each capability flag to a predicate over the (optional) input.
  // A boolean config becomes a constant predicate; an omitted one falls back to
  // the fail-closed TOOL_DEFAULTS. Absent input (static UI listings) resolves
  // through the predicate too — data-driven tools must handle `undefined`
  // conservatively (see Bash).
  const roCfg = config.isReadOnly;
  const csCfg = config.isConcurrencySafe;
  const isReadOnlyFn = (input?: T): boolean =>
    typeof roCfg === "function" ? roCfg(input as T) : (roCfg ?? TOOL_DEFAULTS.isReadOnly);
  const isConcurrencySafeFn = (input?: T): boolean =>
    typeof csCfg === "function" ? csCfg(input as T) : (csCfg ?? TOOL_DEFAULTS.isConcurrencySafe);
  // For static derivations (requiresApproval / isDestructive defaults) use the
  // boolean config when given; a data-driven (function) config has no single
  // static answer, so fall back to the fail-closed default rather than invoking
  // the predicate with no input at build time.
  const staticReadOnly = typeof roCfg === "boolean" ? roCfg : TOOL_DEFAULTS.isReadOnly;
  return {
    name: config.name,
    description: config.description,
    promptDescription: config.promptDescription,
    inputSchema,
    aliases: config.aliases,
    searchHint: config.searchHint,
    interruptBehavior: config.interruptBehavior ?? TOOL_DEFAULTS.interruptBehavior,
    maxResultSizeChars: config.maxResultSizeChars ?? TOOL_DEFAULTS.maxResultSizeChars,
    isEnabled: () => true, // Can be overridden
    isReadOnly: (input?: T) => isReadOnlyFn(input),
    // requiresApproval defaults to "anything that isn't read-only" — fail-closed.
    requiresApproval: () => config.requiresApproval ?? !staticReadOnly,
    isConcurrencySafe: (input?: T) => isConcurrencySafeFn(input),
    // isDestructive defaults to "not read-only" so un-annotated mutating tools
    // are still treated as risky by the classifier/UI.
    isDestructive: config.isDestructive ?? ((): boolean => !staticReadOnly),
    getPath: config.getPath,
    validateInput,
    call: config.call,
    formatResult: config.formatResult ?? defaultFormatResult,
    checkPermissions:
      config.checkPermissions ?? (async (): Promise<PermissionResult> => ({ allowed: true })),
  };
}

export interface BaseToolConfig<T extends ToolInput = ToolInput> extends CommonToolConfig<T> {
  inputSchema: Tool["inputSchema"];
}

/**
 * Legacy builder: takes a hand-written JSON Schema and no runtime validation.
 * Retained for tools not yet migrated to Zod. New tools should prefer
 * buildTool, which derives the schema and validates input strictly.
 */
export function createTool<T extends ToolInput = ToolInput>(config: BaseToolConfig<T>): Tool<T> {
  return finalizeTool(config, config.inputSchema, undefined);
}

// Cache the model-facing JSON Schema per tool name so we run zodToJsonSchema
// once per tool, not on every system-prompt rebuild.
const jsonSchemaCache = new Map<string, Tool["inputSchema"]>();

export interface BuildToolConfig<S extends z.ZodType>
  extends CommonToolConfig<z.infer<S> & ToolInput> {
  /**
   * A Zod object schema (use z.strictObject so unknown keys the model injects
   * are REJECTED, not silently passed through). Drives both model-facing JSON
   * Schema generation and runtime validation.
   */
  schema: S;
}

/**
 * Canonical M28 tool builder. Derives the model-facing JSON Schema from a Zod
 * schema (memoized per name) and installs a validateInput that strict-parses
 * every call — stripping/rejecting unknown keys and coercing the input to the
 * tool's typed shape. Fail-closed defaults come from finalizeTool.
 */
export function buildTool<S extends z.ZodType>(
  config: BuildToolConfig<S>,
): Tool<z.infer<S> & ToolInput> {
  type T = z.infer<S> & ToolInput;
  const cached = jsonSchemaCache.get(config.name);
  let inputSchema: Tool["inputSchema"];
  if (cached) {
    inputSchema = cached;
  } else {
    const generated = zodToJsonSchema(config.schema, {
      target: "openApi3",
      $refStrategy: "none",
    }) as Record<string, unknown>;
    inputSchema = {
      type: "object",
      properties: (generated.properties as Tool["inputSchema"]["properties"]) ?? {},
      required: (generated.required as string[]) ?? [],
    };
    jsonSchemaCache.set(config.name, inputSchema);
  }

  const validateInput = (input: Record<string, unknown>): T => {
    const parsed = config.schema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new InputValidationError(`Invalid arguments: ${detail}`, config.name);
    }
    return parsed.data as T;
  };

  return finalizeTool<T>(config, inputSchema, validateInput);
}
