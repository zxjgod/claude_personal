import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packageRoot, releaseNotesCommand } from "../commands/release-notes.js";
import { parseReleaseNotes, releaseForVersion, validateCurrentRelease } from "../release-notes.js";
import { stripAnsi } from "../tui/terminal-width.js";
import { APP_VERSION } from "../version.js";

const fixture = vi.hoisted(() => ({ body: null as string | null, failRead: false }));
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]).replace(/\\/g, "/").endsWith("docs/CHANGELOG.md")) {
        if (fixture.failRead) throw new Error("cannot read release notes");
        if (fixture.body !== null) return fixture.body;
      }
      return actual.readFileSync(...args);
    },
  };
});

const CHANGELOG = [
  "# Historical document header",
  "",
  "## v9.9.9",
  "Future release, not installed.",
  "",
  `## v${APP_VERSION}`,
  "",
  "### Usage impact",
  "",
  "- **Input behavior** now accepts a bare `@`.",
  "",
  "### Examples",
  "",
  "```text",
  "/release-notes",
  "/release-notes all",
  "```",
  "",
  "---",
  "",
  "## v1.2.0 - 2026-07-11",
  "old-feature-only",
].join("\n");

describe("versioned release notes", () => {
  it("selects the exact installed version even when the first entry is newer", () => {
    const entry = releaseForVersion(CHANGELOG, APP_VERSION);
    expect(entry?.markdown).toContain("Input behavior");
    expect(entry?.markdown).not.toContain("Future release");
    expect(entry?.markdown).not.toContain("Historical document header");
    expect(entry?.markdown).not.toContain("old-feature-only");
    expect(entry?.markdown.endsWith("---")).toBe(false);
  });

  it("ignores apparent release headings inside fenced code", () => {
    const input = `## v${APP_VERSION}\n### 使用影响\nA real impact.\n\n\`\`\`text\n## v${APP_VERSION}\n\`\`\`\n\n## 2026-08-02\nlegacy`;
    expect(parseReleaseNotes(input).map((entry) => entry.version)).toEqual([APP_VERSION, null]);
    expect(validateCurrentRelease(input, APP_VERSION).usageImpact).toContain("A real impact");
  });

  it("matches prereleases exactly without substituting a stable version", () => {
    const input = "## v2.0.0\nStable\n\n## 2.0.0-beta.1\n### Usage impact\nPreview behavior.";
    expect(releaseForVersion(input, "2.0.0-beta.1")?.usageImpact).toBe("Preview behavior.");
    expect(releaseForVersion(input, "2.0.0-beta.2")).toBeNull();
    expect(
      releaseForVersion(
        "## v2.0.0-beta.1+local\n### Usage impact\nLocal behavior.",
        "2.0.0-beta.1+local",
      )?.usageImpact,
    ).toBe("Local behavior.");
  });

  it("fails validation when the installed version is missing", () => {
    expect(() => validateCurrentRelease("## v0.1.0\nOld notes.", APP_VERSION)).toThrow(
      "Missing release notes",
    );
  });

  it("fails validation when an impact section is missing or empty", () => {
    expect(() => validateCurrentRelease(`## v${APP_VERSION}\nChanges only.`, APP_VERSION)).toThrow(
      "non-empty",
    );
    expect(() =>
      validateCurrentRelease(
        `## v${APP_VERSION}\n### 使用影响\n\n### Examples\nExample only.`,
        APP_VERSION,
      ),
    ).toThrow("non-empty");
  });

  it("rejects duplicate entries for the installed version", () => {
    expect(() =>
      validateCurrentRelease(`${CHANGELOG}\n\n## v${APP_VERSION}\nDuplicate`, APP_VERSION),
    ).toThrow("Duplicate release notes");
  });

  it("validates the real bundled current version and its impact notes", () => {
    const root = packageRoot();
    expect(root).not.toBeNull();
    if (!root) throw new Error("Package root is unavailable.");
    expect(existsSync(resolve(root, "package.json"))).toBe(true);
    const body = readFileSync(resolve(root, "docs/CHANGELOG.md"), "utf-8");
    const entry = validateCurrentRelease(body, APP_VERSION);
    expect(entry.usageImpact).toContain("/resume");
    expect(entry.usageImpact).toContain("/release-notes");
  });
});

describe("release-notes command", () => {
  let logged: string[];
  let previousColorLevel: typeof chalk.level;
  beforeEach(() => {
    fixture.body = CHANGELOG;
    fixture.failRead = false;
    logged = [];
    previousColorLevel = chalk.level;
    chalk.level = 3;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
  });
  afterEach(() => {
    fixture.body = null;
    fixture.failRead = false;
    chalk.level = previousColorLevel;
    vi.restoreAllMocks();
  });

  it("renders installed-version headings, bold, inline code and examples", () => {
    expect(releaseNotesCommand.run("", {} as never)).toEqual({ handled: true });
    const out = stripAnsi(logged.join("\n"));
    expect(out).toContain(`What's new · v${APP_VERSION}`);
    expect(out).toContain("Usage impact");
    expect(out).toContain("Input behavior");
    expect(out).toContain("/release-notes all");
    expect(out).not.toContain("### Usage impact");
    expect(out).not.toContain("**Input behavior**");
    expect(out).not.toContain("```text");
    expect(out).not.toContain("old-feature-only");
    expect(logged.join("\n")).toContain("\x1b[");
  });

  it("preserves all current-version content instead of truncating at a line cap", () => {
    fixture.body = `## v${APP_VERSION}\n### Usage impact\n${Array.from({ length: 75 }, (_, i) => `- item-${i}`).join("\n")}`;
    releaseNotesCommand.run("", {} as never);
    expect(stripAnsi(logged.join("\n"))).toContain("item-74");
  });

  it("does not present older notes as current when the matching entry is absent", () => {
    fixture.body = "## v1.0.0\nold-feature-only";
    releaseNotesCommand.run("", {} as never);
    const out = stripAnsi(logged.join("\n"));
    expect(out).toContain(`Missing release notes for installed version v${APP_VERSION}`);
    expect(out).not.toContain("old-feature-only");
    expect(out).not.toContain("What's new");
  });

  it("renders all historical records only when all is requested", () => {
    releaseNotesCommand.run("all", {} as never);
    const out = stripAnsi(logged.join("\n"));
    expect(out).toContain("all releases");
    expect(out).toContain("old-feature-only");
    expect(out).toContain("Future release");
    expect(out).not.toContain("## v9.9.9");
  });

  it("reports read errors without throwing", () => {
    fixture.failRead = true;
    expect(() => releaseNotesCommand.run("", {} as never)).not.toThrow();
    expect(logged.join("\n")).toContain("cannot read release notes");
  });

  it("reports supported syntax for an unknown argument", () => {
    releaseNotesCommand.run("latest", {} as never);
    expect(logged.join("\n")).toContain("Usage: /release-notes [all]");
    expect(logged.join("\n")).not.toContain("What's new");
  });
});
