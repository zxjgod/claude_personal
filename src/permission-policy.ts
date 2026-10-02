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
const TOOL_ALIASES: Record<string, string> = {
  webfetch: "web_fetch",
  websearch: "web_search",
  askuserquestion: "ask_user_question",
  enterplanmode: "enter_plan_mode",
  exitplanmode: "exit_plan_mode",
  notebookedit: "notebook_edit",
  multiedit: "multi_edit",
  enterworktree: "enter_worktree",
  exitworktree: "exit_worktree",
  joboutput: "job_output",
  jobkill: "job_kill",
  joblist: "job_list",
};
function canonicalToolName(value: string): string {
  const name = value.trim().toLowerCase();
  return TOOL_ALIASES[name] ?? name;
}
function urlRuleMatches(pattern: string, target: string): boolean {
  const mode = pattern.endsWith(":*") ? "boundary" : pattern.endsWith("*") ? "prefix" : "exact";
  const prefix =
    mode === "boundary" ? pattern.slice(0, -2) : mode === "prefix" ? pattern.slice(0, -1) : pattern;
  const absolute = /^[a-z][\w+.-]*:\/\//i.test(prefix);
  try {
    const actual = new URL(target);
    const expected = new URL(absolute ? prefix : `https://${prefix}`);
    if (expected.username || expected.password) return false;
    if (absolute && actual.protocol !== expected.protocol) return false;
    if (actual.hostname.replace(/\.$/, "") !== expected.hostname.replace(/\.$/, "")) return false;
    const authority = absolute ? (prefix.split("://")[1]?.split(/[/?#]/)[0] ?? "") : prefix;
    const explicitPort = /:(\d+)$/.exec(authority)?.[1];
    const actualPort =
      actual.port ||
      (actual.protocol === "https:" ? "443" : actual.protocol === "http:" ? "80" : "");
    if (explicitPort && Number(actualPort) !== Number(explicitPort)) return false;
    if (!absolute)
      return (
        mode === "boundary" &&
        expected.pathname === "/" &&
        !expected.search &&
        !expected.hash &&
        !prefix.endsWith(":")
      );
    if (
      mode === "exact" &&
      actualPort !==
        (expected.port ||
          (expected.protocol === "https:" ? "443" : expected.protocol === "http:" ? "80" : ""))
    )
      return false;
    const expectedPath = `${expected.pathname}${expected.search}${expected.hash}`;
    const actualPath = `${actual.pathname}${actual.search}${actual.hash}`;
    if (mode === "exact") return actualPath === expectedPath;
    if (mode === "prefix") return actualPath.startsWith(expectedPath);
    return (
      actualPath === expectedPath ||
      (actualPath.startsWith(expectedPath) &&
        (expectedPath.endsWith("/") || /[/?#]/.test(actualPath[expectedPath.length] ?? "")))
    );
  } catch {
    return false;
  }
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
  return {
    allow: [...new Set(out.allow)],
    deny: [...new Set(out.deny)],
    ask: [...new Set(out.ask)],
  };
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
  const name = canonicalToolName(toolName);
  // Split "Name(pattern)"; a rule without parens is a bare tool name.
  const m = /^([^(]*)\((.*)\)$/s.exec(trimmed);
  const ruleTool = (m ? m[1]! : trimmed).trim();
  if (!m) {
    if (ruleTool.endsWith("*")) return name.startsWith(canonicalToolName(ruleTool.slice(0, -1)));
    return canonicalToolName(ruleTool) === name;
  }
  if (canonicalToolName(ruleTool) !== name) return false;
  const pattern = m[2]!;
  if (pattern === "*") return true;
  if (typeof input.url === "string" && target === input.url) return urlRuleMatches(pattern, target);
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
      try {
        const url = new URL(target);
        const expected = new URL(`https://${prefix}`);
        if (
          expected.pathname !== "/" ||
          expected.search ||
          expected.hash ||
          expected.username ||
          expected.password ||
          prefix.endsWith(":")
        )
          return false;
        const explicitPort = /:(\d+)$/.exec(prefix)?.[1];
        const actualPort =
          url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
        return (
          url.hostname.replace(/\.$/, "") === expected.hostname.replace(/\.$/, "") &&
          (!explicitPort || Number(actualPort) === Number(explicitPort))
        );
      } catch {
        return false;
      }
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
  const name = canonicalToolName(toolName);
  if (trimmed === "*") return true;
  const m = /^([^(]*)\((.*)\)$/s.exec(trimmed);
  if (!m) {
    // Bare name, optionally with a trailing-star prefix wildcard.
    if (trimmed.endsWith("*")) return name.startsWith(canonicalToolName(trimmed.slice(0, -1)));
    return canonicalToolName(trimmed) === name;
  }
  if (canonicalToolName(m[1]!) !== name) return false;
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
