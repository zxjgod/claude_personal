// ============================================================
// Slash Commands — local REPL commands handled before the LLM
// ============================================================
// Input starting with "/" is matched here first. A command can mutate
// session state (messages, model) and print directly; it never hits the
// model unless it explicitly asks the caller to fall through.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { autoCompact } from "./agent-loop.js";
import type { Message, ModelConfig, ModelCaller, Tool } from "./types.js";
import type { PersistenceManager } from "./persistence.js";
import type { SessionStats } from "./session-stats.js";
import { formatUsd, formatDuration } from "./session-stats.js";
import { listChanges, clearChanges } from "./change-tracker.js";

/** Source label for a tool listed by /tools. */
export type ToolSource = "core" | "mcp";

/** Mutable session state a command may read or change. */
export interface CommandContext {
  messages: Message[];
  modelConfig: ModelConfig;
  callModel: ModelCaller;
  workspaceRoot: string;
  sessionId: string;
  persistence?: PersistenceManager;
  ui?: {
    showTokens: boolean;
    verbose: boolean;
  };
  permissions?: {
    listAlwaysAllow(): string[];
    clearAlwaysAllow(): void;
  };
  resumeSession?: (sessionId: string) => Promise<boolean>;
  /** Cumulative token/cost/tool stats for this session. */
  stats?: SessionStats;
  /** Tools loaded this session, with their source for /tools. */
  tools?: Array<{ tool: Tool; source: ToolSource }>;
  /** The active permission mode (for /status, /config). */
  permissionMode?: string;
  /** The assembled system prompt (for /context token breakdown). */
  systemPrompt?: string;
  /** Number of connected MCP servers (for /status). */
  mcpServerCount?: number;
}

export interface CommandResult {
  /** True if the input was a recognized slash command (don't send to LLM). */
  handled: boolean;
  /** True if the REPL should exit. */
  exit?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  run: (args: string, ctx: CommandContext) => Promise<void> | void;
}

