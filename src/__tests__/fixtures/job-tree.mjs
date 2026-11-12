// Each role stays alive and owns the next role. The tests observe actual PIDs
// and file side effects instead of inferring process death from job status.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const [root, role] = process.argv.slice(2);
fs.writeFileSync(path.join(root, `${role}.pid`), String(process.pid));
console.log(`${role}:ready`);
console.error(`${role}:diagnostic`);
if (role !== "grandchild") {
  spawn(process.execPath, [fileURLToPath(import.meta.url), root, role === "parent" ? "child" : "grandchild"], {
    stdio: "inherit", windowsHide: true,
  });
}
setInterval(() => fs.appendFileSync(path.join(root, `${role}.beat`), "."), 40);
