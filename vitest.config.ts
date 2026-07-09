import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run tests in src directory, exclude the reference implementation
    include: ["src/**/*.test.ts"],
    exclude: ["claude-code-参考标准/**", "**/node_modules/**"],
  },
});
