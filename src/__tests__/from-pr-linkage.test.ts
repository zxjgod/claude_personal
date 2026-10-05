// ============================================================
// Tests: --from-pr session linkage persistence
// ============================================================
// The linkage only works if prNumber/prUrl/prRepository survive a save and
// come back out of every read path the lookup uses (load, listSessions,
// searchSessions). These assert that contract on real files.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSession } from "../cli-session.js";
import {
  lookupPullRequestSession,
  matchSessionForPullRequest,
  parsePullRequestRef,
} from "../from-pr.js";
import { type SessionData, SessionMemory } from "../session-memory.js";
import type { Message } from "../types.js";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

/** A missing session file is a test bug, so fail with the reason rather than `!`. */
function requireSession(loaded: SessionData | null): SessionData {
  if (!loaded) throw new Error("expected the session to be on disk");
  return loaded;
}

let tmpDir: string;
let sm: SessionMemory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-frompr-"));
  sm = new SessionMemory(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("setSessionPullRequest", () => {
  it("persists the PR across the first save", async () => {
    const id = sm.generateId();
    sm.setSessionPullRequest(id, {
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      repository: "owner/repo",
    });
    await sm.save(id, [userMsg("hello")]);
    const loaded = requireSession(await sm.load(id));
    expect(loaded.prNumber).toBe(7);
    expect(loaded.prUrl).toBe("https://github.com/owner/repo/pull/7");
    expect(loaded.prRepository).toBe("owner/repo");
  });

  it("survives a re-save that does not repeat the linkage", async () => {
    const id = sm.generateId();
    sm.setSessionPullRequest(id, { number: 7, repository: "owner/repo" });
    await sm.save(id, [userMsg("first")]);
    // A later turn, from a fresh SessionMemory with no pending linkage —
    // this is what a resumed session does.
    const other = new SessionMemory(tmpDir);
    await other.save(id, [userMsg("first"), userMsg("second")]);
    const loaded = requireSession(await other.load(id));
    expect(loaded.prNumber).toBe(7);
    expect(loaded.prRepository).toBe("owner/repo");
  });

  it("re-points an already-linked session when re-stated", async () => {
    const id = sm.generateId();
    sm.setSessionPullRequest(id, { number: 7, repository: "owner/repo" });
    await sm.save(id, [userMsg("first")]);
    sm.setSessionPullRequest(id, { number: 9, repository: "owner/repo" });
    await sm.save(id, [userMsg("first"), userMsg("second")]);
    const loaded = requireSession(await sm.load(id));
    expect(loaded.prNumber).toBe(9);
  });

  it("leaves unlinked sessions without PR fields", async () => {
    const id = sm.generateId();
    await sm.save(id, [userMsg("hello")]);
    const loaded = requireSession(await sm.load(id));
    expect(loaded.prNumber).toBeUndefined();
    expect(loaded.prUrl).toBeUndefined();
    expect(loaded.prRepository).toBeUndefined();
  });

  it("is visible to listSessions so the lookup can find it", async () => {
    const id = sm.generateId();
    sm.setSessionPullRequest(id, { number: 7, repository: "owner/repo" });
    await sm.save(id, [userMsg("hello")]);
    const sessions = await sm.listSessions();
    expect(sessions.find((s) => s.sessionId === id)?.prNumber).toBe(7);
  });

  it("round-trips through a real parsePullRequestRef", async () => {
    const ref = parsePullRequestRef("https://github.com/owner/repo/pull/7");
    const id = sm.generateId();
    sm.setSessionPullRequest(id, ref);
    await sm.save(id, [userMsg("hello")]);
    const sessions = await sm.listSessions();
    const found = matchSessionForPullRequest(sessions, ref);
    expect(found?.sessionId).toBe(id);
  });

  it("is searchable by PR number", async () => {
    const id = sm.generateId();
    sm.setSessionPullRequest(id, { number: 7, repository: "owner/repo" });
    await sm.save(id, [userMsg("hello")]);
    const hits = await sm.searchSessions("7");
    expect(hits.map((h) => h.sessionId)).toContain(id);
  });

  it("keeps the PR out of the search haystack when unlinked", async () => {
    const id = sm.generateId();
    await sm.save(id, [userMsg("hello")]);
    const hits = await sm.searchSessions("PR #7");
    expect(hits).toHaveLength(0);
  });

  it("surfaces the PR on a catalog entry", async () => {
    const id = sm.generateId();
    sm.setSessionPullRequest(id, { number: 7, repository: "owner/repo" });
    await sm.save(id, [userMsg("hello")]);
    const entry = await sm.getCatalogEntry(id);
    expect(entry?.prNumber).toBe(7);
    expect(entry?.prRepository).toBe("owner/repo");
  });
});

// The whole point of the flag: run it twice and the second run resumes the
// session the first one linked. Driven through the REAL initSession (not a
// hand-built save) so the id-selection precedence is covered too.
describe("initSession --from-pr round trip", () => {
  const ghStub = (ownerRepo: string, number: number) => async () => ({
    stdout: JSON.stringify({
      number,
      url: `https://github.com/${ownerRepo}/pull/${number}`,
      headRepository: { nameWithOwner: ownerRepo },
    }),
    stderr: "",
  });

  it("links a fresh session, then resumes it on the next request", async () => {
    const ref = parsePullRequestRef("42");

    // First run: nothing is linked yet, so cli.ts passes no session id and
    // only the PR — initSession creates a session and tags it.
    const firstMessages: Message[] = [];
    const first = await initSession({
      workspaceRoot: tmpDir,
      messages: firstMessages,
      verbose: false,
      pullRequest: { number: 42, url: ref.url, repository: "owner/repo" },
    });
    // The linkage is pending until the first save, exactly like --name.
    await first.persistence.save(first.session.id, [userMsg("first")]);

    // Second run: the lookup finds the linked session and hands its id over.
    const sessions = await new SessionMemory(tmpDir).listSessions();
    const lookup = await lookupPullRequestSession(ref, tmpDir, sessions, {
      runGh: ghStub("owner/repo", 42),
    });
    expect(lookup.kind).toBe("resumed");
    if (lookup.kind !== "resumed") throw new Error("unreachable");

    const secondMessages: Message[] = [];
    const second = await initSession({
      workspaceRoot: tmpDir,
      messages: secondMessages,
      verbose: false,
      pullRequestSessionId: lookup.session.sessionId,
      pullRequest: lookup.ref,
    });
    expect(second.session.id).toBe(first.session.id);
    // The resumed transcript is loaded into the shared messages array, which
    // is what initSession does for --session/--resume too.
    expect(secondMessages.map((m) => m.role)).toEqual(["user"]);
  });

  it("does not resurrect a linked session for a different repository", async () => {
    const other = parsePullRequestRef("https://github.com/other/repo/pull/42");
    const id = sm.generateId();
    sm.setSessionPullRequest(id, { number: 42, repository: "owner/repo" });
    await sm.save(id, [userMsg("first")]);
    const sessions = await new SessionMemory(tmpDir).listSessions();
    const lookup = await lookupPullRequestSession(other, tmpDir, sessions, {
      runGh: ghStub("other/repo", 42),
    });
    expect(lookup.kind).toBe("unlinked");
  });
});
