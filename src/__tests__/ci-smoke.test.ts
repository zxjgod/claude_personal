// ============================================================
// Tests: CI wires the production smoke check (M21.6)
// ============================================================
// M20 added scripts/smoke.mjs and a CI step that runs it. M21.6 pins that
// wiring so it can't silently regress: the smoke script must exist, package.json
// must expose it, and the GitHub Actions workflow must run the full gate
// (typecheck → lint/format → tests → smoke) on push/PR to main.
//
// These read the real repo files; they are regression guards, not behavior
// tests, so they stay fast and need no build.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readRoot(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

describe("smoke script wiring", () => {
  it("scripts/smoke.mjs exists", () => {
    expect(fs.existsSync(path.join(ROOT, "scripts", "smoke.mjs"))).toBe(true);
  });

  it("package.json exposes the smoke + quality scripts", () => {
    const pkg = JSON.parse(readRoot("package.json"));
    expect(pkg.scripts.smoke).toBe("node scripts/smoke.mjs");
    expect(pkg.scripts.typecheck).toContain("tsc");
    expect(pkg.scripts.test).toContain("vitest");
    expect(pkg.scripts.check).toContain("biome");
  });

  it("the smoke script builds first and exercises the no-API-key path", () => {
    const smoke = readRoot(path.join("scripts", "smoke.mjs"));
    // It must run a build and the API-key-free graceful-exit path.
    expect(smoke).toMatch(/build/i);
    expect(smoke).toContain("LLM_API_KEY");
    expect(smoke).toMatch(/--version|--help/);
  });
});

describe("GitHub Actions CI gate", () => {
  const ci = readRoot(path.join(".github", "workflows", "ci.yml"));

  it("triggers on push and pull_request to main", () => {
    expect(ci).toMatch(/on:/);
    expect(ci).toMatch(/push:/);
    expect(ci).toMatch(/pull_request:/);
    expect(ci).toMatch(/branches:\s*\[main\]/);
  });

  it("runs the full quality gate including smoke", () => {
    expect(ci).toContain("npm run typecheck");
    expect(ci).toContain("npm run check");
    expect(ci).toContain("npm test");
    expect(ci).toContain("npm run smoke");
  });

  it("runs smoke after the unit tests (build/start/exit is the last gate)", () => {
    expect(ci.indexOf("npm run smoke")).toBeGreaterThan(ci.indexOf("npm test"));
  });
});
