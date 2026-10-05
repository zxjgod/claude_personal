import { describe, expect, it } from "vitest";
import { parseFromPrFlag } from "../cli-session-flags.js";
import {
  describePullRequest,
  lookupPullRequestSession,
  matchSessionForPullRequest,
  PullRequestLookupError,
  parsePullRequestRef,
  resolvePullRequest,
} from "../from-pr.js";
import type { SessionMeta } from "../session-memory.js";

function session(overrides: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    messageCount: 1,
    completed: false,
    taskState: "paused",
    ...overrides,
  };
}

describe("parseFromPrFlag", () => {
  it("is undefined without the flag", () => {
    expect(parseFromPrFlag(["claude", "-p", "hi"])).toBeUndefined();
  });

  it("reads a spaced value", () => {
    expect(parseFromPrFlag(["claude", "--from-pr", "42"])).toEqual({ picker: false, raw: "42" });
  });

  it("reads an inline value", () => {
    expect(parseFromPrFlag(["claude", "--from-pr=42"])).toEqual({ picker: false, raw: "42" });
  });

  it("reads a URL value", () => {
    expect(parseFromPrFlag(["claude", "--from-pr", "https://github.com/o/r/pull/7"])).toEqual({
      picker: false,
      raw: "https://github.com/o/r/pull/7",
    });
  });

  // Official registers `--from-pr [value]` with argParser `(s) => s || !0`,
  // so a bare flag is the interactive-picker request — NOT an error the way a
  // valueless `--tools` is one.
  it("treats a bare flag as the picker request", () => {
    expect(parseFromPrFlag(["claude", "--from-pr"])).toEqual({ picker: true });
  });

  it("does not swallow a following flag as the value", () => {
    expect(parseFromPrFlag(["claude", "--from-pr", "--print"])).toEqual({ picker: true });
  });

  it("does not swallow the positional prompt as the value", () => {
    expect(parseFromPrFlag(["claude", "--from-pr", "review"])).toEqual({
      picker: false,
      raw: "review",
    });
  });

  // commander's `s || !0` maps an empty value to the picker request too.
  it("treats an empty value as the picker request", () => {
    expect(parseFromPrFlag(["claude", "--from-pr", ""])).toEqual({ picker: true });
    expect(parseFromPrFlag(["claude", "--from-pr="])).toEqual({ picker: true });
  });

  it("lets the last occurrence win", () => {
    expect(parseFromPrFlag(["claude", "--from-pr", "1", "--from-pr", "2"])).toEqual({
      picker: false,
      raw: "2",
    });
  });
});

describe("parsePullRequestRef", () => {
  it("parses a bare number", () => {
    expect(parsePullRequestRef("42")).toEqual({ number: 42 });
  });

  it("trims surrounding whitespace", () => {
    expect(parsePullRequestRef("  42 ")).toEqual({ number: 42 });
  });

  it("parses a github PR URL into number and repository", () => {
    expect(parsePullRequestRef("https://github.com/owner/repo/pull/7")).toEqual({
      number: 7,
      repository: "owner/repo",
    });
  });

  it("parses a protocol-less github URL", () => {
    expect(parsePullRequestRef("github.com/owner/repo/pull/7")).toEqual({
      number: 7,
      repository: "owner/repo",
    });
  });

  it("parses a GitHub Enterprise hostname", () => {
    expect(parsePullRequestRef("https://git.example.com/owner/repo/pull/12")).toEqual({
      number: 12,
      repository: "owner/repo",
    });
  });

  // A URL-shaped value that misses the /owner/repo/pull/N grammar must be
  // reported as a bad URL, not fall through and fail as "not a number" —
  // that would hide the actual mistake.
  it("rejects a URL that is not a PR link, by name", () => {
    expect(() => parsePullRequestRef("https://github.com/owner/repo/pulls/7")).toThrow(
      "unexpected PR URL format: https://github.com/owner/repo/pulls/7",
    );
  });

  it("rejects an issue URL", () => {
    expect(() => parsePullRequestRef("https://github.com/owner/repo/issues/7")).toThrow(
      "unexpected PR URL format",
    );
  });

  it("rejects a non-numeric value", () => {
    expect(() => parsePullRequestRef("main")).toThrow(
      '--from-pr expects a PR number or PR URL, got "main"',
    );
  });

  it("rejects a negative number", () => {
    expect(() => parsePullRequestRef("-3")).toThrow("--from-pr expects a PR number or PR URL");
  });

  it("rejects zero", () => {
    expect(() => parsePullRequestRef("0")).toThrow(
      '--from-pr expects a positive PR number, got "0"',
    );
  });

  it("rejects an empty value", () => {
    expect(() => parsePullRequestRef("   ")).toThrow("--from-pr requires a PR number or PR URL");
  });
});

