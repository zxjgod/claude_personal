// ============================================================
// Official `--file <specs...>` — startup file resources.
//
// "File resources to download at startup. Format:
//  file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)"
//
// These are files the user uploaded from a device and referenced by id. The
// startup step pulls them into the workspace so the model can Read them.
//
// Archaeology (official 2.1.202 binary, not the help text) pinned the shape:
//   - destination  `<cwd>/<sessionId>/uploads/<relativePath>`, with an
//     `uploads/` prefix in the spec stripped so `img.png` and `uploads/img.png`
//     land in the same place
//   - traversal   a normalized path starting with `..` is rejected outright
//   - prefix      a spec that ALREADY names `<cwd>/<sessionId>/uploads/…` is
//     collapsed onto the same destination — that, not a bare `uploads/x`, is
//     what official's two prefix probes actually match
//   - endpoint    `GET ${baseUrl}/v1/files/${fileId}/content`, Bearer auth,
//     `anthropic-version: 2023-06-01`, `anthropic-beta: files-api-2025-04-14`
//   - status map  401/403/404 → named non-retriable errors; EVERY other
//     status is retried 3 times with 500ms·2^(n-1) backoff
//   - shape       bounded pool of 5, input order preserved, NEVER throws —
//     failures come back as per-file `{success:false, error}` results and the
//     session starts anyway
//
// Two deliberate deviations, both documented in --help and the changelog:
//   1. Official silently drops a spec with no `:` and only logs a half-empty
//      one. Neither shape is reported here — a spec that does not download
//      must never look like one that did.
//   2. Official authenticates with the Claude.ai OAuth token against its own
//      gateway. This CLI has no OAuth flow, so the session's configured
//      provider key/base URL are used instead; a gateway without the Files API
//      surfaces as a per-file error rather than a startup abort.
// ============================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { publicHttpGet } from "./tools/utils/public-http.js";

/** Official Files API beta header, as sent by the Anthropic SDK. */
export const FILES_API_BETA = "files-api-2025-04-14";
/** The `anthropic-version` official sends alongside it. */
export const ANTHROPIC_VERSION = "2023-06-01";
/** Official's documented Files API ceiling (500 MB). */
export const MAX_FILE_BYTES = 524_288_000;
/** Official's retry budget: 3 attempts, 500ms·2^(n-1) apart. */
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
/** Official's worker-pool width. */
export const DOWNLOAD_CONCURRENCY = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface FileSpec {
  fileId: string;
  relativePath: string;
}

export interface FileResourceResult {
  fileId: string;
  /** Absolute destination, or "" when the spec never resolved. */
  path: string;
  success: boolean;
  bytesWritten?: number;
  error?: string;
}

/**
 * Split the raw argv tokens into specs.
 *
 * Each token is ALSO split on whitespace, matching official, so a quoted
 * `--file "a:1 b:2"` behaves like two specs.
 */
export function parseFileSpecs(tokens: string[]): { specs: FileSpec[]; warnings: string[] } {
  const specs: FileSpec[] = [];
  const warnings: string[] = [];
  for (const token of tokens.flatMap((t) => t.split(" ").filter(Boolean))) {
    // Official splits on the FIRST colon, so a Windows-y or URL-ish id keeps
    // everything up to it verbatim.
    const colon = token.indexOf(":");
    if (colon === -1) {
      warnings.push(
        `Invalid file spec: ${token} — expected file_id:relative_path. Both are required.`,
      );
      continue;
    }
    const fileId = token.slice(0, colon);
    const relativePath = token.slice(colon + 1);
    if (!fileId || !relativePath) {
      warnings.push(
        `Invalid file spec: ${token} — expected file_id:relative_path. Both are required.`,
      );
      continue;
    }
    specs.push({ fileId, relativePath });
  }
  return { specs, warnings };
}

/**
 * `<cwd>/<sessionId>/uploads/<relativePath>`, or null when the spec escapes.
 *
 * A spec that already spells out the full `<cwd>/<sessionId>/uploads/` root
 * is collapsed onto the same destination, so pasting back an absolute path the
 * session reported does not produce `uploads/uploads/…`. Rejection is on the
 * NORMALIZED path, which is what makes `a/../../b` fail as well as `../b`.
 */
export function uploadPathFor(
  cwd: string,
  sessionId: string,
  relativePath: string,
): string | undefined {
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..")) return undefined;
  const root = path.join(cwd, sessionId, "uploads");
  const prefixes = [`${root}${path.sep}`, `${path.sep}uploads${path.sep}`];
  const prefix = prefixes.find((p) => normalized.startsWith(p));
  const tail = prefix ? normalized.slice(prefix.length) : normalized;
  return path.join(root, tail);
}

