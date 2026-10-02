import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { userConfigRoot } from "./settings.js";

function storePath(): string {
  return (
    process.env.CCR_CONFIG_TRUST_STORE ||
    path.join(userConfigRoot(), "trusted-executable-configs.json")
  );
}
function fingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
export function isExecutableConfigTrusted(file: string, raw: string): boolean {
  try {
    return (
      JSON.parse(fs.readFileSync(storePath(), "utf8"))[path.resolve(file)] === fingerprint(raw)
    );
  } catch {
    return false;
  }
}
export async function confirmExecutableConfig(
  file: string,
  raw: string,
  confirm?: () => Promise<boolean>,
): Promise<boolean> {
  if (isExecutableConfigTrusted(file, raw)) return true;
  if (!confirm || !(await confirm())) return false;
  const store = storePath();
  fs.mkdirSync(path.dirname(store), { recursive: true });
  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(fs.readFileSync(store, "utf8"));
  } catch {
    /* new trust store */
  }
  const temp = `${store}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...existing, [path.resolve(file)]: fingerprint(raw) }));
  fs.renameSync(temp, store);
  return true;
}
