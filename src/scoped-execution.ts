import * as nodePath from "node:path";
import { HookRegistry, mergeEventOutcomes, strongestPermissionDecision } from "./hooks.js";
import {
  describeHooksConfig,
  hooksConfigFingerprint,
  isHooksConfigTrusted,
  parseHooksConfig,
  registerHooksFromConfig,
  trustHooksConfig,
} from "./hooks-config.js";
import { mergePermissionPolicies, type PermissionPolicy } from "./permission-policy.js";
import type { SkillDefinition } from "./skills.js";
import type { AskUserFn, HookRunner, ModelConfig } from "./types.js";

export function scopedHooks(
  parent: HookRunner | undefined,
  hooks: unknown,
  sessionId: string,
  workspaceRoot: string,
): HookRunner | undefined {
  const registry = new HookRegistry();
  const count = registerHooksFromConfig(registry, parseHooksConfig({ hooks }), {
    sessionId,
    workspaceRoot,
  });
  if (!count) return parent;
  if (!parent) return registry;
  return {
    async runPre(payload) {
      const first = await parent.runPre(payload);
      if (first.block) return first;
      const second = await registry.runPre({ ...payload, input: first.input ?? payload.input });
      const merged = { ...first, ...second };
      // deny/ask are sticky across layers — an inner "allow" must not
      // override an outer layer's stronger decision.
      merged.permissionDecision = strongestPermissionDecision(
        first.permissionDecision,
        second.permissionDecision,
      );
      return merged;
    },
    async runPost(payload) {
      const first = await parent.runPost(payload);
      const second = await registry.runPost({ ...payload, result: first.result ?? payload.result });
      return { result: second.result ?? first.result };
    },
    async runStop(payload) {
      const first = await parent.runStop?.(payload);
      if (first?.blockingError || first?.preventContinuation) return first;
      return registry.runStop(payload);
    },
    async runEvent(event, payload) {
      const first = (await parent.runEvent?.(event, payload)) || undefined;
      if (first?.block) return first;
      const second = await registry.runEvent(event, payload);
      // mergeEventOutcomes keeps the STRONGEST permission decision across
      // layers — an inner "allow" must not override an outer deny/ask.
      const merged = mergeEventOutcomes(first, second);
      return {
        ...merged,
        additionalContext:
          [first?.additionalContext, second?.additionalContext].filter(Boolean).join("\n") ||
          undefined,
      };
    },
  };
}
const activations = new Map<string, SkillDefinition>();
/**
 * Skill activation is keyed by (sessionId, skillScopeId) — review fix
 * ("并行 Task 共享 session 级 Skill 状态"): a single sessionId key let one
 * parallel worker's activated skill rewrite the model/effort/hooks/permission
 * policy of its siblings and the parent mid-flight. The main loop uses scope
 * `undefined`; each typed sub-agent loop passes its own unique scope.
 */
function activationKey(sessionId: string, scopeId?: string): string {
  return scopeId ? `${sessionId}\u0000${scopeId}` : sessionId;
}
export function activateSkill(sessionId: string, skill: SkillDefinition, scopeId?: string): void {
  activations.set(activationKey(sessionId, scopeId), skill);
}
export function clearSkillActivation(sessionId: string, scopeId?: string): void {
  activations.delete(activationKey(sessionId, scopeId));
}
export function activeSkill(sessionId: string, scopeId?: string): SkillDefinition | undefined {
  return activations.get(activationKey(sessionId, scopeId));
}
export function activeSkillPolicy(
  sessionId: string,
  parent?: PermissionPolicy,
  scopeId?: string,
): PermissionPolicy | undefined {
  const skill = activeSkill(sessionId, scopeId);
  if (!skill) return parent;
  return mergePermissionPolicies(parent, {
    allow: skill.toolPermissionGrant ? skill.allowedTools : [],
    deny: skill.disallowedTools,
  });
}
export function activeSkillModel(
  sessionId: string,
  parent: ModelConfig,
  scopeId?: string,
): ModelConfig {
  const skill = activeSkill(sessionId, scopeId);
  if (!skill) return parent;
  return {
    ...parent,
    ...(skill.model && skill.model !== "inherit" ? { model: skill.model } : {}),
    ...(skill.effort ? { options: { ...parent.options, effort: skill.effort } } : {}),
  };
}

/**
 * Trust gate for a SUB-AGENT's frontmatter hooks (review fix "项目 agent 的
 * hooks 绕过信任门"): `.claude/agents/*.md` can declare command hooks, and
 * registering them unconditionally let repo content execute shell on the
 * agent's first tool call — the project-settings hooks fingerprint gate was
 * never consulted. User-scope agents (hooksTrusted) register directly;
 * project/plugin agents go through the same one-time fingerprint trust store
 * as project settings hooks, keyed `agent-hooks:<workspaceRoot>` —
 * workspace-scoped like the settings-hooks entries (self-review fix: keyed
 * by agent NAME alone, an approval collected in repo A auto-trusted the same
 * fingerprint in repo B).
 *
 * Fail-closed WITHOUT an approval channel (headless): the hooks are not
 * registered and a note explains why in the agent's system prompt.
 */
export async function prepareAgentHooks(
  type: { name: string; hooks?: unknown; hooksTrusted?: boolean },
  askUser: AskUserFn | undefined,
  workspaceRoot: string,
): Promise<{ hooksConfig?: unknown; note?: string }> {
  const hooks = type.hooks;
  if (hooks === undefined || hooks === null) return {};
  if (type.hooksTrusted) return { hooksConfig: hooks };
  const parsed = parseHooksConfig({ hooks });
  const descriptions = describeHooksConfig(parsed);
  if (descriptions.length === 0) return {};
  const root = nodePath.resolve(workspaceRoot);
  const trustKey = `agent-hooks:${process.platform === "win32" ? root.toLowerCase() : root}`;
  const fingerprint = hooksConfigFingerprint(parsed);
  if (isHooksConfigTrusted(trustKey, fingerprint)) return { hooksConfig: hooks };
  if (askUser) {
    const approved = await askUser(
      { name: "hooks" } as Parameters<AskUserFn>[0],
      { agent: type.name },
      `Sub-agent "${type.name}" declares command hooks (they run shell commands):\n` +
        `${descriptions.map((line) => `  ${line}`).join("\n")}\n` +
        `Trust them? (one-time per declaration content)`,
    );
    if (approved) {
      trustHooksConfig(trustKey, fingerprint);
      return { hooksConfig: hooks };
    }
    return {
      note: `Hooks declared by agent "${type.name}" were denied — they will NOT run for this agent.`,
    };
  }
  return {
    note:
      `Hooks declared by agent "${type.name}" are untrusted (project scope) and no approval ` +
      `channel is available — they will NOT run. Approve interactively once to enable them.`,
  };
}
