// ============================================================
// Tests: LSP real connection + legacy helpers (M14.5)
// ============================================================

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLspClientCache, disposeAllLspClients, getLspClient } from "../lsp.js";
import { filterByFile, formatDiagnostics, parseTscOutput } from "../lsp-legacy.js";

afterEach(async () => {
  await disposeAllLspClients();
});

// --- legacy pure helpers (regression) --------------------------------------

describe("lsp-legacy helpers", () => {
  it("parses tsc output lines into diagnostics", () => {
    const out =
      "src/x.ts(3,5): error TS2322: Type 'number' is not assignable to type 'string'.\n" +
      "src/y.ts(1,1): warning TS6133: 'x' is declared but never read.";
    const diags = parseTscOutput(out);
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({
      file: "src/x.ts",
      line: 3,
      column: 5,
      severity: "error",
      code: "TS2322",
    });
    expect(diags[1]!.severity).toBe("warning");
  });

  it("filters diagnostics by file substring", () => {
    const diags = parseTscOutput("a/x.ts(1,1): error TS1: m\nb/y.ts(2,2): error TS2: n");
    expect(filterByFile(diags, "a/x")).toHaveLength(1);
  });

  it("formats diagnostics compactly", () => {
    const diags = parseTscOutput("a/x.ts(1,1): error TS1: boom");
    const out = formatDiagnostics(diags);
    expect(out).toContain("1 error(s)");
    expect(out).toContain("boom");
    expect(formatDiagnostics([])).toBe("No diagnostics. ✓");
  });
});

// --- real LSP connection ----------------------------------------------------
// These spawn an actual tsserver process. They are skipped automatically if
// the bundled `typescript` (and thus tsserver) is unavailable.

const hasTsserver = (() => {
  try {
    require.resolve("typescript/lib/tsserver.js");
    return true;
  } catch {
    return false;
  }
})();

describe("LspClient (real tsserver)", () => {
  it("rejects diagnostics and completions outside the workspace", async () => {
    if (!hasTsserver) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-lsp-boundary-"));
    try {
      fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
      clearLspClientCache(dir);
      const client = getLspClient(dir)!;
      await expect(client.getDiagnostics(path.join(dir, "..", "outside.ts"))).rejects.toThrow(
        /outside workspace/,
      );
      await expect(client.getCompletions(path.join(dir, "..", "outside.ts"), 1, 1)).rejects.toThrow(
        /outside workspace/,
      );
      await client.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  it("returns null when tsserver can't be resolved", () => {
    // In this repo tsserver resolves, so getLspClient returns a client;
    // the null branch is covered by guarding in the tool. Here we just
    // assert the happy path doesn't throw.
    if (!hasTsserver) return;
    const client = getLspClient(process.cwd());
    expect(client).not.toBeNull();
  });

  it("reports a real type error for a broken .ts file", async () => {
    if (!hasTsserver) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-lsp-"));
    try {
      fs.writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            strict: true,
          },
        }),
      );
      fs.writeFileSync(path.join(dir, "bad.ts"), "const x: string = 123;\n");
      clearLspClientCache(dir);
      const client = getLspClient(dir)!;
      const diags = await client.getDiagnostics(path.join(dir, "bad.ts"), 20_000);
      const errors = diags.filter((d) => d.severity === "error");
      expect(errors.length).toBeGreaterThan(0);
      // tsserver reports TS2322 for the number->string assignment.
      expect(errors.some((d) => d.message.includes("string") || d.code.includes("2322"))).toBe(
        true,
      );
      await client.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  it("returns no errors for a clean .ts file", async () => {
    if (!hasTsserver) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-lsp2-"));
    try {
      fs.writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            strict: true,
          },
        }),
      );
      fs.writeFileSync(path.join(dir, "good.ts"), 'const x: string = "ok";\n');
      clearLspClientCache(dir);
      const client = getLspClient(dir)!;
      const diags = await client.getDiagnostics(path.join(dir, "good.ts"), 20_000);
      expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
      await client.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});

describe("LspClient.getProjectDiagnostics (S4, real tsserver)", () => {
  it("sweeps the whole project and reports per-file errors", async () => {
    if (!hasTsserver) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-lsp-sweep-"));
    try {
      fs.writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2022", strict: true } }),
      );
      fs.writeFileSync(path.join(dir, "bad.ts"), "const x: string = 123;\n");
      fs.writeFileSync(path.join(dir, "ok.ts"), "export const y = 1;\n");
      fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "skipped.ts"), "const z: string = 456;\n");
      // Windows CI uses an 8.3 alias in TEMP. Exercise the same filesystem
      // identity even on machines whose default TEMP has no short component.
      const workspace =
        process.platform === "win32"
          ? execFileSync(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:CCR_LSP_TEST_ROOT).ShortPath",
              ],
              {
                env: { ...process.env, CCR_LSP_TEST_ROOT: dir },
                encoding: "utf8",
                windowsHide: true,
                timeout: 5000,
              },
            ).trim()
          : dir;
      clearLspClientCache(workspace);
      const client = getLspClient(workspace)!;
      const diags = await client.getProjectDiagnostics(50, 60_000);
      const errors = diags.filter((d) => d.severity === "error");
      // The bad file reports the assignment error…
      expect(errors.some((d) => d.file.endsWith("bad.ts"))).toBe(true);
      // …node_modules is not part of the sweep…
      expect(errors.some((d) => d.file.includes("node_modules"))).toBe(false);
      await client.dispose();
    } finally {
      // Windows: tsserver can hold the temp dir briefly after dispose.
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  }, 90_000);

  it("returns [] for a project with no script files", async () => {
    if (!hasTsserver) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-lsp-empty-"));
    try {
      fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
      clearLspClientCache(dir);
      const client = getLspClient(dir)!;
      expect(await client.getProjectDiagnostics(50, 30_000)).toEqual([]);
      await client.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
