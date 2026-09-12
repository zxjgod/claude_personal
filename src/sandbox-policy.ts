import * as fs from "node:fs";
import * as path from "node:path";
import { ccrPath } from "./workspace-config.js";

export interface SandboxPolicy {
  enabled: boolean;
  network: "allow" | "deny";
  allowedDirectories?: string[];
  deniedCommands?: string[];
  native?: boolean;
}

const DEFAULT: SandboxPolicy = { enabled: false, network: "deny" };

export function loadSandboxPolicy(workspaceRoot: string): SandboxPolicy {
  try {
    const value = JSON.parse(
      fs.readFileSync(ccrPath(workspaceRoot, "sandbox.json"), "utf8"),
    ) as Partial<SandboxPolicy>;
    return {
      enabled: value.enabled === true,
      network: value.network === "allow" ? "allow" : "deny",
      allowedDirectories: Array.isArray(value.allowedDirectories)
        ? value.allowedDirectories
            .filter((x): x is string => typeof x === "string")
            .map((x) => path.resolve(workspaceRoot, x))
        : [workspaceRoot],
      deniedCommands: Array.isArray(value.deniedCommands)
        ? value.deniedCommands.filter((x): x is string => typeof x === "string")
        : [],
      native: value.native === true,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function requiresNativeSandbox(policy: SandboxPolicy): boolean {
  return policy.enabled && policy.native === true;
}
export function nativeSandboxSupported(): boolean {
  return process.platform === "win32";
}

export function sandboxViolation(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
): string | undefined {
  if (!policy.enabled) return undefined;
  const roots = policy.allowedDirectories ?? [cwd];
  if (!roots.some((root) => cwd === root || cwd.startsWith(`${root}${path.sep}`)))
    return `Sandbox denied working directory: ${cwd}`;
  if (
    policy.deniedCommands?.some((pattern) => command.toLowerCase().includes(pattern.toLowerCase()))
  )
    return "Sandbox denied command by policy.";
  if (
    policy.network === "deny" &&
    /\b(curl|wget|Invoke-WebRequest|iwr|git\s+(clone|fetch|pull)|npm\s+(install|publish)|pip\s+install)\b/i.test(
      command,
    )
  )
    return "Sandbox denied network access by policy.";
  return undefined;
}