const COMMANDS: SlashCommand[] = [
  {
    name: "help",
    description: "Show available commands",
    run: () => {
      console.log("");
      console.log(chalk.bold("  Commands:"));
      for (const cmd of COMMANDS) {
        console.log(`    ${chalk.cyan("/" + cmd.name).padEnd(20)} ${chalk.gray(cmd.description)}`);
      }
      console.log(`    ${chalk.cyan("@<path>").padEnd(20)} ${chalk.gray("Inject a file's contents into your message")}`);
      console.log(`    ${chalk.cyan("exit").padEnd(20)} ${chalk.gray("Quit")}`);
    },
  },
  {
    name: "clear",
    description: "Clear the conversation history",
    run: (_args, ctx) => {
      ctx.messages.length = 0;
      clearChanges(ctx.sessionId);
      console.log(chalk.gray("  Conversation cleared."));
    },
  },
  {
    name: "model",
    description: "Show or switch the active model (/model <id>)",
    run: (args, ctx) => {
      const next = args.trim();
      if (!next) {
        console.log(`  Model: ${chalk.cyan(ctx.modelConfig.model)} (${ctx.modelConfig.provider})`);
        return;
      }
      const prev = ctx.modelConfig.model;
      ctx.modelConfig.model = next;
      console.log(chalk.gray(`  Model: ${prev} → ${chalk.cyan(next)}`));
    },
  },
  {
    name: "compact",
    description: "Summarize and compress the conversation now",
    run: async (_args, ctx) => {
      if (ctx.messages.length === 0) {
        console.log(chalk.gray("  Nothing to compact."));
        return;
      }
      const before = ctx.messages.length;
      console.log(chalk.gray("  📦 Compacting..."));
      const compacted = await autoCompact(ctx.messages, ctx.callModel, ctx.modelConfig);
      // Replace contents in place so the caller keeps the same array reference.
      ctx.messages.length = 0;
      ctx.messages.push(...compacted);
      console.log(chalk.gray(`  Compacted ${before} → ${ctx.messages.length} messages.`));
    },
  },
  {
    name: "tokens",
    description: "Show message count or toggle token display (/tokens on|off)",
    run: (_args, ctx) => {
      const arg = _args.trim().toLowerCase();
      if (arg === "on" || arg === "show") {
        if (ctx.ui) ctx.ui.showTokens = true;
        console.log(chalk.gray("  Token usage display: on"));
        return;
      }
      if (arg === "off" || arg === "hide") {
        if (ctx.ui) ctx.ui.showTokens = false;
        console.log(chalk.gray("  Token usage display: off"));
        return;
      }
      console.log(chalk.gray(`  Messages in context: ${ctx.messages.length}`));
      if (ctx.ui) {
        console.log(chalk.gray(`  Token usage display: ${ctx.ui.showTokens ? "on" : "off"}`));
      }
    },
  },
  {
    name: "doctor",
    description: "Check environment, provider, workspace, and build status",
    run: (_args, ctx) => {
      const hasKey = Boolean(ctx.modelConfig.apiKey);
      const distCli = fs.existsSync("dist/cli.js");
      const packageJson = fs.existsSync("package.json");
      const workspaceExists = fs.existsSync(ctx.workspaceRoot);
      const envExists = fs.existsSync(".env");

      console.log("");
      console.log(chalk.bold("  Doctor:"));
      console.log(`    Node:        ${chalk.cyan(process.version)}`);
      console.log(`    Provider:    ${chalk.cyan(ctx.modelConfig.provider)}`);
      console.log(`    Model:       ${chalk.cyan(ctx.modelConfig.model)}`);
      console.log(`    API key:     ${hasKey ? chalk.green("set") : chalk.red("missing")}`);
      console.log(`    .env:        ${envExists ? chalk.green("present") : chalk.yellow("missing")}`);
      console.log(`    Workspace:   ${workspaceExists ? chalk.green(ctx.workspaceRoot) : chalk.red(ctx.workspaceRoot)}`);
      console.log(`    package.json:${packageJson ? chalk.green(" present") : chalk.red(" missing")}`);
      console.log(`    dist/cli.js: ${distCli ? chalk.green("built") : chalk.yellow("not built (run npm run build)")}`);
    },
  },
  {
    name: "sessions",
    description: "List saved sessions",
    run: async (_args, ctx) => {
      if (!ctx.persistence) {
        console.log(chalk.yellow("  Session persistence is not available."));
        return;
      }
      const sessions = await ctx.persistence.listSessions();
      if (sessions.length === 0) {
        console.log(chalk.gray("  No saved sessions."));
        return;
      }
      console.log("");
      console.log(chalk.bold("  Sessions:"));
      for (const s of sessions.slice(0, 10)) {
        const marker = s.sessionId === ctx.sessionId ? chalk.green("*") : " ";
        console.log(
          `  ${marker} ${s.sessionId.slice(0, 8)}... — ${s.messageCount} msgs — ${new Date(s.updatedAt).toLocaleString()} — ${s.completed ? "done" : "open"}`,
        );
      }
      console.log(chalk.gray("  Use /resume <session-prefix-or-id> to switch."));
    },
  },
  {
    name: "resume",
    description: "Resume a saved session (/resume <id-prefix>)",
    run: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        console.log(chalk.yellow("  Usage: /resume <session-prefix-or-id>"));
        return;
      }
      if (!ctx.resumeSession) {
        console.log(chalk.yellow("  Resume is not available."));
        return;
      }
      const ok = await ctx.resumeSession(id);
      if (!ok) {
        console.log(chalk.yellow(`  Session not found or ambiguous: ${id}`));
      }
    },
  },
  {
    name: "permissions",
    description: "Show or clear always-allow permission memory",
    run: (args, ctx) => {
      if (!ctx.permissions) {
        console.log(chalk.yellow("  Permission memory is not available."));
        return;
      }
      const arg = args.trim().toLowerCase();
      if (arg === "clear") {
        ctx.permissions.clearAlwaysAllow();
        console.log(chalk.gray("  Always-allow permission memory cleared."));
        return;
      }
      const items = ctx.permissions.listAlwaysAllow();
      if (items.length === 0) {
        console.log(chalk.gray("  No always-allow permissions in this session."));
        return;
      }
      console.log("");
      console.log(chalk.bold("  Always-allow permissions:"));
      for (const item of items) console.log(chalk.gray(`    ${item}`));
      console.log(chalk.gray("  Use /permissions clear to clear them."));
    },
  },
  {
    name: "status",
    description: "Show session status (model, workspace, tokens, changes)",
    run: (_args, ctx) => {
      console.log("");
      console.log(chalk.bold("  Status:"));
      console.log(`    Session:     ${chalk.cyan(ctx.sessionId.slice(0, 8) + "...")}`);
      console.log(`    Provider:    ${chalk.cyan(ctx.modelConfig.provider)}`);
      console.log(`    Model:       ${chalk.cyan(ctx.modelConfig.model)}`);
      console.log(`    Workspace:   ${chalk.cyan(ctx.workspaceRoot)}`);
      if (ctx.permissionMode) {
        console.log(`    Permissions: ${chalk.cyan(ctx.permissionMode)}`);
      }
      console.log(`    Messages:    ${chalk.cyan(ctx.messages.length)}`);
      if (ctx.tools) {
        console.log(`    Tools:       ${chalk.cyan(ctx.tools.length)}`);
      }
      if (typeof ctx.mcpServerCount === "number") {
        console.log(`    MCP servers: ${chalk.cyan(ctx.mcpServerCount)}`);
      }
      if (ctx.stats) {
        console.log(
          `    Tokens:      ${chalk.cyan(ctx.stats.inputTokens)} in / ${chalk.cyan(ctx.stats.outputTokens)} out`,
        );
        console.log(`    Uptime:      ${chalk.cyan(formatDuration(ctx.stats.elapsedMs))}`);
      }
      const changes = listChanges(ctx.sessionId);
      console.log(`    Files changed:${chalk.cyan(" " + changes.length)}`);
    },
  },
  {
    name: "cost",
    description: "Show token usage and estimated cost this session",
    run: (_args, ctx) => {
      if (!ctx.stats) {
        console.log(chalk.gray("  No usage recorded yet this session."));
        return;
      }
      const s = ctx.stats;
      const cost = s.cost(ctx.modelConfig.model);
      console.log("");
      console.log(chalk.bold("  Cost:"));
      console.log(`    API calls:    ${chalk.cyan(s.apiCalls)}`);
      console.log(`    Tool calls:   ${chalk.cyan(s.toolCalls)}`);
      console.log(`    Input tokens: ${chalk.cyan(s.inputTokens.toLocaleString())}`);
      console.log(`    Output tokens:${chalk.cyan(" " + s.outputTokens.toLocaleString())}`);
      console.log(`    Total tokens: ${chalk.cyan(s.totalTokens.toLocaleString())}`);
      // 12.3: prompt-cache observability.
      const hit = s.cacheHitRate;
      if (hit !== null && (s.cacheReadTokens > 0 || s.cacheCreationTokens > 0)) {
        console.log(
          `    Cache:        ${chalk.cyan((hit * 100).toFixed(1) + "%")} hit ` +
            chalk.gray(`(${s.cacheReadTokens.toLocaleString()} read / ${s.cacheCreationTokens.toLocaleString()} written)`),
        );
      }
      if (cost === null) {
        console.log(
          chalk.gray(`    Est. cost:    unknown (no pricing for ${ctx.modelConfig.model})`),
        );
      } else {
        console.log(`    Est. cost:    ${chalk.green(formatUsd(cost))} ${chalk.gray("(approximate)")}`);
      }
    },
  },
  {
    name: "tools",
    description: "List loaded tools and their source (core / MCP)",
    run: (_args, ctx) => {
      if (!ctx.tools || ctx.tools.length === 0) {
        console.log(chalk.gray("  Tool list is not available."));
        return;
      }
      const core = ctx.tools.filter((t) => t.source === "core");
      const mcp = ctx.tools.filter((t) => t.source === "mcp");
      console.log("");
      console.log(chalk.bold(`  Tools (${ctx.tools.length}):`));
      const printOne = (tool: Tool) => {
        const ro = tool.isReadOnly() ? chalk.green("read-only") : chalk.yellow("mutating");
        console.log(`    ${chalk.cyan(tool.name.padEnd(16))} ${ro}  ${chalk.gray(tool.description)}`);
      };
      console.log(chalk.dim("  core:"));
      for (const t of core) printOne(t.tool);
      if (mcp.length > 0) {
        console.log(chalk.dim("  mcp:"));
        for (const t of mcp) printOne(t.tool);
      }
    },
  },
  {
    name: "context",
    description: "Show context composition and approximate token usage",
    run: (_args, ctx) => {
      // ~4 chars per token is a rough heuristic shared with the spinner.
      const estTokens = (text: string) => Math.round(text.length / 4);

      let sysTokens = ctx.systemPrompt ? estTokens(ctx.systemPrompt) : 0;
      let userTokens = 0;
      let assistantTokens = 0;
      let toolTokens = 0;

      for (const m of ctx.messages) {
        if (m.role === "user") {
          for (const block of m.content) {
            if (block.type === "text") userTokens += estTokens(block.text);
          }
        } else if (m.role === "assistant") {
          if (typeof m.content === "string") assistantTokens += estTokens(m.content);
          for (const tc of m.tool_calls ?? []) {
            assistantTokens += estTokens(tc.function.arguments);
          }
        } else if (m.role === "tool") {
          toolTokens += estTokens(m.content);
        } else if (m.role === "system") {
          sysTokens += estTokens(m.content);
        }
      }

      const total = sysTokens + userTokens + assistantTokens + toolTokens;
      const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "0%");

      console.log("");
      console.log(chalk.bold("  Context (estimated tokens):"));
      console.log(`    System prompt: ${chalk.cyan(sysTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(sysTokens))}`);
      console.log(`    User msgs:     ${chalk.cyan(userTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(userTokens))}`);
      console.log(`    Assistant:     ${chalk.cyan(assistantTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(assistantTokens))}`);
      console.log(`    Tool results:  ${chalk.cyan(toolTokens.toLocaleString().padStart(8))}  ${chalk.gray(pct(toolTokens))}`);
      console.log(`    ${chalk.bold("Total:")}         ${chalk.cyan(total.toLocaleString().padStart(8))}`);
      console.log(chalk.gray(`    (~4 chars/token heuristic; ${ctx.messages.length} messages)`));
    },
  },
  {
    name: "config",
    description: "Show the active runtime configuration",
    run: (_args, ctx) => {
      const c = ctx.modelConfig;
      console.log("");
      console.log(chalk.bold("  Config:"));
      console.log(`    Provider:    ${chalk.cyan(c.provider)}`);
      console.log(`    Model:       ${chalk.cyan(c.model)}`);
      console.log(`    Base URL:    ${chalk.cyan(c.baseURL ?? "(provider default)")}`);
      console.log(`    Max tokens:  ${chalk.cyan(c.maxTokens ?? "(default)")}`);
      console.log(`    Temperature: ${chalk.cyan(c.temperature ?? "(default)")}`);
      console.log(`    Workspace:   ${chalk.cyan(ctx.workspaceRoot)}`);
      if (ctx.permissionMode) {
        console.log(`    Permissions: ${chalk.cyan(ctx.permissionMode)}`);
      }
      console.log(chalk.gray("  Use /model <id> to switch model for this session."));
    },
  },
  {
    name: "diff",
    description: "Show files changed during this session",
    run: (_args, ctx) => {
      const changes = listChanges(ctx.sessionId);
      if (changes.length === 0) {
        console.log(chalk.gray("  No files changed this session."));
        return;
      }
      console.log("");
      console.log(chalk.bold(`  Files changed (${changes.length}):`));
      for (const ch of changes) {
        const tag =
          ch.kind === "created" ? chalk.green("created ") : chalk.yellow("modified");
        const times = ch.edits > 1 ? chalk.gray(` ×${ch.edits}`) : "";
        console.log(`    ${tag} ${chalk.cyan(ch.path)}${times}`);
      }
    },
  },
  {
    name: "memory",
    description: "View or append to CLAUDE.md (/memory, /memory add <text>)",
    run: (args, ctx) => {
      const claudeMdPath = path.join(ctx.workspaceRoot, "CLAUDE.md");
      const trimmed = args.trim();

      // /memory add <text> — append a bullet to CLAUDE.md.
      if (trimmed.toLowerCase().startsWith("add ")) {
        const note = trimmed.slice(4).trim();
        if (!note) {
          console.log(chalk.yellow("  Usage: /memory add <text>"));
          return;
        }
        try {
          const exists = fs.existsSync(claudeMdPath);
          const prefix = exists && fs.readFileSync(claudeMdPath, "utf-8").endsWith("\n") ? "" : "\n";
          fs.appendFileSync(claudeMdPath, `${prefix}- ${note}\n`, "utf-8");
          console.log(chalk.gray(`  Appended to CLAUDE.md: "${note}"`));
          console.log(chalk.gray("  (Restart the session to load it into the system prompt.)"));
        } catch (e: any) {
          console.log(chalk.red(`  Could not write CLAUDE.md: ${e.message}`));
        }
        return;
      }

      // /memory — show current CLAUDE.md.
      try {
        const content = fs.readFileSync(claudeMdPath, "utf-8");
        console.log("");
        console.log(chalk.bold(`  CLAUDE.md (${claudeMdPath}):`));
        console.log("");
        for (const line of content.split("\n")) console.log(`  ${chalk.gray(line)}`);
      } catch {
        console.log(chalk.gray("  No CLAUDE.md found. Use /init to create one, or /memory add <text>."));
      }
    },
  },
  {
    name: "init",
    description: "Generate a starter CLAUDE.md by scanning the workspace",
    run: (args, ctx) => {
      const claudeMdPath = path.join(ctx.workspaceRoot, "CLAUDE.md");
      const force = args.trim().toLowerCase() === "force";
      if (fs.existsSync(claudeMdPath) && !force) {
        console.log(chalk.yellow("  CLAUDE.md already exists. Use /init force to overwrite."));
        return;
      }
      const scaffold = buildClaudeMdScaffold(ctx.workspaceRoot);
      try {
        fs.writeFileSync(claudeMdPath, scaffold, "utf-8");
        console.log(chalk.gray(`  Wrote starter CLAUDE.md (${scaffold.length} bytes).`));
        console.log(chalk.gray("  Edit it to capture project context, then restart to load it."));
      } catch (e: any) {
        console.log(chalk.red(`  Could not write CLAUDE.md: ${e.message}`));
      }
    },
  },
];

