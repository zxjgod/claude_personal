import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitCommand } from "../commands/commit.js";
import { prCommand } from "../commands/pr.js";
import type { SlashCommand } from "../commands/types.js";
import { gatherDiffSummary } from "../git-context.js";

const execution = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => {
  const module = await original<typeof import("node:child_process")>();
  Object.defineProperty(execution, promisify.custom, {
    value: (command: string, args: string[], options: unknown) => execution(command, args, options),
  });
  return { ...module, execFile: execution };
});

type GitFailure = "head-status" | "head-diff" | "upstream-diff" | "upstream-log";

interface GitFixture {
  status?: string;
  numstat?: string;
  upstream?: string;
  upstreamDiff?: string;
  log?: string;
  failure?: GitFailure;
}

function mockGit(fixture: GitFixture = {}) {
  const {
    status = "",
    numstat = "",
    upstream = "",
    upstreamDiff = "",
    log = "",
    failure,
  } = fixture;
  execution.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { stdout: "true\n" };
    if (args[0] === "rev-parse") return { stdout: "main\n" };
    if (args[0] === "status") {
      if (failure === "head-status") throw new Error("injected status failure");
      return { stdout: status };
    }
    if (args[0] === "diff" && args[1] === "--numstat") {
      if (failure === "head-diff") throw new Error("injected HEAD diff failure");
      return { stdout: numstat };
    }
    if (args[0] === "for-each-ref") return { stdout: upstream };
    if (args[0] === "diff" && args[1] === "--name-status") {
      if (failure === "upstream-diff") throw new Error("injected upstream diff failure");
      return { stdout: upstreamDiff };
    }
    if (args[0] === "log") {
      if (failure === "upstream-log") throw new Error("injected upstream log failure");
      return { stdout: log };
    }
    throw new Error(`Unexpected git command: ${args.join(" ")}`);
  });
}

let output: string[];
beforeEach(() => {
  execution.mockReset();
  output = [];
  vi.spyOn(console, "log").mockImplementation((...values) => {
    output.push(values.join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

async function run(command: SlashCommand): Promise<string> {
  output = [];
  await command.run("", { workspaceRoot: "/fixture" } as never);
  return output.join("\n");
}

describe("git diff summary failures", () => {
  it.each([
    { failure: "head-status", command: "commit" },
    { failure: "head-diff", command: "commit" },
    { failure: "upstream-diff", command: "pr" },
    { failure: "upstream-log", command: "pr" },
  ] as const)("reports $failure instead of treating it as empty", async ({ failure, command }) => {
    mockGit({ failure, upstream: "origin/main\n" });
    const summary = await gatherDiffSummary("/fixture");
    expect(summary?.errors).toContain(failure);

    const text = await run(command === "commit" ? commitCommand : prCommand);
    expect(text).toContain("Git read failed");
    expect(text).toContain(failure);
    expect(text).not.toContain("working tree clean");
    expect(text).not.toContain("No upstream tracking branch");
  });

  it("keeps no upstream as a normal empty state", async () => {
    mockGit();
    const summary = await gatherDiffSummary("/fixture");
    expect(summary?.errors).toEqual([]);
    expect(summary?.upstreamFiles).toEqual([]);
    expect(summary?.branchCommits).toEqual([]);

    const text = await run(prCommand);
    expect(text).toContain("No upstream tracking branch or no commits ahead of it.");
    expect(text).not.toContain("Git read failed");
  });
});

describe("independent draft truncation markers", () => {
  it("tracks and prints only HEAD file truncation in /commit", async () => {
    const status = Array.from({ length: 61 }, (_, i) => ` M src/head-${i}.ts`).join("\n");
    mockGit({ status });
    const summary = await gatherDiffSummary("/fixture", { maxFiles: 1, maxCommits: 1 });
    expect(summary?.files).toHaveLength(1);
    expect(summary).toMatchObject({
      truncated: true,
      headTruncated: true,
      upstreamFilesTruncated: false,
      branchCommitsTruncated: false,
    });

    const text = await run(commitCommand);
    expect(text).toContain("HEAD file list truncated");
    expect(text).not.toContain("upstream file list truncated");
    expect(text).not.toContain("branch commit list truncated");
  });

  it("tracks and prints only upstream file truncation in /pr", async () => {
    const upstreamDiff = Array.from({ length: 61 }, (_, i) => `M\tsrc/pr-${i}.ts`).join("\n");
    mockGit({ upstream: "origin/main\n", upstreamDiff, log: "one commit\n" });
    const summary = await gatherDiffSummary("/fixture", { maxFiles: 1, maxCommits: 1 });
    expect(summary?.upstreamFiles).toHaveLength(1);
    expect(summary).toMatchObject({
      truncated: false,
      headTruncated: false,
      upstreamFilesTruncated: true,
      branchCommitsTruncated: false,
    });

    const text = await run(prCommand);
    expect(text).toContain("upstream file list truncated");
    expect(text).not.toContain("HEAD file list truncated");
    expect(text).not.toContain("branch commit list truncated");
  });

  it("tracks and prints only branch commit truncation in /pr", async () => {
    const log = Array.from({ length: 31 }, (_, i) => `commit ${i}`).join("\n");
    mockGit({ upstream: "origin/main\n", upstreamDiff: "M\tsrc/a.ts\n", log });
    const summary = await gatherDiffSummary("/fixture", { maxFiles: 1, maxCommits: 1 });
    expect(summary?.branchCommits).toHaveLength(1);
    expect(summary).toMatchObject({
      truncated: false,
      headTruncated: false,
      upstreamFilesTruncated: false,
      branchCommitsTruncated: true,
    });

    const text = await run(prCommand);
    expect(text).toContain("branch commit list truncated");
    expect(text).not.toContain("HEAD file list truncated");
    expect(text).not.toContain("upstream file list truncated");
  });
});
