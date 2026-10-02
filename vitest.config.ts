import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bound fork count: coverage plus ZIP/process fixtures can otherwise starve
    // short tests on Windows and consume memory proportional to CPU count.
    maxWorkers: 4,
    // Only run tests in src directory, exclude the reference implementation.
    // Includes TUI component tests (`.test.tsx`) — previously they were authored
    // but excluded from `npm test` because the include only matched `.test.ts`.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["claude-code-参考标准/**", "**/node_modules/**"],
    // 20s, not the 5s default. The TUI component tests drive real Ink render
    // loops on real timers (tui-components.test.tsx: ~14s for the file,
    // input-box.test.tsx: ~83s), so under parallel load a test whose own body
    // is ~20ms — e.g. the PgUp viewer test — can still be starved past a 5s
    // budget and fail as a timeout. 20s keeps that headroom while still
    // catching a genuine hang.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/__tests__/**",
        // Type-only declaration files carry no runtime code to cover.
        "src/types.ts",
        "src/**/*.d.ts",
      ],
      // Vitest 4 uses a different V8 remapper. Same-toolchain HEAD baseline
      // (2026-10-02): 70.56 statements / 61.83 branches / 74.38 functions /
      // 72.17 lines. Keep the previous ~3 point margin against this measured
      // baseline; the upgrade measured 70.71 / 61.49 / 74.43 / 72.46.
      // Evidence and migration rationale: docs/更新日志/20261002-comprehensive-upgrade.md.
      thresholds: {
        statements: 68,
        branches: 59,
        functions: 72,
        lines: 70,
      },
    },
  },
});
