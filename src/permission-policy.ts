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

/**
 * Fresh empty policy. Deliberately a FACTORY, not a shared `{...EMPTY}`
 * template: a spread copies the array REFERENCES, so every consumer would
 * push into the same module-level arrays — rules silently accumulating
 * across mergePermissionPolicies calls (found via the A3 trust-gate tests:
 * one test's allow rules leaked into the next policy built).
 */
function emptyPolicy(): PermissionPolicy {
  return { allow: [], deny: [], ask: [] };
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
}

export function parsePermissionPolicy(value: unknown): PermissionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyPolicy();
  const v = value as PermissionPolicyConfig;
  return { allow: list(v.allow), deny: list(v.deny), ask: list(v.ask) };
}

export function mergePermissionPolicies(...values: unknown[]): PermissionPolicy {
  const out: PermissionPolicy = emptyPolicy();
  for (const value of values) {
    const p = parsePermissionPolicy(value);
    out.allow.push(...p.allow);
    out.deny.push(...p.deny);
    out.ask.push(...p.ask);
  }
  return out;
}

/**
 * Match official-style rules: `Bash`, `Bash(git *)`, `Bash(npm run:*)`, `*`.
 *
 * Review follow-up (既有问题 A): two silent-failure gaps closed —
 *  - Tool names compare CASE-INSENSITIVELY. Official-style rules are
 *    capitalized ("Bash", "Edit") while registry tool names are lowercase;
 *    the old strict === made every official-style deny rule a no-op.
 *  - The official colon-prefix form `Bash(npm run:*)` now matches commands
 *    starting with "npm run" at a WORD boundary (so `Bash(git:*)` does not
 *    also allow "github-cli …"). The old code compared against a literal
 *    "npm run:" prefix, which real commands never carry.
 * Trailing `*` inside the parens remains a plain prefix wildcard.
 */
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
  const trimmed = rule.trim();
  if (trimmed === "*") return true;
  const name = toolName.toLowerCase();
  // Split "Name(pattern)"; a rule without parens is a bare tool name.
  const m = /^([^(]*)\((.*)\)$/s.exec(trimmed);
  const ruleTool = (m ? m[1]! : trimmed).trim();
  if (!m) {
    if (ruleTool.endsWith("*")) return name.startsWith(ruleTool.slice(0, -1).toLowerCase());
    return ruleTool.toLowerCase() === name;
  }
  if (ruleTool.toLowerCase() !== name) return false;
  const pattern = m[2]!;
  if (pattern === "*") return true;
  // Official colon-prefix form: prefix match at a boundary. COMMAND rules
  // require a space after the prefix (`Bash(git:*)` must not also allow
  // "github-cli"). URL-shaped prefixes (scheme:// or a space-less token with
  // a dot, i.e. a host) additionally accept the hierarchical separators that
  // legitimately follow a host — "/", ":", "?", "#" — so `WebFetch(https://
  // evil.com:*)` matches "https://evil.com/x" instead of silently never
  // matching anything (fourth-round review).
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    if (target === prefix) return true;
    const urlIsh = prefix.includes("://") || (!prefix.includes(" ") && /\.[A-Za-z]/.test(prefix));
    if (urlIsh && !prefix.includes("://")) {
      // Bare-host rule (`WebFetch(domain.com:*)`): the target carries a
      // scheme, so compare against the URL's host part instead of a plain
      // prefix (which would never match "https://domain.com/a").
      const host = /^[a-zA-Z][\w+.-]*:\/\/([^/?#]+)/.exec(target)?.[1];
      return host === prefix;
    }
    if (!target.startsWith(prefix)) return false;
    if (prefix.endsWith(" ")) return true;
    const next = target[prefix.length];
    return prefix.includes("://") ? /[/:?#]/.test(next ?? "") : next === " ";
  }
  // Trailing-star wildcard: plain prefix match.
  if (pattern.endsWith("*")) return target.startsWith(pattern.slice(0, -1));
  return target === pattern;
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

/**
 * Does a deny rule hide the WHOLE tool, or only some of its calls?
 *
 * Only a bare tool name (`Bash`, `Edit`) or an explicit catch-all (`Bash(*)`,
 * `*`) removes the tool outright. A parameterized rule like `Bash(rm *)`
 * denies one shape of call, so the tool must stay visible — hiding it would
 * also take away `git status`, which the user never denied.
 */
function denyRuleHidesTool(rule: string, toolName: string): boolean {
  const trimmed = rule.trim();
  const name = toolName.toLowerCase();
  if (trimmed === "*") return true;
  const m = /^([^(]*)\((.*)\)$/s.exec(trimmed);
  if (!m) {
    // Bare name, optionally with a trailing-star prefix wildcard.
    if (trimmed.endsWith("*")) return name.startsWith(trimmed.slice(0, -1).toLowerCase());
    return trimmed.toLowerCase() === name;
  }
  if (m[1]!.trim().toLowerCase() !== name) return false;
  return m[2]!.trim() === "*";
}

/**
 * Should this tool be withheld from the model entirely?
 *
 * Deny rules gated EXECUTION only: the tool stayed in the request payload, so
 * the model kept seeing `bash`'s full schema and kept proposing calls that
 * were then refused. Hiding the tool is strictly better — the model stops
 * asking for a capability the operator removed.
 *
 * Deliberately NOT applied to `ask` rules (those must still be offered so the
 * user gets the prompt) and not to `allow` (additive, not restrictive).
 */
export function isToolHiddenByPolicy(
  policy: PermissionPolicy | undefined,
  toolName: string,
): boolean {
  if (!policy || policy.deny.length === 0) return false;
  return policy.deny.some((rule) => denyRuleHidesTool(rule, toolName));
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
