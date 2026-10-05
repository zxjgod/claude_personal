// Tests for the official `--file <specs...>` startup file-resource flag
// (src/startup-files.ts + the argv parser in src/cli-session-flags.ts).
//
// The gap these lock down: official's help calls it "File resources to
// download at startup. Format: file_id:relative_path" — nothing about the
// destination directory, the retry budget, or what happens when the API is
// unreachable. All three were pinned from the official binary and are the
// parts most likely to be re-invented wrongly.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFileSpecTokens } from "../cli-session-flags.js";
import {
  describeFileResult,
  downloadFileResource,
  downloadFileResources,
  filesApiRoot,
  parseFileSpecs,
  uploadPathFor,
} from "../startup-files.js";
import { buildStartupFilesSection, buildSystemPrompt } from "../system-prompt.js";

const temporaries: string[] = [];
function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ccr-file-")));
  temporaries.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("--file argv parsing", () => {
  it("collects a variadic run and stops at the next flag", () => {
    expect(parseFileSpecTokens(["ccr", "--file", "a:1.txt", "b:img.png"])).toEqual([
      "a:1.txt",
      "b:img.png",
    ]);
    // The positional prompt must survive: `-p` is a flag, so the run ends there.
    expect(parseFileSpecTokens(["ccr", "--file", "a:1.txt", "-p", "hello"])).toEqual(["a:1.txt"]);
  });

  it("unions repeated occurrences", () => {
    expect(parseFileSpecTokens(["ccr", "--file", "a:1", "--file", "b:2"])).toEqual(["a:1", "b:2"]);
    expect(parseFileSpecTokens(["ccr", "--file=a:1"])).toEqual(["a:1"]);
  });

  it("rejects a bare --file instead of pretending nothing was asked for", () => {
    expect(() => parseFileSpecTokens(["ccr", "--file"])).toThrow(/at least one/);
    expect(() => parseFileSpecTokens(["ccr", "--file", "--brief"])).toThrow(/at least one/);
    expect(parseFileSpecTokens(["ccr", "--brief"])).toEqual([]);
  });
});

describe("spec grammar", () => {
  it("splits on the first colon", () => {
    expect(parseFileSpecs(["file_abc:docs/a:b.txt"]).specs).toEqual([
      { fileId: "file_abc", relativePath: "docs/a:b.txt" },
    ]);
  });

  it("also splits a quoted multi-spec token, as official does", () => {
    expect(parseFileSpecs(["a:1 b:2"]).specs).toHaveLength(2);
  });

  it("warns on both malformed shapes (official drops the colon-less one silently)", () => {
    const { specs, warnings } = parseFileSpecs(["noColon", ":only-path", "only-id:", "ok:1.txt"]);
    expect(specs).toEqual([{ fileId: "ok", relativePath: "1.txt" }]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("noColon");
  });
});

describe("destination path", () => {
  const cwd = process.cwd();

  it("lands under <cwd>/<sessionId>/uploads/", () => {
    expect(uploadPathFor(cwd, "s1", "docs/a.txt")).toBe(
      path.join(cwd, "s1", "uploads", "docs", "a.txt"),
    );
  });

  it("collapses a spec that already spells out the uploads root", () => {
    // This — not a bare `uploads/a.txt` — is what official's two prefix
    // probes match, on Windows and POSIX alike.
    const absolute = path.join(cwd, "s1", "uploads", "a.txt");
    expect(uploadPathFor(cwd, "s1", absolute)).toBe(path.join(cwd, "s1", "uploads", "a.txt"));
  });

  it("does NOT strip a bare uploads/ prefix (official is POSIX-absolute-only here)", () => {
    // Locked in so a future 'obviously better' cleanup doesn't silently
    // change where a spec lands.
    expect(uploadPathFor(cwd, "s1", "uploads/a.txt")).toBe(
      path.join(cwd, "s1", "uploads", "uploads", "a.txt"),
    );
  });

  it("rejects traversal, including after normalization", () => {
    expect(uploadPathFor(cwd, "s1", "../escape.txt")).toBeUndefined();
    // `a/../../b` normalizes to `../b` — the naive startsWith check on the RAW
    // string would have let this through.
    expect(uploadPathFor(cwd, "s1", "a/../../escape.txt")).toBeUndefined();
  });
});

describe("base URL normalization", () => {
  it("does not produce /v1/v1 when the provider URL already ends in /v1", () => {
    expect(filesApiRoot("https://host/v1")).toBe("https://host");
    expect(filesApiRoot("https://api.anthropic.com")).toBe("https://api.anthropic.com");
    expect(filesApiRoot("https://host/v1/")).toBe("https://host");
  });
});

function stubFetch(handler: (url: string, attempt: number) => Response | Promise<Response>): {
  fetchBytes: NonNullable<Parameters<typeof downloadFileResource>[3]["fetchBytes"]>;
  calls: string[];
} {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    fetchBytes: async (url) => {
      n++;
      calls.push(url);
      return handler(url, n);
    },
  };
}

const ok = (body: string) => new Response(Buffer.from(body), { status: 200 });
const deps = (baseUrl = "https://api.anthropic.com") => ({ baseUrl, apiKey: "k" });

