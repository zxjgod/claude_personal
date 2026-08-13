// ============================================================
// LSP — real long-lived language server connection (M14.5)
// ============================================================
// Replaces the lightweight `tsc --noEmit` shell-out with a long-lived
// JSON-RPC connection to `tsserver` over stdio. tsserver does NOT speak
// the editor LSP protocol directly — it speaks its own TS-server JSON
// protocol on a `Content-Length: N\r\n\r\n<json>` framing where N is the
// byte length of the JSON body PLUS ONE (tsserver appends a trailing
// newline). This module implements that wire format directly so no extra
// npm dependency (vscode-languageserver-node) is needed.
//
// The public Diagnostic shape stays identical to the original lsp.ts so
// the LspDiagnostics tool's output format is unchanged. One reusable
// tsserver process per workspace, with a teardown hook for the CLI.
// ============================================================

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface CompletionItem {
  name: string;
  kind: string;
  insertText?: string;
}

/** Re-export the old pure helpers so existing callers/tests keep working. */
export { filterByFile, formatDiagnostics, parseTscOutput } from "./lsp-legacy.js";

const require = createRequire(import.meta.url);

/** Resolve the tsserver.js entrypoint from the bundled `typescript` dep. */
function resolveTsserverPath(): string | null {
  try {
    return require.resolve("typescript/lib/tsserver.js");
  } catch {
    return null;
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface TsDiagnostic {
  file?: string;
  start?: { line: number; offset: number };
  end?: { line: number; offset: number };
  text?: string;
  code?: number;
  category?: string;
}

/**
 * A minimal TS-server JSON-RPC (over stdio) client for tsserver. One
 * instance per workspace root; reuse across requests so the server stays
 * warm. Diagnostics are fetched synchronously via the
 * syntacticDiagnosticsSync / semanticDiagnosticsSync requests.
 */
export class LspClient {
  private proc: ChildProcess | null = null;
  private nextSeq = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private rootPath: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly tsserverPath: string,
  ) {
    this.rootPath = path.resolve(workspaceRoot);
  }

  /** Spawn (once) and confirm the server is responding. */
  async ensureInitialized(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(process.execPath, [this.tsserverPath, "--stdio"], {
          cwd: this.workspaceRoot,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e: any) {
        reject(new Error(`Failed to spawn tsserver: ${e.message}`));
        return;
      }

      const onErr = (err: Error) => {
        if (!this.ready) reject(err);
      };
      this.proc.on("error", onErr);
      this.proc.on("exit", (code) => {
        if (!this.ready) {
          reject(new Error(`tsserver exited before ready (code ${code})`));
        }
      });

      this.proc.stdout!.setEncoding("utf-8");
      this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));

      // `configure` primes the server (host settings). A round-trip confirms
      // the protocol is alive before we declare ready.
      this.request("configure", {
        hostInfo: "claude-code-replica",
        preferences: { providePrefixAndSuffixTextForRename: true },
      })
        .then(() => {
          this.ready = true;
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Open a file and fetch syntactic + semantic diagnostics for it. The
   * diagnostic shape is normalized to the shared Diagnostic interface.
   */
  async getDiagnostics(filePath: string, timeoutMs = 20000): Promise<Diagnostic[]> {
    await this.ensureInitialized();
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(this.rootPath, filePath);
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";

    // open is a notification (no response required) but tsserver still acks.
    await this.request("open", {
      file: abs,
      fileContent: text,
      scriptKindName: abs.endsWith(".tsx") ? "TSX" : abs.endsWith(".ts") ? "TS" : "JS",
    }).catch(() => undefined);

    const [syntactic, semantic] = await Promise.all([
      this.request("syntacticDiagnosticsSync", { file: abs }),
      this.request("semanticDiagnosticsSync", { file: abs }),
    ]);

    const out: Diagnostic[] = [];
    for (const d of [...asDiags(syntactic), ...asDiags(semantic)]) {
      out.push(toDiagnostic(abs, d));
    }
    return out;
  }

  /**
   * Fetch code completions at a cursor position. tsserver's `completionInfo`
   * request takes 1-based `line` and 1-based `offset` (column), matching the
   * Diagnostic coordinate convention. Returns up to 50 items.
   */
  async getCompletions(
    filePath: string,
    line: number,
    column: number,
    timeoutMs = 15000,
  ): Promise<CompletionItem[]> {
    await this.ensureInitialized();
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(this.rootPath, filePath);
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
    const scriptKindName = abs.endsWith(".tsx") ? "TSX" : abs.endsWith(".ts") ? "TS" : "JS";

    await this.request("open", { file: abs, fileContent: text, scriptKindName }).catch(
      () => undefined,
    );

    const body = await this.request("completionInfo", {
      file: abs,
      line,
      offset: column,
      includeExternalModuleExports: true,
      includeInsertTextCompletions: true,
    });

    const entries = (body as { entries?: unknown[] })?.entries ?? [];
    const out: CompletionItem[] = [];
    for (const e of entries) {
      if (out.length >= 50) break;
      const entry = e as { name?: string; kind?: string; insertText?: string } | null;
      if (!entry || typeof entry.name !== "string") continue;
      out.push({
        name: entry.name,
        kind: entry.kind ?? "",
        insertText: typeof entry.insertText === "string" ? entry.insertText : undefined,
      });
    }
    return out;
  }

  // --- TS-server JSON-RPC plumbing -----------------------------------------

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const msg = this.extractMessage();
      if (!msg) break;
      this.handleMessage(msg);
    }
  }

  /**
   * Extract one framed message. tsserver frames with
   * `Content-Length: N\r\n\r\n<json>\n` where N = byteLength(json) + 1.
   * We parse the header for the length, then read that many body bytes.
   */
  private extractMessage(): any | null {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const header = this.buffer.slice(0, headerEnd);
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      this.buffer = this.buffer.slice(headerEnd + 4);
      return null;
    }
    const len = parseInt(m[1]!, 10);
    const bodyStart = headerEnd + 4;
    if (Buffer.byteLength(this.buffer, "utf-8") < bodyStart + len) return null;
    // Slice by byte length, not character length, to handle multibyte.
    const bodyBuf = Buffer.from(this.buffer, "utf-8").subarray(bodyStart, bodyStart + len);
    this.buffer = this.buffer.slice(bodyStart + bodyBuf.toString("utf-8").length);
    try {
      return JSON.parse(bodyBuf.toString("utf-8"));
    } catch {
      return null;
    }
  }

  private handleMessage(msg: any): void {
    // Responses carry `seq`/`request_seq` and `success`/`body`.
    if (msg.type === "response") {
      const pending = this.pending.get(msg.request_seq);
      if (pending) {
        this.pending.delete(msg.request_seq);
        if (msg.success === false) {
          pending.reject(new Error(msg.message ?? "tsserver error"));
        } else {
          pending.resolve(msg.body);
        }
      }
      return;
    }
    // Events (type === "event") are ignored here; diagnostics are pulled
    // synchronously via the *DiagnosticsSync requests, not pushed.
  }

  private request(command: string, argumentsObj: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const seq = this.nextSeq++;
      // Safety timeout so a hung request doesn't pin the caller forever.
      const timer = setTimeout(() => {
        if (this.pending.delete(seq)) {
          reject(new Error(`tsserver "${command}" timed out`));
        }
      }, 25000);
      this.pending.set(seq, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err: unknown) => {
          clearTimeout(timer);
          reject(err as Error);
        },
      });
      this.writeMessage({ seq, type: "request", command, arguments: argumentsObj });
    });
  }

  private writeMessage(msg: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    const body = JSON.stringify(msg);
    // tsserver expects Content-Length = byteLength(json) + 1 (it appends a
    // trailing newline to the body it reads back).
    const len = Buffer.byteLength(body, "utf-8") + 1;
    this.proc.stdin.write(`Content-Length: ${len}\r\n\r\n${body}\n`);
  }

  /** Shutdown the server cleanly. Idempotent. */
  async dispose(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.request("exit", null).catch(() => undefined);
    } finally {
      this.proc.kill();
      this.proc = null;
      this.pending.clear();
      this.ready = false;
    }
  }
}

