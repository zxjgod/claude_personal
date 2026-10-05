import { HookRegistry, mergeEventOutcomes, strongestPermissionDecision } from "./hooks.js";
import { parseHooksConfig, registerHooksFromConfig } from "./hooks-config.js";
import { mergePermissionPolicies, type PermissionPolicy } from "./permission-policy.js";
import type { SkillDefinition } from "./skills.js";
import type { HookRunner, ModelConfig } from "./types.js";

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
export function activateSkill(sessionId: string, skill: SkillDefinition): void {
  activations.set(sessionId, skill);
}
export function clearSkillActivation(sessionId: string): void {
  activations.delete(sessionId);
}
export function activeSkill(sessionId: string): SkillDefinition | undefined {
  return activations.get(sessionId);
}
export function activeSkillPolicy(
  sessionId: string,
  parent?: PermissionPolicy,
): PermissionPolicy | undefined {
  const skill = activeSkill(sessionId);
  if (!skill) return parent;
  return mergePermissionPolicies(parent, {
    allow: skill.toolPermissionGrant ? skill.allowedTools : [],
    deny: skill.disallowedTools,
  });
}
export function activeSkillModel(sessionId: string, parent: ModelConfig): ModelConfig {
  const skill = activeSkill(sessionId);
  if (!skill) return parent;
  return {
    ...parent,
    ...(skill.model && skill.model !== "inherit" ? { model: skill.model } : {}),
    ...(skill.effort ? { options: { ...parent.options, effort: skill.effort } } : {}),
  };
}