describe("download", () => {
  it("writes the body to the resolved path", async () => {
    const root = tempDir();
    const { fetchBytes, calls } = stubFetch(() => ok("hello"));
    const result = await downloadFileResource(
      { fileId: "file_abc", relativePath: "docs/a.txt" },
      root,
      "s1",
      { ...deps(), fetchBytes },
    );
    expect(result.success).toBe(true);
    expect(result.bytesWritten).toBe(5);
    expect(fs.readFileSync(result.path, "utf8")).toBe("hello");
    expect(calls[0]).toBe("https://api.anthropic.com/v1/files/file_abc/content");
  });

  it("sends the Files API headers", async () => {
    const root = tempDir();
    let seen: Record<string, string> = {};
    const result = await downloadFileResource({ fileId: "f", relativePath: "a.txt" }, root, "s1", {
      ...deps(),
      fetchBytes: async (_u, h) => {
        seen = h;
        return ok("x");
      },
    });
    expect(result.success).toBe(true);
    expect(seen.Authorization).toBe("Bearer k");
    expect(seen["anthropic-version"]).toBe("2023-06-01");
    expect(seen["anthropic-beta"]).toBe("files-api-2025-04-14");
  });

  it("names a 404 without retrying", async () => {
    const root = tempDir();
    const { fetchBytes, calls } = stubFetch(() => new Response("", { status: 404 }));
    const result = await downloadFileResource(
      { fileId: "file_x", relativePath: "a.txt" },
      root,
      "s1",
      { ...deps(), fetchBytes },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("File not found: file_x");
    expect(calls).toHaveLength(1);
  });

  it("names a 401 without retrying", async () => {
    const root = tempDir();
    const { fetchBytes, calls } = stubFetch(() => new Response("", { status: 401 }));
    const result = await downloadFileResource({ fileId: "f", relativePath: "a.txt" }, root, "s1", {
      ...deps(),
      fetchBytes,
    });
    expect(result.error).toMatch(/Authentication failed/);
    expect(calls).toHaveLength(1);
  });

  it("retries a 5xx up to three attempts", async () => {
    const root = tempDir();
    const { fetchBytes, calls } = stubFetch(() => new Response("", { status: 503 }));
    const result = await downloadFileResource({ fileId: "f", relativePath: "a.txt" }, root, "s1", {
      ...deps(),
      fetchBytes,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("status 503");
    expect(calls).toHaveLength(3);
  }, 10_000);

  it("recovers when a retried attempt succeeds", async () => {
    const root = tempDir();
    const { fetchBytes } = stubFetch((_u, attempt) =>
      attempt === 1 ? new Response("", { status: 500 }) : ok("late"),
    );
    const result = await downloadFileResource({ fileId: "f", relativePath: "a.txt" }, root, "s1", {
      ...deps(),
      fetchBytes,
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(result.path, "utf8")).toBe("late");
  }, 10_000);

  it("reports a traversal spec without touching the network", async () => {
    const root = tempDir();
    const { fetchBytes, calls } = stubFetch(() => ok("never"));
    const result = await downloadFileResource(
      { fileId: "f", relativePath: "../escape.txt" },
      root,
      "s1",
      { ...deps(), fetchBytes },
    );
    expect(result.success).toBe(false);
    expect(result.path).toBe("");
    expect(result.error).toMatch(/must not traverse/);
    expect(calls).toHaveLength(0);
  });
});

describe("batch", () => {
  it("never throws and preserves input order despite mixed outcomes", async () => {
    const root = tempDir();
    const results = await downloadFileResources(
      [
        { fileId: "a", relativePath: "a.txt" },
        { fileId: "missing", relativePath: "b.txt" },
        { fileId: "c", relativePath: "c.txt" },
      ],
      root,
      "s1",
      {
        ...deps(),
        fetchBytes: async (url) =>
          url.includes("missing") ? new Response("", { status: 404 }) : ok(url),
      },
    );
    expect(results.map((r) => r.fileId)).toEqual(["a", "missing", "c"]);
    expect(results.map((r) => r.success)).toEqual([true, false, true]);
  });

  it("is a no-op for an empty spec list", async () => {
    await expect(downloadFileResources([], process.cwd(), "s", deps())).resolves.toEqual([]);
  });

  it("describes both outcomes in one line each", () => {
    expect(
      describeFileResult({ fileId: "a", path: "/w/a.txt", success: true, bytesWritten: 12 }),
    ).toContain("-> /w/a.txt (12 bytes)");
    expect(
      describeFileResult({ fileId: "b", path: "", success: false, error: "File not found: b" }),
    ).toContain("File not found: b");
  });
});

describe("STARTUP FILES prompt section", () => {
  it("is absent when nothing was requested", () => {
    const blocks = buildSystemPrompt({ workspaceRoot: "/t", tools: [] });
    expect(blocks.some((b) => b.includes("[STARTUP FILES]"))).toBe(false);
    expect(
      buildSystemPrompt({ workspaceRoot: "/t", tools: [], startupFiles: [] }).some((b) =>
        b.includes("[STARTUP FILES]"),
      ),
    ).toBe(false);
  });

  it("lists landed files with sizes", () => {
    const text = buildStartupFilesSection([{ path: "/w/s/uploads/a.txt", bytesWritten: 42 }]);
    expect(text).toContain("/w/s/uploads/a.txt (42 bytes)");
    expect(text).not.toContain("did NOT download");
  });

  it("states failures explicitly so the model cannot invent the file", () => {
    const text = buildStartupFilesSection([{ path: "", error: "File not found: file_x" }]);
    expect(text).toContain("did NOT download");
    expect(text).toContain("File not found: file_x");
  });
});
