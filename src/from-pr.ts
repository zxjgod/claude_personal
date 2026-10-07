// ============================================================
// Official `--from-pr [value]` — resume the session linked to a PR
// ------------------------------------------------------------
// KERNEL vs DOMAIN split: `cli-session-flags.ts` turns argv into
// `{picker}` or `{raw}` (official declares the value OPTIONAL, and a
// bare `--from-pr` is the interactive-picker request, not an error).
// This module owns everything after that: the PR reference grammar,
// the `gh` round trip, and the session match.
//
// What official actually does (verified against claude 2.1.202):
//  - `--from-pr` is classified in the SAME argv bucket as `-r`/
//    `--resume` ("resume"), and the mutual-exclusion check pairs it
//    with `--resume` explicitly.
//  - Sessions carry `prNumber` / `prUrl` / `prRepository` in their
//    persisted metadata, and `--from-pr` looks a session up by them.
//  - PR facts come from the `gh` CLI, which is in official's Bash
//    read-only allowlist. A missing `gh` is a NAMED terminal error
//    ("gh CLI is required but not found."), not a silent skip.
//  - Two live `claude -p` probes (an unlinked PR number, and a bare
//    `--from-pr` with no TTY) both started a plain fresh session with
//    no output at all — the flag is close to a no-op outside a linked
//    session. That silence is NOT reproduced here: falling through to
//    a fresh session is reported, and the new session is tagged with
//    the PR so the next `--from-pr <same>` actually resumes it.
//
// Not implemented (see docs/20261002-claude-code差距评估.md): the
// interactive PR picker, and the automatic branch→PR linkage official
// gets from its GitHub integration.
// ============================================================

import { execFile } from "node:child_process";
import type { SessionMeta } from "./session-memory.js";

/** A pull request identified well enough to find a linked session. */
export interface PullRequestRef {
  /** PR number, the key a session is matched on. */
  number: number;
  /** Canonical PR URL when known (`gh` resolved it, or the user gave one). */
  url?: string;
  /** `owner/repo`, so PR #7 in one repo never matches a session in another. */
  repository?: string;
}

/**
 * A PR URL: `<host>/<owner>/<repo>/pull/<number>`. Official carries the
 * same shape in two places — `/([^/]+)\/([^/]+)\/pull\//` for the error
 * it reports on a malformed URL, and a full anchored host form for
 * parsing. Host is allowed to be a GitHub Enterprise hostname.
 */
const PR_URL_RE = /^(?:https?:\/\/)?([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/;

/** Repo name check: gh's `nameWithOwner` is `owner/repo`, both non-empty. */
function normalizeRepository(value: unknown): string | undefined {
  // `gh pr view --json headRepository` returns an OBJECT
  // ({id,name,nameWithOwner,...}); a bare string is accepted too so a
  // future gh shape change degrades to "unknown repo" rather than to a
  // wrong one.
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? (value as { nameWithOwner?: unknown }).nameWithOwner
        : undefined;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  if (trimmed.slice(0, slash).includes("/") || trimmed.slice(slash + 1).includes("/")) {
    return undefined;
  }
  return trimmed;
}

/**
 * Parse the value given to `--from-pr` into a PR reference.
 *
 * Two accepted forms, matching the official help ("by PR number/URL"):
 * a bare number, or a PR URL. Anything else is a user error reported by
 * name rather than a silently-ignored token — a typo'd PR number that
 * quietly opened an unrelated fresh session is exactly the failure this
 * project refuses to ship.
 *
 * Throws with a caller-facing message; never returns a partial ref.
 */
export function parsePullRequestRef(raw: string): PullRequestRef {
  const value = raw.trim();
  if (!value) throw new Error("--from-pr requires a PR number or PR URL");

  const urlMatch = PR_URL_RE.exec(value);
  const numberPart = urlMatch?.[4];
  if (urlMatch && numberPart !== undefined) {
    const owner = urlMatch[2];
    const repo = urlMatch[3];
    if (owner === undefined || repo === undefined) {
      throw new Error(`unexpected PR URL format: ${value}`);
    }
    return { number: Number.parseInt(numberPart, 10), repository: `${owner}/${repo}` };
  }

  // Anything that LOOKS like a link is held to the URL grammar. Without
  // this, `https://github.com/o/r/pulls/7` would fall through to the
  // integer branch and fail as "not a number", hiding the real mistake.
  if (/^[a-z][\w+.-]*:\/\//i.test(value) || /^[\w.-]+\/[\w.-]+\//.test(value)) {
    throw new Error(`unexpected PR URL format: ${value}`);
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`--from-pr expects a PR number or PR URL, got "${value}"`);
  }
  const number = Number.parseInt(value, 10);
  if (number <= 0) throw new Error(`--from-pr expects a positive PR number, got "${value}"`);
  return { number };
}

/** Raised when `gh` is unusable; carries official's own wording. */
export class PullRequestLookupError extends Error {
  constructor(
    message: string,
    /** True when retrying without the PR would lose the user's intent. */
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = "PullRequestLookupError";
  }
}

interface GhResult {
  stdout: string;
  stderr: string;
}

/** Injection seam for tests; defaults to the real `gh` binary. */
export type GhRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<GhResult>;

const GH_TIMEOUT_MS = 15_000;

const runGh: GhRunner = (args, cwd, timeoutMs) =>
  new Promise<GhResult>((resolve, reject) => {
    execFile(
      "gh",
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        // ENOENT is the "gh CLI is required but not found." case and is
        // reported separately from a failed call, because the fix differs.
        if (err.code === "ENOENT") {
          reject(new PullRequestLookupError("gh CLI is required but not found.", true));
          return;
        }
        if (err.killed || err.signal === "SIGTERM") {
          reject(
            new PullRequestLookupError(
              `gh pr view timed out after ${Math.round(timeoutMs / 1000)}s.`,
              true,
            ),
          );
          return;
        }
        const detail = String(stderr).trim().split("\n").filter(Boolean)[0] ?? err.message;
        reject(new PullRequestLookupError(`gh pr view failed: ${detail}`, true));
      },
    );
  });