const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.name, c]));

/**
 * Scan a workspace and produce a starter CLAUDE.md. Best-effort: detects a
 * package.json (name, scripts), common config files, and the top-level
 * directory layout. The user is expected to refine it.
 */
function buildClaudeMdScaffold(workspaceRoot: string): string {
  const name = path.basename(path.resolve(workspaceRoot));
  const lines: string[] = [`# ${name}`, ""];

  // package.json — project name, description, scripts.
  let pkg: any = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf-8"));
  } catch {
    /* no package.json */
  }
  if (pkg) {
    lines.push("## Project Overview", "");
    if (pkg.description) lines.push(pkg.description, "");
    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
      lines.push("## Commands", "");
      for (const [k, v] of Object.entries(pkg.scripts)) {
        lines.push(`- \`npm run ${k}\` — ${String(v)}`);
      }
      lines.push("");
    }
  } else {
    lines.push("## Project Overview", "", "<!-- Describe what this project does. -->", "");
  }

  // Detected tooling / config files.
  const configs = [
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "Makefile",
    ".eslintrc",
    ".prettierrc",
  ];
  const found = configs.filter((f) => fs.existsSync(path.join(workspaceRoot, f)));
  if (found.length > 0) {
    lines.push("## Tooling", "", ...found.map((f) => `- ${f}`), "");
  }

  // Top-level layout (dirs only, skip noise).
  try {
    const skip = new Set(["node_modules", ".git", "dist", "build", ".cache"]);
    const dirs = fs
      .readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !skip.has(d.name) && !d.name.startsWith("."))
      .map((d) => d.name)
      .slice(0, 20);
    if (dirs.length > 0) {
      lines.push("## Structure", "", ...dirs.map((d) => `- \`${d}/\``), "");
    }
  } catch {
    /* ignore */
  }

  lines.push(
    "## Conventions",
    "",
    "<!-- Capture coding conventions, patterns, and constraints the assistant should follow. -->",
    "",
  );

  return lines.join("\n");
}


/**
 * Handle a line of input if it is a slash command.
 * Returns handled=false for normal text so the caller sends it to the LLM.
 */
export async function handleSlashCommand(
  input: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (!input.startsWith("/")) return { handled: false };

  const [rawName, ...rest] = input.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const args = input.slice(1 + rawName.length).trim();
  const cmd = COMMAND_MAP.get(name);

  if (!cmd) {
    console.log(chalk.yellow(`  Unknown command: /${name}. Try /help.`));
    return { handled: true };
  }

  await cmd.run(args, ctx);
  return { handled: true };
}

export { COMMANDS };