describe("resolvePullRequest", () => {
  const ghOk = (payload: unknown) => async () => ({ stdout: JSON.stringify(payload), stderr: "" });

  it("returns the canonical number, url and repository", async () => {
    const ref = await resolvePullRequest({ number: 7 }, "/repo", {
      runGh: ghOk({
        number: 7,
        url: "https://github.com/owner/repo/pull/7",
        headRepository: { nameWithOwner: "owner/repo" },
      }),
    });
    expect(ref).toEqual({
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      repository: "owner/repo",
    });
  });

  it("passes the user-supplied URL to gh when one was given", async () => {
    let seen: string[] = [];
    await resolvePullRequest({ number: 7, url: "https://github.com/owner/repo/pull/7" }, "/repo", {
      runGh: async (args) => {
        seen = args;
        return { stdout: JSON.stringify({ number: 7 }), stderr: "" };
      },
    });
    expect(seen[2]).toBe("https://github.com/owner/repo/pull/7");
  });

  it("keeps a repository parsed from the URL when gh omits it", async () => {
    const ref = await resolvePullRequest({ number: 7, repository: "owner/repo" }, "/repo", {
      runGh: ghOk({ number: 7, url: "https://github.com/owner/repo/pull/7" }),
    });
    expect(ref.repository).toBe("owner/repo");
  });

  it("ignores a malformed nameWithOwner", async () => {
    const ref = await resolvePullRequest({ number: 7 }, "/repo", {
      runGh: ghOk({ number: 7, headRepository: { nameWithOwner: "repo" } }),
    });
    expect(ref.repository).toBeUndefined();
  });

  it("fails loudly on unreadable JSON", async () => {
    await expect(
      resolvePullRequest({ number: 7 }, "/repo", {
        runGh: async () => ({ stdout: "not json", stderr: "" }),
      }),
    ).rejects.toThrow("gh pr view returned unreadable output for PR 7.");
  });

  it("fails loudly when gh reports no PR number", async () => {
    await expect(
      resolvePullRequest({ number: 7 }, "/repo", {
        runGh: async () => ({ stdout: "{}", stderr: "" }),
      }),
    ).rejects.toThrow("gh pr view returned no PR number for PR 7.");
  });

  it("surfaces the gh failure reason", async () => {
    await expect(
      resolvePullRequest({ number: 7 }, "/repo", {
        runGh: async () => {
          throw new PullRequestLookupError("gh pr view failed: no pull requests found", true);
        },
      }),
    ).rejects.toThrow("gh pr view failed: no pull requests found");
  });

  it("marks every lookup failure fatal", async () => {
    await expect(
      resolvePullRequest({ number: 7 }, "/repo", {
        runGh: async () => {
          throw new PullRequestLookupError("gh CLI is required but not found.", true);
        },
      }),
    ).rejects.toMatchObject({ fatal: true });
  });
});

describe("matchSessionForPullRequest", () => {
  it("matches on the PR number alone", () => {
    const linked = session({ sessionId: "a", prNumber: 7 });
    expect(matchSessionForPullRequest([linked], { number: 7 })?.sessionId).toBe("a");
  });

  it("returns nothing for an unlinked number", () => {
    expect(
      matchSessionForPullRequest([session({ sessionId: "a", prNumber: 8 })], { number: 7 }),
    ).toBeUndefined();
  });

  it("requires the repository to agree when the request names one", () => {
    const other = session({ sessionId: "a", prNumber: 7, prRepository: "someone/else" });
    expect(
      matchSessionForPullRequest([other], { number: 7, repository: "owner/repo" }),
    ).toBeUndefined();
  });

  // GitHub treats owner/repo case-insensitively, so a session linked with
  // different casing must still be found.
  it("compares the repository case-insensitively", () => {
    const linked = session({ sessionId: "a", prNumber: 7, prRepository: "Owner/Repo" });
    expect(matchSessionForPullRequest([linked], { number: 7, repository: "owner/repo" })).toBe(
      linked,
    );
  });

  // An entry linked without a repository cannot be proven to belong to this
  // repo, so a repository-scoped request must not claim it.
  it("does not match a repository-scoped request against an unscoped link", () => {
    const unscoped = session({ sessionId: "a", prNumber: 7 });
    expect(matchSessionForPullRequest([unscoped], { number: 7, repository: "owner/repo" })).toBe(
      undefined,
    );
  });

  it("picks the most recently updated match", () => {
    const sessions = [
      session({ sessionId: "old", prNumber: 7, updatedAt: "2026-01-01T00:00:00.000Z" }),
      session({ sessionId: "new", prNumber: 7, updatedAt: "2026-05-01T00:00:00.000Z" }),
    ];
    expect(matchSessionForPullRequest(sessions, { number: 7 })?.sessionId).toBe("new");
  });
});

describe("lookupPullRequestSession", () => {
  it("reports a resume when a linked session exists", async () => {
    const linked = session({ sessionId: "a", prNumber: 7, prRepository: "owner/repo" });
    const result = await lookupPullRequestSession({ number: 7 }, "/repo", [linked], {
      runGh: async () => ({
        stdout: JSON.stringify({
          number: 7,
          url: "https://github.com/owner/repo/pull/7",
          headRepository: { nameWithOwner: "owner/repo" },
        }),
        stderr: "",
      }),
    });
    expect(result.kind).toBe("resumed");
    if (result.kind !== "resumed") throw new Error("unreachable");
    expect(result.session.sessionId).toBe("a");
  });

  it("reports an unlinked PR instead of throwing", async () => {
    const result = await lookupPullRequestSession({ number: 7 }, "/repo", [], {
      runGh: async () => ({ stdout: JSON.stringify({ number: 7 }), stderr: "" }),
    });
    expect(result.kind).toBe("unlinked");
  });

  it("propagates a lookup failure rather than reporting unlinked", async () => {
    await expect(
      lookupPullRequestSession({ number: 7 }, "/repo", [], {
        runGh: async () => {
          throw new PullRequestLookupError("gh CLI is required but not found.", true);
        },
      }),
    ).rejects.toThrow("gh CLI is required but not found.");
  });
});

describe("describePullRequest", () => {
  it("includes the repository when known", () => {
    expect(describePullRequest({ number: 7, repository: "owner/repo" })).toBe("owner/repo PR #7");
  });

  it("omits an unknown repository", () => {
    expect(describePullRequest({ number: 7 })).toBe("PR #7");
  });
});
