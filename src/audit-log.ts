// ============================================================
// Audit Log — Track all operations for security and debugging
// ============================================================
// Records destructive and security-sensitive operations to a persistent
// log file. Each entry includes timestamp, operation type, file path,
// user confirmation status, and operation outcome.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

export type OperationType =
  | "bash"
  | "edit"
  | "write"
  | "delete"
  | "permission_change"
  | "tool_execution"
  | "mcp_tool_call";

export type OperationOutcome = "success" | "denied" | "error" | "approved_not_executed";

export interface AuditEntry {
  timestamp: string; // ISO 8601 format
  operation: OperationType;
  toolName?: string;
  filePath?: string;
  command?: string; // For bash operations
  outcome: OperationOutcome;
  userConfirmed: boolean;
  workspaceRoot: string;
  sessionId?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogOptions {
  logFilePath?: string; // Default: ~/.claude-code-replica/audit.log
  maxEntries?: number; // Default: 10000
  includeReadOperations?: boolean; // Default: false
}

const DEFAULT_OPTIONS: Required<AuditLogOptions> = {
  // CCR_AUDIT_LOG overrides the path so tests (and multi-profile setups) can
  // keep audit output hermetic instead of always writing to the home dir.
  logFilePath:
    process.env.CCR_AUDIT_LOG ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".claude-code-replica",
      "audit.log",
    ),
  maxEntries: 10000,
  includeReadOperations: false,
};

export class AuditLogger {
  private options: Required<AuditLogOptions>;
  private entries: AuditEntry[] = [];
  private initialized = false;
  /**
   * How many in-memory entries are already on disk. persist() appends ONLY the
   * delta — the previous implementation re-appended the entire array on every
   * log() call (O(N²) duplicate lines, unbounded disk growth).
   */
  private persistedCount = 0;
  /** Set when entries were trimmed and the file no longer matches memory. */
  private needsFullRewrite = false;
  /** Serializes persist() calls so concurrent log()s can't double-append. */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: AuditLogOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    // Ensure directory exists
    const dir = path.dirname(this.options.logFilePath);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    // Load existing entries
    try {
      const content = await fs.promises.readFile(this.options.logFilePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      this.entries = lines
        .slice(-this.options.maxEntries)
        .map((line) => {
          try {
            return JSON.parse(line) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as AuditEntry[];
    } catch {
      // File doesn't exist yet, start fresh
      this.entries = [];
    }

    // Everything loaded from disk is by definition already persisted.
    this.persistedCount = this.entries.length;
    this.needsFullRewrite = false;
    this.initialized = true;
  }

  private async persist(): Promise<void> {
    try {
      if (this.needsFullRewrite || this.persistedCount > this.entries.length) {
        // A trim shifted the in-memory window; the on-disk file no longer
        // corresponds to any suffix of it, so rewrite wholesale (bounded by
        // maxEntries, so this stays cheap) instead of appending.
        const lines = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
        await fs.promises.writeFile(this.options.logFilePath, lines);
      } else {
        // Normal path: append only the entries written since the last persist.
        const fresh = this.entries.slice(this.persistedCount);
        if (fresh.length === 0) return;
        const lines = fresh.map((e) => JSON.stringify(e)).join("\n") + "\n";
        await fs.promises.writeFile(this.options.logFilePath, lines, { flag: "a" });
      }
      this.persistedCount = this.entries.length;
      this.needsFullRewrite = false;
    } catch (error) {
      console.error("Failed to persist audit log:", error);
    }
  }

  async log(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    await this.ensureInitialized();

    // Skip read operations unless explicitly configured. (The previous guard
    // also required `!entry.outcome`, which is impossible — outcome is a
    // required field — so the filter never matched anything.)
    if (!this.options.includeReadOperations) {
      if (entry.operation === "mcp_tool_call" && entry.metadata?.readonly) {
        return;
      }
    }

    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(fullEntry);

    // Trim if exceeds max
    if (this.entries.length > this.options.maxEntries) {
      this.entries = this.entries.slice(-this.options.maxEntries);
      this.needsFullRewrite = true;
    }

    // Persist via a serial chain: two back-to-back log() calls must not run
    // persist() concurrently, or both would compute their append delta from
    // the same stale persistedCount and duplicate lines. Awaiting the chain
    // here is safe — production callers fire-and-forget log() itself, and it
    // makes the write durable before tests/consumers read the file.
    this.persistChain = this.persistChain.then(() => this.persist());
    await this.persistChain;
  }

  async query(filter?: {
    operation?: OperationType;
    outcome?: OperationOutcome;
    since?: Date;
    until?: Date;
    filePath?: string;
  }): Promise<AuditEntry[]> {
    await this.ensureInitialized();

    return this.entries.filter((entry) => {
      if (filter?.operation && entry.operation !== filter.operation) return false;
      if (filter?.outcome && entry.outcome !== filter.outcome) return false;
      if (filter?.filePath && entry.filePath !== filter.filePath) return false;
      if (filter?.since) {
        const entryTime = new Date(entry.timestamp);
        if (entryTime < filter.since) return false;
      }
      if (filter?.until) {
        const entryTime = new Date(entry.timestamp);
        if (entryTime > filter.until) return false;
      }
      return true;
    });
  }

  async getRecent(count = 10): Promise<AuditEntry[]> {
    await this.ensureInitialized();
    return this.entries.slice(-count).reverse();
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.persistedCount = 0;
    this.needsFullRewrite = false;
    try {
      await fs.promises.unlink(this.options.logFilePath);
    } catch {
      // File may not exist
    }
  }
}

// Singleton instance
let auditLogger: AuditLogger | null = null;

export function getAuditLogger(options?: AuditLogOptions): AuditLogger {
  if (!auditLogger) {
    auditLogger = new AuditLogger(options);
  }
  return auditLogger;
}

// Convenience functions for logging specific operations
export async function logBashOperation(params: {
  command: string;
  workspaceRoot: string;
  userConfirmed: boolean;
  outcome: OperationOutcome;
  sessionId?: string;
  errorMessage?: string;
}): Promise<void> {
  const logger = getAuditLogger();
  await logger.log({
    operation: "bash",
    command: params.command,
    workspaceRoot: params.workspaceRoot,
    userConfirmed: params.userConfirmed,
    outcome: params.outcome,
    sessionId: params.sessionId,
    errorMessage: params.errorMessage,
  });
}

export async function logFileOperation(params: {
  operation: "edit" | "write" | "delete";
  filePath: string;
  workspaceRoot: string;
  userConfirmed: boolean;
  outcome: OperationOutcome;
  sessionId?: string;
  errorMessage?: string;
}): Promise<void> {
  const logger = getAuditLogger();
  await logger.log({
    operation: params.operation,
    filePath: params.filePath,
    workspaceRoot: params.workspaceRoot,
    userConfirmed: params.userConfirmed,
    outcome: params.outcome,
    sessionId: params.sessionId,
    errorMessage: params.errorMessage,
  });
}

export async function logToolExecution(params: {
  toolName: string;
  workspaceRoot: string;
  userConfirmed: boolean;
  outcome: OperationOutcome;
  sessionId?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const logger = getAuditLogger();
  await logger.log({
    operation: "tool_execution",
    toolName: params.toolName,
    workspaceRoot: params.workspaceRoot,
    userConfirmed: params.userConfirmed,
    outcome: params.outcome,
    sessionId: params.sessionId,
    errorMessage: params.errorMessage,
    metadata: params.metadata,
  });
}
