import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run tests in src directory, exclude the reference implementation.
    // Includes TUI component tests (`.test.tsx`) — previously they were authored
    // but excluded from `npm test` because the include only matched `.test.ts`.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["claude-code-参考标准/**", "**/node_modules/**"],
  },
});
