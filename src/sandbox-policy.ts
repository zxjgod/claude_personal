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

/**
 * Normalize a command line for deny-matching. Quotes and the escape chars of
 * the host shells (`^` for cmd, backtick for PowerShell, `'` for bash) are
 * syntax noise that SPLIT a word for the parser — `c""url`, `c^u^rl`, `cu'rl'`
 * all run curl but evade a literal substring/word-boundary match. Stripping
 * them before matching closes that class of bypass at the cost of the odd
 * false deny, which is the right way to fail for a deny list.
 */
function normalizeForMatching(command: string): string {
  return command.replace(/["'^`]/g, "").toLowerCase();
}

/** Path-comparison normalizer: Windows paths are case-insensitive, POSIX ones
 *  are not (see normalizeForContainment in tools/utils/path.ts, same rule). */
function normalizePath(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export function sandboxViolation(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
): string | undefined {
  if (!policy.enabled) return undefined;
  const roots = policy.allowedDirectories ?? [cwd];
  const cwdN = normalizePath(path.resolve(cwd));
  if (
    !roots.some((root) => {
      const rootN = normalizePath(root);
      return cwdN === rootN || cwdN.startsWith(`${rootN}${path.sep}`);
    })
  )
    return `Sandbox denied working directory: ${cwd}`;
  const normalized = normalizeForMatching(command);
  if (policy.deniedCommands?.some((pattern) => normalized.includes(normalizeForMatching(pattern))))
    return "Sandbox denied command by policy.";
  if (
    policy.network === "deny" &&
    // The pattern list is a heuristic deny-list, not a capability boundary:
    // only the native runner (restricted token + job) provides real
    // enforcement, and it limits resources, not destinations. Beyond
    // curl/wget and the PowerShell web cmdlets, the list covers the package
    // managers whose install runs arbitrary code (npm i/ci — `i` is the
    // alias most one-liners use; pip3 is a separate word from pip and needs
    // its own `3?`; pnpm/yarn) and the classic certutil/bitsadmin download
    // vectors. Word boundaries keep `npm init` (i followed by n) passing.
    /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|scp|ftp|git\s+(clone|fetch|pull)|npm\s+(i|ci|install|publish)|pnpm\s+(i|add|install)|yarn\s+(add|install)|pip3?\s+install|certutil\s+[-/]urlcache|bitsadmin\s+[-/]transfer|Start-BitsTransfer)\b/i.test(
      normalized,
    )
  )
    return "Sandbox denied network access by policy.";
  return undefined;
}
