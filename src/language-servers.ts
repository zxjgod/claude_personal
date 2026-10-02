import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { confirmExecutableConfig, isExecutableConfigTrusted } from "./executable-config-trust.js";
import { pluginDirs, readManifest } from "./plugins.js";
import { userConfigRoot } from "./settings.js";
import { resolveAllowedWorkspaceFile } from "./tools/utils/path.js";
import { sanitizeChildEnv } from "./utils/env-sanitize.js";
export async function confirmProjectLspConfig(
  root: string,
  confirm?: (description: string) => Promise<boolean>,
): Promise<boolean> {
  const file = path.join(root, ".claude", "lsp.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const value = JSON.parse(raw);
    const definitions = value.lspServers ?? value;
    const commands = Object.entries(definitions)
      .map(([name, entry]) => `${name}: ${JSON.stringify(entry)}`)
      .join("\n");
    return confirmExecutableConfig(
      file,
      raw,
      confirm
        ? () => confirm(`Project language servers execute commands:\n${commands}`)
        : undefined,
    );
  } catch {
    return false;
  }
}
export interface LanguageServerConfig {
  command: string;
  args?: string[];
  extensionToLanguage: Record<string, string>;
  initializationOptions?: unknown;
}
function configurations(root: string): Record<string, LanguageServerConfig> {
  const layers: Record<string, LanguageServerConfig>[] = [];
  for (const file of [
    path.join(userConfigRoot(), "lsp.json"),
    path.join(root, ".claude", "lsp.json"),
  ]) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (file === path.join(root, ".claude", "lsp.json") && !isExecutableConfigTrusted(file, raw))
        continue;
      const value = JSON.parse(raw);
      layers.push(value.lspServers ?? value);
    } catch {
      /* optional */
    }
  }
  for (const dir of pluginDirs(root)) {
    const manifest = readManifest(dir);
    if (manifest?.lspServers && typeof manifest.lspServers === "object")
      layers.push(manifest.lspServers as Record<string, LanguageServerConfig>);
    else if (typeof manifest?.lspServers === "string")
      try {
        layers.push(JSON.parse(fs.readFileSync(path.resolve(dir, manifest.lspServers), "utf8")));
      } catch {
        /* isolated */
      }
  }
  return Object.assign({}, ...layers);
}
export class LanguageServer {
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private counter = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private initialized: Promise<void> | undefined;
  private versions = new Map<string, number>();
  readonly diagnostics = new Map<string, unknown[]>();
  private diagnosticWaiters = new Map<string, Set<(value: unknown[]) => void>>();
  constructor(
    private root: string,
    private config: LanguageServerConfig,
  ) {}
  async start(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.buffer = Buffer.alloc(0);
    this.versions.clear();
    this.diagnostics.clear();
    this.process = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.root,
      env: sanitizeChildEnv(process.env),
      windowsHide: true,
      stdio: "pipe",
    });
    const child = this.process;
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.process !== child) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.consume();
    });
    this.process.stderr.resume();
    child.stdin.on("error", (error) => {
      if (this.process === child) {
        this.fail(error);
        void this.dispose();
      }
    });
    child.on("error", (error) => {
      if (this.process === child) this.fail(error);
    });
    child.on("close", () => {
      if (this.process !== child) return;
      this.fail(new Error("Language server exited"));
      this.initialized = undefined;
      this.process = undefined;
      this.versions.clear();
    });
    this.initialized = this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      capabilities: { textDocument: { publishDiagnostics: {} } },
      initializationOptions: this.config.initializationOptions,
    })
      .then(() => {
        this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
      })
      .catch(async (error) => {
        if (this.process === child) await this.dispose();
        throw error;
      });
    return this.initialized;
  }
  private fail(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
  private consume(): void {
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.fail(new Error("Language server frame too large"));
      this.dispose();
      return;
    }
    while (true) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const length = Number(
        /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, boundary).toString())?.[1],
      );
      if (!Number.isInteger(length) || length < 0 || length > 8 * 1024 * 1024) {
        this.dispose();
        return;
      }
      if (this.buffer.length < boundary + 4 + length) return;
      const body = this.buffer.subarray(boundary + 4, boundary + 4 + length);
      this.buffer = this.buffer.subarray(boundary + 4 + length);
      try {
        const value = JSON.parse(body.toString());
        if (typeof value.id === "number" && !value.method) {
          const entry = this.pending.get(value.id);
          if (!entry) continue;
          clearTimeout(entry.timer);
          this.pending.delete(value.id);
          if (value.error) entry.reject(new Error(value.error.message));
          else entry.resolve(value.result);
        } else if (value.method === "textDocument/publishDiagnostics") {
          this.diagnostics.set(value.params.uri, value.params.diagnostics);
          for (const waiter of this.diagnosticWaiters.get(value.params.uri) ?? [])
            waiter(value.params.diagnostics);
        } else if (value.id !== undefined)
          this.send({
            jsonrpc: "2.0",
            id: value.id,
            result:
              value.method === "workspace/configuration"
                ? (value.params?.items ?? []).map(() => ({}))
                : null,
          });
      } catch {
        this.fail(new Error("Invalid language server message"));
        void this.dispose();
      }
    }
  }
  private send(value: unknown): void {
    const body = JSON.stringify(value);
    this.process?.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
        reject(new Error(`LSP ${method} timed out`));
        void this.dispose();
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async open(file: string, languageId: string): Promise<void> {
    await this.start();
    const uri = pathToFileURL(file).href;
    const text = fs.readFileSync(file, "utf8");
    const version = this.versions.get(uri);
    this.versions.set(uri, (version ?? 0) + 1);
    this.send({
      jsonrpc: "2.0",
      method: version === undefined ? "textDocument/didOpen" : "textDocument/didChange",
      params:
        version === undefined
          ? { textDocument: { uri, languageId, version: 1, text } }
          : { textDocument: { uri, version: version + 1 }, contentChanges: [{ text }] },
    });
  }
  waitForDiagnostics(file: string, timeoutMs = 500): Promise<unknown[]> {
    const uri = pathToFileURL(file).href;
    if (this.diagnostics.has(uri)) return Promise.resolve(this.diagnostics.get(uri)!);
    return new Promise((resolve) => {
      const waiters = this.diagnosticWaiters.get(uri) ?? new Set();
      const finish = (value: unknown[]) => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (!waiters.size) this.diagnosticWaiters.delete(uri);
        resolve(value);
      };
      const timer = setTimeout(() => finish(this.diagnostics.get(uri) ?? []), timeoutMs);
      waiters.add(finish);
      this.diagnosticWaiters.set(uri, waiters);
    });
  }
  async dispose(): Promise<void> {
    this.fail(new Error("Language server disposed"));
    const child = this.process;
    this.process = undefined;
    this.initialized = undefined;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
}
const clients = new Map<string, LanguageServer>();
export async function disposeLanguageServers(): Promise<void> {
  const closing = [...clients.values()].map((server) => server.dispose());
  clients.clear();
  await Promise.all(closing);
}
process.once("exit", () => {
  void disposeLanguageServers();
});
export async function languageServerFor(
  root: string,
  file: string,
): Promise<{ server: LanguageServer; language: string; file: string } | undefined> {
  if (process.argv.includes("--safe-mode") || process.argv.includes("--bare")) return undefined;
  const resolution = resolveAllowedWorkspaceFile(file, root);
  if (!resolution.ok) throw new Error(resolution.error);
  const extension = path.extname(file);
  for (const [name, config] of Object.entries(configurations(root))) {
    const language = config.extensionToLanguage?.[extension];
    if (!language || typeof config.command !== "string") continue;
    const key = `${root}\0${name}\0${JSON.stringify(config)}`;
    let server = clients.get(key);
    if (!server) {
      server = new LanguageServer(root, config);
      clients.set(key, server);
    }
    await server.open(resolution.path, language);
    return { server, language, file: resolution.path };
  }
  return undefined;
}
