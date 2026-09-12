// ============================================================
// Tests: /release-notes — changelog slicing and packaged-file resolution
// ============================================================

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestEntry, packageRoot, releaseNotesCommand } from "../commands/release-notes.js";

const CHANGELOG = [
  "# 更新日志 (Changelog)",
  "",
  "> 版本号以 package.json 为唯一真源。",
  "",
  "## 2026-08-02",
  "",
  "### 文档同步",
  "",
  "- 新增 doc-sync 脚本。",
  "",
  "---",
  "",
  "## v1.2.0 - 2026-07-11",
  "",
  "### 架构重构",
  "",
  "- agent-loop 拆分。",
  "",
].join("\n");

describe("latestEntry", () => {
  it("stops at the second release heading", () => {
    const entry = latestEntry(CHANGELOG);
    expect(entry).toContain("## 2026-08-02");
    expect(entry).toContain("doc-sync");
    expect(entry).not.toContain("## v1.2.0");
    expect(entry).not.toContain("agent-loop 拆分");
  });

  it("trims the trailing rule so the entry doesn't end on '---'", () => {
    expect(latestEntry(CHANGELOG).trimEnd().endsWith("---")).toBe(false);
  });

  it("returns the whole document when there is only one heading", () => {
    const single = "# Title\n\n## Only\n\n- one\n";
    expect(latestEntry(single).trim()).toBe(single.trim());
  });
});

describe("packageRoot", () => {
  it("resolves a directory that actually holds package.json", () => {
    const root = packageRoot();
    expect(root).not.toBeNull();
    expect(existsSync(resolve(root!, "package.json"))).toBe(true);
  });
});

describe("releaseNotesCommand", () => {
  let logged: string[];
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the newest entry and points at the full changelog", () => {
    const result = releaseNotesCommand.run("", {} as never);
    expect(result).toEqual({ handled: true });
    const out = logged.join("\n");
    expect(out).toContain("What's new");
    expect(out).toContain("CHANGELOG.md");
  });

  it("accepts `all` without throwing", () => {
    expect(() => releaseNotesCommand.run("all", {} as never)).not.toThrow();
    expect(logged.join("\n")).toContain("What's new");
  });
});