interface DownloadDeps {
  /** API root WITHOUT a trailing `/v1` (official: `${baseUrl}/v1/files/...`). */
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  /** Test seam; defaults to the hardened public HTTP GET. */
  fetchBytes?: (
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<Response>;
}

/**
 * Normalize a configured provider base URL to the API root the Files API
 * path hangs off.
 *
 * OpenAI-compatible endpoints are configured WITH a `/v1` suffix
 * (`https://host/v1`), so appending `/v1/files/...` verbatim would request
 * `/v1/v1/files/...`.
 */
export function filesApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

/** One attempt: HTTP status → buffer, or a named non-retriable failure. */
async function fetchOnce(
  fileId: string,
  deps: DownloadDeps,
  signal: AbortSignal,
): Promise<{ buffer: Buffer } | { error: string; retriable: boolean }> {
  const url = `${filesApiRoot(deps.baseUrl)}/v1/files/${encodeURIComponent(fileId)}/content`;
  const headers = {
    Authorization: `Bearer ${deps.apiKey}`,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": FILES_API_BETA,
  };
  const get = deps.fetchBytes ?? ((u, h, s) => publicHttpGet(u, h, s, MAX_FILE_BYTES));
  const response = await get(url, headers, signal);
  if (response.status === 200) return { buffer: Buffer.from(await response.arrayBuffer()) };
  // Named errors, official's wording — an unreachable file and a rejected
  // credential need different user actions, so "status 4xx" is not enough.
  if (response.status === 401)
    return { error: "Authentication failed: invalid or missing API key", retriable: false };
  if (response.status === 403)
    return { error: `Access denied to file: ${fileId}`, retriable: false };
  if (response.status === 404) return { error: `File not found: ${fileId}`, retriable: false };
  // Everything else IS retried, including 5xx. Official's axios uses
  // `validateStatus: s => s < 500`, so a 5xx THROWS into its catch (which also
  // yields a retriable outcome) while an unspecial-cased 4xx falls through to
  // the same "not done" branch. Only the three named statuses are terminal.
  return { error: `status ${response.status}`, retriable: true };
}

/** Download one spec to disk. Never throws; the failure is in the result. */
export async function downloadFileResource(
  spec: FileSpec,
  cwd: string,
  sessionId: string,
  deps: DownloadDeps,
): Promise<FileResourceResult> {
  const destination = uploadPathFor(cwd, sessionId, spec.relativePath);
  if (!destination) {
    return {
      fileId: spec.fileId,
      path: "",
      success: false,
      error: `Invalid file path: ${spec.relativePath}. Path must not traverse above workspace`,
    };
  }
  let lastError = "";
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (deps.signal) {
      if (deps.signal.aborted) break;
      deps.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const outcome = await fetchOnce(spec.fileId, deps, controller.signal);
      if ("buffer" in outcome) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, outcome.buffer);
        return {
          fileId: spec.fileId,
          path: destination,
          success: true,
          bytesWritten: outcome.buffer.length,
        };
      }
      lastError = outcome.error;
      if (!outcome.retriable) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
    }
    if (attempt < DOWNLOAD_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
  return { fileId: spec.fileId, path: destination, success: false, error: lastError };
}

/** Run `worker` over `items` with a bounded pool, preserving input order. */
async function pool<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  width: number,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      out[index] = await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, run));
  return out;
}

/**
 * Download every spec. Like official, this NEVER throws: a missing Files API
 * on the configured gateway degrades to per-file errors and the session still
 * starts, with the failures surfaced to the user and to the model.
 */
export async function downloadFileResources(
  specs: FileSpec[],
  cwd: string,
  sessionId: string,
  deps: DownloadDeps,
): Promise<FileResourceResult[]> {
  if (specs.length === 0) return [];
  return pool(
    specs,
    (spec) => downloadFileResource(spec, cwd, sessionId, deps),
    DOWNLOAD_CONCURRENCY,
  );
}

/** One line per file, for the startup report. */
export function describeFileResult(result: FileResourceResult): string {
  return result.success
    ? `Downloaded ${result.fileId} -> ${result.path} (${result.bytesWritten ?? 0} bytes)`
    : `Failed to download ${result.fileId}: ${result.error ?? "unknown error"}`;
}
