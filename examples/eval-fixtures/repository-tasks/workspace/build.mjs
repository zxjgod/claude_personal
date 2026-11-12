import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

try {
  const compiler = process.env.CCR_EVAL_TSC;
  if (!compiler) throw new Error("The evaluation runner must provide CCR_EVAL_TSC");
  const root = process.cwd();
  const output = resolve(root, "dist");
  if (dirname(output) !== root) throw new Error("Invalid build output");
  rmSync(output, { recursive: true, force: true });
  execFileSync(process.execPath, [compiler, "--project", "tsconfig.json"], {
    cwd: root, stdio: "inherit", windowsHide: true,
  });
  console.log("REPOSITORY_BUILD_PASSED");
} catch (error) {
  console.error(`REPOSITORY_BUILD_FAILED: ${error.message}`);
  process.exitCode = 1;
}
