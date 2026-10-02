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
import fg from "fast-glob";
import { disposeLanguageServers } from "./language-servers.js";
import { resolveAllowedWorkspaceFile } from "./tools/utils/path.js";

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

/** Framed JSON-RPC message received from tsserver (the response fields we read). */
interface TsServerMessage {
  type: string;
  request_seq: number;
  success?: boolean;
  message?: string;
  body?: unknown;
  /** Event messages only (type === "event"): the event name. */
  event?: string;
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
    if (this.ready && this.proc && this.proc.exitCode === null && !this.proc.killed) return;
    if (this.ready) await this.dispose();
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  private initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(process.execPath, [this.tsserverPath, "--stdio"], {
          cwd: this.workspaceRoot,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        reject(new Error(`Failed to spawn tsserver: ${detail}`));
        return;
      }

      const onErr = (err: Error) => {
        if (this.proc !== child) return;
        if (!this.ready) reject(err);
        for (const request of this.pending.values()) request.reject(err);
        this.pending.clear();
        this.ready = false;
        void this.dispose();
      };
      const child = this.proc;
      this.proc.on("error", onErr);
      this.proc.stdin?.on("error", onErr);
      this.proc.stderr?.resume();
      this.proc.on("exit", (code) => {
        if (this.proc !== child) return;
        if (!this.ready) {
          reject(new Error(`tsserver exited before ready (code ${code})`));
        }
        this.ready = false;
        this.proc = null;
        this.initPromise = null;
        this.buffer = "";
        for (const request of this.pending.values())
          request.reject(new Error(`tsserver exited (code ${code})`));
        this.pending.clear();
      });

      this.proc.stdout!.setEncoding("utf-8");
      this.proc.stdout!.on("data", (chunk: string) => {
        if (this.proc === child) this.onData(chunk);
      });

      // `configure` primes the server (host settings). A round-trip confirms
      // the protocol is alive before we declare ready.
      this.request("configure", {
        hostInfo: "claude-code-replica",
        preferences: { providePrefixAndSuffixTextForRename: true },
      })
        .then(() => {
          if (this.proc !== child || child.exitCode !== null) {
            reject(new Error("tsserver exited during initialization"));
            return;
          }
          this.ready = true;
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Open a file and fetch syntactic + semantic diagnostics for it. The
   * diagnostic shape is normalized to the shared Diagnostic interface.
   * timeoutMs bounds each underlying tsserver request.
   */
  async getDiagnostics(filePath: string, timeoutMs = 20000): Promise<Diagnostic[]> {
    const resolution = resolveAllowedWorkspaceFile(filePath, this.rootPath);
    if (!resolution.ok) throw new Error(resolution.error);
    const abs = resolution.path;
    await this.ensureInitialized();
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";

    // open is a notification (no response required) but tsserver still acks.
    await this.request(
      "open",
      {
        file: abs,
        fileContent: text,
        scriptKindName: abs.endsWith(".tsx") ? "TSX" : abs.endsWith(".ts") ? "TS" : "JS",
      },
      timeoutMs,
    ).catch(() => undefined);

    const [syntactic, semantic] = await Promise.all([
      this.request("syntacticDiagnosticsSync", { file: abs }, timeoutMs),
      this.request("semanticDiagnosticsSync", { file: abs }, timeoutMs),
    ]);

    const out: Diagnostic[] = [];
    for (const d of [...asDiags(syntactic), ...asDiags(semantic)]) {
      out.push(toDiagnostic(abs, d));
    }
    return out;
  }
  async navigate(
    operation: string,
    filePath: string,
    line: number,
    column: number,
  ): Promise<unknown> {
    const resolution = resolveAllowedWorkspaceFile(filePath, this.rootPath);
    if (!resolution.ok) throw new Error(resolution.error);
    if (operation === "diagnostics") return this.getDiagnostics(resolution.path);
    await this.ensureInitialized();
    await this.request("open", {
      file: resolution.path,
      fileContent: fs.readFileSync(resolution.path, "utf8"),
    }).catch(() => undefined);
    const commands: Record<string, string> = {
      definition: "definition",
      references: "references",
      hover: "quickinfo",
      symbols: "navtree",
    };
    return this.request(commands[operation]!, { file: resolution.path, line, offset: column });
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
    const resolution = resolveAllowedWorkspaceFile(filePath, this.rootPath);
    if (!resolution.ok) throw new Error(resolution.error);
    const abs = resolution.path;
    await this.ensureInitialized();
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
    const scriptKindName = abs.endsWith(".tsx") ? "TSX" : abs.endsWith(".ts") ? "TS" : "JS";

    await this.request("open", { file: abs, fileContent: text, scriptKindName }, timeoutMs).catch(
      () => undefined,
    );

    const body = await this.request(
      "completionInfo",
      {
        file: abs,
        line,
        offset: column,
        includeExternalModuleExports: true,
        includeInsertTextCompletions: true,
      },
      timeoutMs,
    );

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

  // --- S4: project-wide diagnostics via tsserver's geterrForProject ---------
  // geterrForProject asks tsserver to compute diagnostics for every file in
  // the project (anchored at one file) and push them as syntaxDiag/
  // semanticDiag EVENTS, closing with a requestCompleted event. It sends NO
  // response frame (the server handler returns `notRequired`), so awaiting
  // the request promise would block until the safety timeout even on success
  // — completion is signaled by requestCompleted alone. The fields below
  // collect exactly one in-flight sweep; sweeps are serialized on
  // projectDiagChain so this shared state stays safe under the tool's
  // isConcurrencySafe advertisement.
  private projectDiagEvents: Diagnostic[] = [];
  private projectDiagWaiter: { seq: number; resolve: () => void } | null = null;
  private projectDiagChain: Promise<void> = Promise.resolve();

  /**
   * Whole-project diagnostics on the persistent tsserver connection (S4) —
   * replaces a cold `npx tsc --noEmit` per tool call. Uses tsserver's
   * `geterrForProject`: one request anchored at a file of the configured
   * project sweeps the ENTIRE project (the server enumerates it), pushing
   * syntaxDiag/semanticDiag events and closing with a requestCompleted
   * event. The first sweep pays the project-graph build; later sweeps are
   * incremental. A hard deadline returns whatever diagnostics landed by
   * then; a request the server rejects THROWS so the caller can fall back
   * to tsc instead of reporting a false "no diagnostics".
   */
  async getProjectDiagnostics(maxFiles = 500, timeoutMs = 60_000): Promise<Diagnostic[]> {
    const run = this.projectDiagChain.then(
      () => this.runProjectDiagnostics(maxFiles, timeoutMs),
      () => this.runProjectDiagnostics(maxFiles, timeoutMs),
    );
    // Keep the chain alive regardless of this sweep's outcome.
    this.projectDiagChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runProjectDiagnostics(maxFiles: number, timeoutMs: number): Promise<Diagnostic[]> {
    await this.ensureInitialized();
    const files = listProjectScriptFiles(this.rootPath, maxFiles);
    if (files.length === 0) return [];
    // The anchor MUST belong to the configured project: tsserver resolves
    // geterrForProject from the anchor, and a file outside every tsconfig
    // lands in an *inferred* project — the real project would never be
    // swept while the call still reports a clean result.
    const anchor = pickProjectAnchor(this.rootPath, files);

    // tsserver resolves the project from the anchor; opening it first makes
    // the default-project inference deterministic.
    const text = fs.existsSync(anchor) ? fs.readFileSync(anchor, "utf-8") : "";
    const scriptKindName = anchor.endsWith(".tsx") ? "TSX" : anchor.endsWith(".ts") ? "TS" : "JS";
    await this.request("open", { file: anchor, fileContent: text, scriptKindName }, 10_000).catch(
      () => undefined,
    );

    this.projectDiagEvents = [];
    // Holder object: TS narrowing cannot see assignments made inside the
    // request callbacks below, so a plain `let` would be narrowed to null.
    const sweep = { completed: false, error: null as Error | null };
    let signalDone!: () => void;
    const done = new Promise<void>((resolve) => {
      signalDone = resolve;
    });
    const deadline = setTimeout(() => {
      this.projectDiagWaiter = null;
      signalDone();
    }, timeoutMs);
    try {
      // Fire-and-track, NOT await: the request promise can only settle via
      // an error response or the safety timeout (no success frame exists).
      // requestCompleted resolving the waiter is the normal completion path.
      this.request("geterrForProject", { file: anchor, delay: 0 }, timeoutMs, (seq) => {
        this.projectDiagWaiter = {
          seq,
          resolve: () => {
            sweep.completed = true;
            signalDone();
          },
        };
      }).then(
        () => {
          // A response frame is unexpected, but authoritative if it arrives.
          sweep.completed = true;
          signalDone();
        },
        (err: unknown) => {
          sweep.error = err instanceof Error ? err : new Error(String(err));
          signalDone();
        },
      );
      await done;
    } finally {
      clearTimeout(deadline);
      this.projectDiagWaiter = null;
    }
    if (!sweep.completed && sweep.error) {
      // The sweep never ran (rejected/unknown command) — surface it so the
      // tool falls through to the `npx tsc` fallback.
      throw new Error(`tsserver project sweep failed: ${sweep.error.message}`);
    }
    const out = this.projectDiagEvents;
    this.projectDiagEvents = [];
    // Deadline path: return whatever landed (documented partial behavior).
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
  private extractMessage(): TsServerMessage | null {
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

  private handleMessage(msg: TsServerMessage): void {
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
    // Events (type === "event"). Diag events are only consumed while a
    // getProjectDiagnostics sweep is in flight (see projectDiagWaiter); other
    // events stay ignored — single-file diagnostics use the *Sync requests.
    if (msg.type === "event") {
      if (msg.event === "syntaxDiag" || msg.event === "semanticDiag") {
        // Gate on the waiter: events arriving after the deadline (the
        // server-side sweep keeps running) must not leak into the next
        // sweep's collection.
        const body = msg.body as { file?: string; diagnostics?: TsDiagnostic[] } | undefined;
        if (body?.file && this.projectDiagWaiter) {
          for (const d of asDiags(body.diagnostics ?? [])) {
            this.projectDiagEvents.push(toDiagnostic(body.file, d));
          }
        }
      } else if (msg.event === "requestCompleted") {
        const seq = (msg.body as { request_seq?: number } | undefined)?.request_seq;
        if (seq !== undefined) {
          const request = this.pending.get(seq);
          if (request) {
            this.pending.delete(seq);
            request.resolve(undefined);
          }
        }
        if (seq !== undefined && this.projectDiagWaiter?.seq === seq) {
          const waiter = this.projectDiagWaiter;
          this.projectDiagWaiter = null;
          waiter.resolve();
        }
      }
    }
  }

  private request(
    command: string,
    argumentsObj: unknown,
    timeoutMs = 25000,
    sent?: (seq: number) => void,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable || this.proc.exitCode !== null || this.proc.killed) {
        reject(new Error("tsserver is not running"));
        return;
      }
      const seq = this.nextSeq++;
      sent?.(seq);
      // Safety timeout so a hung request doesn't pin the caller forever.
      const timer = setTimeout(() => {
        if (this.pending.delete(seq)) {
          reject(new Error(`tsserver "${command}" timed out`));
          if (command !== "geterrForProject") void this.dispose();
        }
      }, timeoutMs);
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
    if (!this.proc) {
      this.ready = false;
      this.initPromise = null;
      return;
    }
    const proc = this.proc;
    // tsserver exits without acknowledging this command. Wait for process
    // closure with a short bound instead of a request that always times out.
    const closed = new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        proc.removeListener("close", finish);
        resolve();
      };
      timer = setTimeout(() => {
        proc.kill();
        finish();
      }, 1000);
      proc.once("close", finish);
    });
    this.writeMessage({ seq: this.nextSeq++, type: "request", command: "exit" });
    this.proc = null;
    this.ready = false;
    this.initPromise = null;
    for (const pending of this.pending.values()) pending.reject(new Error("LSP client disposed"));
    this.pending.clear();
    await closed;
  }
}

const SCRIPT_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Walk the workspace for script files for a project-wide diagnostics sweep.
 * Skips dependency/build/VCS directories; sorted for determinism; capped.
 */
function listProjectScriptFiles(root: string, maxFiles: number): string[] {
  const skip = new Set(["node_modules", ".git", "dist", "out", "build", ".claude", "coverage"]);
  const exts = SCRIPT_EXTS;
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (entry.isDirectory() && entry.name !== ".") continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
      } else if (exts.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  walk(root);
  out.sort();
  return out;
}

/**
 * Choose a geterrForProject anchor that belongs to the CONFIGURED project.
 * Prefers tsconfig.json/jsconfig.json (`files[]`, then `include` globs — the
 * common subset of real config semantics: JSONC tolerated, `extends` NOT
 * resolved); falls back to the walked listing when no config is usable.
 */
function pickProjectAnchor(root: string, walked: string[]): string {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const anchor = anchorFromConfig(path.join(root, name), root);
    if (anchor) return anchor;
  }
  return walked[0]!;
}

function anchorFromConfig(cfgPath: string, root: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(cfgPath, "utf-8");
  } catch {
    return null;
  }
  let cfg: { files?: unknown; include?: unknown; exclude?: unknown };
  try {
    cfg = JSON.parse(stripJsonComments(raw));
  } catch {
    return null;
  }
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  // `files` entries are exact paths — the cheapest reliable anchor.
  for (const f of strArray(cfg.files)) {
    const abs = path.resolve(root, f);
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch {
      // missing entry — try the next one
    }
  }
  const includes = strArray(cfg.include);
  // tsconfig semantics: a non-glob include entry means "everything under it";
  // a missing include means "**/*".
  const patterns = (includes.length > 0 ? includes : ["**/*"]).map((p) =>
    /[*?[]/.test(p) ? p : `${p.replace(/\/+$/, "")}/**/*`,
  );
  // tsconfig exclude entries are root-relative; a bare name means the whole
  // directory, which fast-glob only honors as an explicit `dir/**` pattern.
  const excludes = [
    ...strArray(cfg.exclude).map((p) => (/[*?[]/.test(p) ? p : `${p.replace(/\/+$/, "")}/**`)),
    "**/node_modules/**",
    "**/bower_components/**",
    "**/jspm_packages/**",
  ];
  let matches: string[];
  try {
    matches = fg.sync(patterns, {
      cwd: root,
      ignore: excludes,
      absolute: true,
      onlyFiles: true,
      suppressErrors: true,
      dot: false,
    });
  } catch {
    return null;
  }
  const scripts = matches.filter((m) => SCRIPT_EXTS.has(path.extname(m).toLowerCase())).sort();
  return scripts[0] ?? null;
}

/** Strip `//` and block comments plus trailing commas (tsconfig is JSONC). */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        // keep the escaped character verbatim
        if (i + 1 < text.length) {
          out += text[i + 1];
          i++;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
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
  await disposeLanguageServers();
  const all = [...CLIENTS.values()];
  CLIENTS.clear();
  await Promise.all(all.map((c) => c.dispose()));
}

/** Test/util: drop the cached client for a workspace without disposing. */
export function clearLspClientCache(workspaceRoot: string): void {
  CLIENTS.delete(path.resolve(workspaceRoot).toLowerCase());
}
