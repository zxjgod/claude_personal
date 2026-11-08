import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const python = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;

// The Python SDK has no vitest-native harness; run its self-contained unittest
// module (Node fixture CLI, no provider needed) and skip where Python is absent.
it.skipIf(!hasPython)(
  "python SDK passes its protocol unittest suite",
  async () => {
    const { stderr } = await execute(python, ["python/test_ccr_sdk.py"], {
      timeout: 60000,
      windowsHide: true,
    });
    expect(stderr).toMatch(/Ran 3 tests/);
    expect(stderr).toContain("OK");
  },
  60000,
);
