import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ccrPath } from "./workspace-config.js";

export interface PermissionPolicyConfig {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

export interface PermissionPolicy {
  allow: string[];
  deny: string[];
  ask: string[];
}

const EMPTY: PermissionPolicy = { allow: [], deny: [], ask: [] };

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
}

export function parsePermissionPolicy(value: unknown): PermissionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY };
  const v = value as PermissionPolicyConfig;
  return { allow: list(v.allow), deny: list(v.deny), ask: list(v.ask) };
}

export function mergePermissionPolicies(...values: unknown[]): PermissionPolicy {
  const out: PermissionPolicy = { ...EMPTY };
  for (const value of values) {
    const p = parsePermissionPolicy(value);
    out.allow.push(...p.allow);
    out.deny.push(...p.deny);
    out.ask.push(...p.ask);
  }
  return out;
}

/** Match official-style names such as `Bash`, `Bash(git *)`, and `*`. */
export function permissionRuleMatches(
  rule: string,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const target =
    typeof input.command === "string"
      ? input.command
      : typeof input.filePath === "string"
        ? input.filePath
        : typeof input.url === "string"
          ? input.url
          : "";
  const actual = target ? `${toolName}(${target})` : toolName;
  const trimmed = rule.trim();
  if (trimmed === "*") return true;
  if (trimmed === toolName || trimmed === actual) return true;
  if (trimmed.endsWith("(*)") && trimmed.slice(0, -3) === toolName) return true;
  if (trimmed.endsWith("*") && actual.startsWith(trimmed.slice(0, -1))) return true;
  const wildcard = trimmed.match(/^([^()]+)\((.*)\*\)$/);
  if (wildcard && toolName === wildcard[1] && target.startsWith(wildcard[2] ?? "")) return true;
  return false;
}

export function policyDecision(
  policy: PermissionPolicy | undefined,
  toolName: string,
  input: Record<string, unknown>,
): "allow" | "deny" | "ask" | undefined {
  if (!policy) return undefined;
  if (policy.deny.some((r) => permissionRuleMatches(r, toolName, input))) return "deny";
  if (policy.ask.some((r) => permissionRuleMatches(r, toolName, input))) return "ask";
  if (policy.allow.some((r) => permissionRuleMatches(r, toolName, input))) return "allow";
  return undefined;
}

function storePath(): string {
  return process.env.CCR_PERMISSION_STORE || ccrPath(process.cwd(), "permissions.json");
}

export function loadPersistentAlwaysAllow(): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function savePersistentAlwaysAllow(values: ReadonlySet<string>): void {
  try {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...values].sort(), null, 2));
  } catch {
    // Best effort; inability to persist must not block a permitted operation.
  }
}
