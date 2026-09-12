import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
      // Thresholds are pinned ~3 points below the measured baseline (2026-09-02
      // full-suite run: stmts 78.5 / branches 77.5 / funcs 81.2 / lines 78.5)
      // so the gate catches regressions without flaky failures. Raise them as
      // coverage improves.
      thresholds: {
        statements: 75,
        branches: 74,
        functions: 78,
        lines: 75,
      },
    },
  },
});
