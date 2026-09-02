import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run tests in src directory, exclude the reference implementation.
    // Includes TUI component tests (`.test.tsx`) — previously they were authored
    // but excluded from `npm test` because the include only matched `.test.ts`.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["claude-code-参考标准/**", "**/node_modules/**"],
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