function asDiags(body: unknown): TsDiagnostic[] {
  if (!Array.isArray(body)) return [];
  return body as TsDiagnostic[];
}

function toDiagnostic(filePath: string, d: TsDiagnostic): Diagnostic {
  const start = d.start ?? { line: 1, offset: 1 };
  const category = (d.category ?? "error").toLowerCase();
  return {
    file: d.file ?? filePath,
    line: start.line,
    column: start.offset,
    severity: category === "warning" ? "warning" : "error",
    code: "TS" + (d.code ?? 0),
    message: d.text ?? "diagnostic",
  };
}

// --- connection cache -------------------------------------------------------

const CLIENTS = new Map<string, LspClient>();

/**
 * Get (or lazily create) the shared LSP client for a workspace root.
 * Returns null if tsserver can't be resolved (caller falls back to tsc).
 */
export function getLspClient(workspaceRoot: string): LspClient | null {
  const key = path.resolve(workspaceRoot).toLowerCase();
  let client = CLIENTS.get(key);
  if (!client) {
    const tsserverPath = resolveTsserverPath();
    if (!tsserverPath) return null;
    client = new LspClient(workspaceRoot, tsserverPath);
    CLIENTS.set(key, client);
  }
  return client;
}

/** Dispose all cached clients (CLI shutdown hook). */
export async function disposeAllLspClients(): Promise<void> {
  const all = [...CLIENTS.values()];
  CLIENTS.clear();
  await Promise.all(all.map((c) => c.dispose()));
}

/** Test/util: drop the cached client for a workspace without disposing. */
export function clearLspClientCache(workspaceRoot: string): void {
  CLIENTS.delete(path.resolve(workspaceRoot).toLowerCase());
}
