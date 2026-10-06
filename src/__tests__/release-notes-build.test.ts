import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspace = fileURLToPath(new URL("../../", import.meta.url));

describe("release notes build gate", () => {
  it.each([
    { changelog: "## v1.0.0\nOld notes.", error: "Missing release notes" },
    { changelog: "## v1.6.1\n### Usage impact\n\n### Examples\nExample only.", error: "non-empty" },
    {
      changelog: "## v1.6.1\n### Usage impact\nValid.\n\n## v1.6.1\nDuplicate.",
      error: "Duplicate release notes",
    },
  ])("rejects $error before removing the previous artifact", ({ changelog, error }) => {
    const root = mkdtempSync(join(tmpdir(), "ccr-release-build-"));
    try {
      for (const folder of ["scripts", "src", "docs", "dist"]) mkdirSync(join(root, folder));
      copyFileSync(join(workspace, "scripts/build.mjs"), join(root, "scripts/build.mjs"));
      copyFileSync(join(workspace, "src/release-notes.ts"), join(root, "src/release-notes.ts"));
      symlinkSync(join(workspace, "node_modules"), join(root, "node_modules"), "junction");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ type: "module", version: "1.6.1" }),
      );
      writeFileSync(join(root, "docs/CHANGELOG.md"), changelog);
      writeFileSync(join(root, "dist/previous.txt"), "previous build");
      const result = spawnSync(process.execPath, [join(root, "scripts/build.mjs")], {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(readFileSync(join(root, "dist/previous.txt"), "utf8")).toBe("previous build");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
