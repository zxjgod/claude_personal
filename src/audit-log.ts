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
  logFilePath?: string; // Default: ~/.claude-code-replica/audit.log; "" disables file logging
  maxEntries?: number; // Default: 10000
  includeReadOperations?: boolean; // Default: false
}

/**
 * Resolve the default audit path. CCR_AUDIT_LOG overrides (tests/multi-profile).
 * When neither HOME nor USERPROFILE exists the log is DISABLED ("") rather
 * than falling back to "." — an audit trail silently landing in whatever cwd
 * the CLI was started from is both discoverable and surprising (Top10
 * follow-up A8).
 */
function defaultAuditPath(): string {
  if (process.env.CCR_AUDIT_LOG) return process.env.CCR_AUDIT_LOG;
  const home = process.env.HOME || process.env.USERPROFILE;
  return home ? path.join(home, ".claude-code-replica", "audit.log") : "";
}

const DEFAULT_OPTIONS: Required<AuditLogOptions> = {
  logFilePath: defaultAuditPath(),
  maxEntries: 10000,
  includeReadOperations: false,
};

// --- Secret redaction (Top10 follow-up A8) ---
// Audit entries quote raw commands and paths; a command like
// `curl -H "Authorization: Bearer sk-…" ` or `export API_KEY=…` would
// otherwise persist the secret in plaintext forever. Best-effort pattern
// scrubbing before anything is written.
const SECRET_PATTERNS: Array<{ re: RegExp; to: string }> = [
  // Bearer FIRST: it swallows the whole credential, so a contained sk-/ghp_
  // token doesn't get half-redacted into "Bearer sk-<redacted>" first.
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: "Bearer <redacted>" },
  // Basic auth carries base64("user:password") — a full credential with no
  // keyword for the value-patterns to catch (fourth-round review).
  { re: /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, to: "Basic <redacted>" },
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, to: "sk-<redacted>" },
  { re: /\bAKIA[0-9A-Z]{12,}\b/g, to: "<redacted-aws-key>" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, to: "<redacted-github-token>" },
  { re: /\bglpat-[A-Za-z0-9_-]{10,}\b/g, to: "<redacted-gitlab-token>" },
  // curl/wget basic auth: `-u user:password` (password part may be empty for
  // prompt-based auth; redact whatever shape follows the colon).
  { re: /(^|[\s"'])-u\s+\S+:\S+/gi, to: "$1-u <redacted>" },
  {
    re: /((?:api[_-]?key|apikey|secret|token|passw(?:or)?d|credential)["']?\s*[:=]\s*)["']?[^\s"',;&|]+/gi,
    to: "$1<redacted>",
  },
];

/** Scrub secret-shaped substrings from a value destined for the audit log. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, to } of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

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

    // File logging disabled (no HOME and no CCR_AUDIT_LOG): entries stay
    // queryable in memory only.
    if (!this.options.logFilePath) {
      this.entries = [];
      this.persistedCount = 0;
      this.initialized = true;
      return;
    }

    // Ensure directory exists (0700: the audit trail quotes commands).
    const dir = path.dirname(this.options.logFilePath);
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
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
    if (!this.options.logFilePath) {
      // Memory-only mode: keep counters consistent so nothing re-persists
      // if a path shows up later via explicit options.
      this.persistedCount = this.entries.length;
      this.needsFullRewrite = false;
      return;
    }
    try {
      if (this.needsFullRewrite || this.persistedCount > this.entries.length) {
        // A trim shifted the in-memory window; the on-disk file no longer
        // corresponds to any suffix of it, so rewrite wholesale (bounded by
        // maxEntries, so this stays cheap) instead of appending.
        // Snapshot + boundary BEFORE the await (self-review fix — same bug
        // the append branch had): entries pushed by a concurrent log()
        // DURING the rewrite must stay beyond the boundary, or they get
        // marked persisted without being in the written snapshot.
        const snapshot = this.entries.slice();
        const boundary = snapshot.length;
        const lines = snapshot.map((e) => JSON.stringify(e)).join("\n") + "\n";
        await fs.promises.writeFile(this.options.logFilePath, lines, { mode: 0o600 });
        this.persistedCount = boundary;
      } else {
        // Normal path: append only the entries written since the last persist.
        // Snapshot BOTH the delta and the resulting boundary BEFORE awaiting
        // the write (review fix "并发写期间新条目被误标为已持久化"): the old
        // code re-read this.entries.length after the await, so an entry pushed
        // by a concurrent log() DURING the write was counted as persisted and
        // its own persist later computed an empty delta — it never reached
        // disk. With the pre-captured boundary, that entry stays beyond
        // persistedCount and the next persist appends it.
        const fresh = this.entries.slice(this.persistedCount);
        if (fresh.length === 0) return;
        const newCount = this.persistedCount + fresh.length;
        const lines = fresh.map((e) => JSON.stringify(e)).join("\n") + "\n";
        await fs.promises.writeFile(this.options.logFilePath, lines, { flag: "a", mode: 0o600 });
        this.persistedCount = newCount;
      }
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
      // Redact secret-shaped substrings before anything touches memory/disk.
      ...(entry.command !== undefined ? { command: redactSecrets(entry.command) } : {}),
      ...(entry.filePath !== undefined ? { filePath: redactSecrets(entry.filePath) } : {}),
      ...(entry.errorMessage !== undefined
        ? { errorMessage: redactSecrets(entry.errorMessage) }
        : {}),
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

/**
 * Record a permission-policy change (Top10 follow-up A8): the
 * `permission_change` operation type existed but was NEVER written — the
 * audit trail had no record of "always allow" grants or /mode switches, the
 * two moments where the security posture actually changes.
 */
export async function logPermissionChange(params: {
  change: string;
  workspaceRoot: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const logger = getAuditLogger();
  await logger.log({
    operation: "permission_change",
    command: params.change,
    workspaceRoot: params.workspaceRoot,
    userConfirmed: true, // policy changes are always user-driven
    outcome: "success",
    sessionId: params.sessionId,
    metadata: params.metadata,
  });
}