/**
 * Confirm the PR exists and learn its canonical URL and repository.
 *
 * Official keys sessions on the PR NUMBER but also persists the url and
 * repository, and both are needed to keep PR #7 of one repo from
 * resuming a session that was linked to PR #7 of another. `gh` is the
 * only source for those, so an unresolvable PR is fatal here rather
 * than degrading into a fresh session that quietly looks like it
 * worked.
 */
export async function resolvePullRequest(
  ref: PullRequestRef,
  cwd: string,
  options: { runGh?: GhRunner; timeoutMs?: number } = {},
): Promise<PullRequestRef> {
  const run = options.runGh ?? runGh;
  const target = ref.url ?? String(ref.number);
  const { stdout } = await run(
    ["pr", "view", target, "--json", "number,url,headRepository"],
    cwd,
    options.timeoutMs ?? GH_TIMEOUT_MS,
  );
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new PullRequestLookupError(
      `gh pr view returned unreadable output for PR ${ref.number}.`,
      true,
    );
  }
  if (typeof payload !== "object" || payload === null) {
    throw new PullRequestLookupError(
      `gh pr view returned unreadable output for PR ${ref.number}.`,
      true,
    );
  }
  const record = payload as { number?: unknown; url?: unknown; headRepository?: unknown };
  const number = typeof record.number === "number" ? record.number : undefined;
  if (number === undefined) {
    throw new PullRequestLookupError(
      `gh pr view returned no PR number for PR ${ref.number}.`,
      true,
    );
  }
  const url = typeof record.url === "string" && record.url.trim() ? record.url.trim() : ref.url;
  const repository = normalizeRepository(record.headRepository) ?? ref.repository;
  return { number, url, repository };
}

/**
 * Find the most recently updated session linked to this PR.
 *
 * Number is the key, as in official. When both sides know the
 * repository it is REQUIRED to agree: `owner/repo` comparison is
 * case-insensitive because GitHub treats it that way, and a
 * repository-scoped PR must never resume an unscoped one.
 */
export function matchSessionForPullRequest<T extends SessionMeta>(
  sessions: T[],
  ref: PullRequestRef,
): T | undefined {
  const wanted = ref.repository?.toLowerCase();
  const matches = sessions.filter((session) => {
    if (session.prNumber !== ref.number) return false;
    if (!wanted) return true;
    // An entry linked without a repository cannot be proven to be this
    // repo's PR, so it does not match a repository-scoped request.
    return session.prRepository?.toLowerCase() === wanted;
  });
  return matches.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )[0];
}

/** How a resolved `--from-pr` request resolved against the session store. */
export type PullRequestLookup =
  | { kind: "resumed"; ref: PullRequestRef; session: SessionMeta }
  | { kind: "unlinked"; ref: PullRequestRef };

/**
 * The full lookup: resolve the PR, then look for a linked session.
 *
 * "unlinked" is NOT an error — official starts a fresh session in that
 * case (confirmed by two live probes). The caller reports it and tags
 * the new session so the next request does resume.
 */
export async function lookupPullRequestSession(
  ref: PullRequestRef,
  cwd: string,
  sessions: SessionMeta[],
  options: { runGh?: GhRunner; timeoutMs?: number } = {},
): Promise<PullRequestLookup> {
  const resolved = await resolvePullRequest(ref, cwd, options);
  const session = matchSessionForPullRequest(sessions, resolved);
  return session
    ? { kind: "resumed", ref: resolved, session }
    : { kind: "unlinked", ref: resolved };
}

/** `PR #42 (owner/repo)` — the label used in the resume and unlinked notices. */
export function describePullRequest(ref: PullRequestRef): string {
  const scope = ref.repository ? `${ref.repository} ` : "";
  return `${scope}PR #${ref.number}`;
}
