// ============================================================
// Reasoning Effort — the /effort tiers (mirrors Claude Code)
// ============================================================
// Claude Code exposes a reasoning-effort slider that trades speed for depth:
//   low → medium → high → xhigh → max   (Faster ──▶ Smarter)
// plus a separate "ultracode" tier == xhigh reasoning + workflows.
//
// The tier is stored on `modelConfig.options.effort` and consumed by the
// provider adapters: the native Anthropic path passes it through as
// `output_config.effort`; OpenAI-compatible reasoning models map it to
// `reasoning_effort` (clamped to the values that API accepts).
// ============================================================

import chalk from "chalk";
import { isOpenAIReasoningModel } from "../model-metadata.js";

/** Ordered effort tiers, low (fastest) → max (smartest). */
export const EFFORT_GRADIENT = ["low", "medium", "high", "xhigh", "max"] as const;

/** All selectable tiers, including the special `ultracode`. */
export const EFFORT_LEVELS = [...EFFORT_GRADIENT, "ultracode"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Claude Code's default sits at `high`. */
export const DEFAULT_EFFORT: EffortLevel = "high";

export interface EffortDefinition {
  summary: string;
  definition: string;
  behavior: string;
  mapping: string;
}

/** Runtime knobs that make the product-level effort tiers observable even
 * when a provider only exposes low/medium/high reasoning. */
export interface EffortStrategy {
  /** Maximum output tokens allowed for one provider turn. */
  maxOutputTokens: number;
  /** Default temperature for non-reasoning chat models. */
  temperature: number;
  /** Parallel read-only tool calls allowed in one batch. */
  toolConcurrency: number;
  /** Whether speculative reads are worthwhile at this effort level. */
  speculation: boolean;
  /** Instruction injected into the model context for this turn. */
  instruction: string;
}

/** Product-level definition per tier; provider params may be less granular. */
export const EFFORT_DEFINITIONS: Record<EffortLevel, EffortDefinition> = {
  low: {
    summary: "Fastest responses, minimal reasoning",
    definition: "低努力：优先快速响应，只做必要推理，适合明确、局部、低风险任务。",
    behavior: "不主动扩展调查范围；偏向少量文件内的直接修改；遇到不确定性时尽快向用户暴露。",
    mapping: "Anthropic native: low；OpenAI-compatible reasoning_effort: low。",
  },
  medium: {
    summary: "Balanced speed and reasoning",
    definition: "中等努力：默认平衡速度和可靠性，适合常规编码、解释和小型排障。",
    behavior: "会做必要上下文核查；不会为低风险任务开启大范围搜索；实现前后做基本验证。",
    mapping: "Anthropic native: medium；OpenAI-compatible reasoning_effort: medium。",
  },
  high: {
    summary: "Thorough reasoning (default)",
    definition: "高努力：更重视正确性，适合跨文件变更、复杂 bug、架构影响较明显的任务。",
    behavior: "会更系统地阅读相关代码；优先补足边界条件；验证覆盖更完整。",
    mapping: "Anthropic native: high；OpenAI-compatible reasoning_effort: high。",
  },
  xhigh: {
    summary: "Extra reasoning for hard problems",
    definition: "超高努力：在 high 基础上增加更深入的因果分析与反例检查。",
    behavior: "会主动寻找隐藏约束、回归风险和替代路径；适合权限、持久化、并发、状态同步类改动。",
    mapping: "Anthropic native: xhigh（若支持）；OpenAI-compatible 参数层降级为 high。",
  },
  max: {
    summary: "Maximum reasoning, slowest",
    definition: "最大努力：单代理内的最高深度模式，适合尽量穷尽边界、严谨实现和完整验证。",
    behavior: "更倾向于先建计划、再实施、再验证；对安全、权限、数据删除类变更执行更严格检查。",
    mapping: "Anthropic native: max（若支持）；OpenAI-compatible 参数层降级为 high。",
  },
  ultracode: {
    summary: "xhigh + workflows (prefer multi-agent orchestration)",
    definition:
      "极限编排：不只是更高 reasoning，而是倾向于用多代理/工作流做广覆盖探索、设计、审查与反向验证。",
    behavior: "适合大型迁移、复杂审计、需要多视角验证的任务；代价是更慢、更耗 token。",
    mapping: "供应商 reasoning 参数按最高可用档处理；额外语义由本应用的 agent/workflow 策略承担。",
  },
};

const EFFORT_STRATEGIES: Record<EffortLevel, Omit<EffortStrategy, "instruction">> = {
  low: {
    maxOutputTokens: 4096,
    temperature: 0.2,
    toolConcurrency: 3,
    speculation: false,
  },
  medium: {
    maxOutputTokens: 6144,
    temperature: 0.1,
    toolConcurrency: 5,
    speculation: true,
  },
  high: {
    maxOutputTokens: 8192,
    temperature: 0.05,
    toolConcurrency: 8,
    speculation: true,
  },
  xhigh: {
    maxOutputTokens: 12_288,
    temperature: 0,
    toolConcurrency: 10,
    speculation: true,
  },
  max: {
    maxOutputTokens: 16_384,
    temperature: 0,
    toolConcurrency: 12,
    speculation: true,
  },
  ultracode: {
    maxOutputTokens: 24_576,
    temperature: 0,
    toolConcurrency: 16,
    speculation: true,
  },
};

/** The concrete model-facing contract for one effort tier. */
export function effortStrategy(level: EffortLevel): EffortStrategy {
  return {
    ...EFFORT_STRATEGIES[level],
    instruction: effortInstruction(level),
  };
}

/** Build a stable, explicit instruction so effort is not just a UI label. */
export function effortInstruction(level: EffortLevel): string {
  const def = EFFORT_DEFINITIONS[level];
  const workflow =
    level === "ultracode"
      ? "For substantial work, prefer the workflow tool to fan out independent exploration, implementation review, and verification workers before synthesizing."
      : level === "max" || level === "xhigh"
        ? "For difficult work, actively check alternative explanations, hidden constraints, and regression risks before concluding."
        : level === "high"
          ? "Read the relevant context before acting and verify the result, including important edge cases."
          : level === "medium"
            ? "Inspect the necessary context, make a focused change, and run a proportionate verification."
            : "Keep the investigation focused and make the smallest correct change; surface uncertainty quickly.";
  return [
    `[EFFORT MODE: ${level}]`,
    def.definition,
    workflow,
    `Do not claim work is complete until the ${level} effort level's checks have been performed.`,
  ].join("\n");
}

/** Read the active strategy from the live model config. */
export function getEffortStrategy(options?: Record<string, unknown>): EffortStrategy {
  return effortStrategy(getEffort(options));
}

/** Append the active effort contract to a model turn prompt. */
export function withEffortInstruction(
  systemPrompt: string,
  options?: Record<string, unknown>,
): string {
  // Forked agents inherit the already-enriched parent prompt. Keep that
  // prompt byte-identical so prompt-cache reuse and fork semantics survive.
  if (/\[EFFORT MODE:\s*[^\]]+\]/.test(systemPrompt)) return systemPrompt;
  return `${systemPrompt}\n\n${getEffortStrategy(options).instruction}`;
}

/**
 * Hard ceiling for an explicitly RAISED max-tokens override: 128K — the
 * streaming output cap of every current model family (Anthropic 1M-context
 * models stream to 128K; Haiku 4.5 caps at 64K, and the adapters additionally
 * clamp to the per-model maxOutput from model-metadata).
 */
export const STREAM_SAFE_MAX_OUTPUT_TOKENS = 131_072;

/**
 * Resolve the per-turn max output tokens. The tier default differentiates the
 * levels; an explicit LLM_MAX_TOKENS override is authoritative and may RAISE
 * the tier default as well as lower it (user decision 2026-09: streaming cap
 * 128K). The old Math.min(configured, tierMax) could only lower — with the
 * high tier's 8192 default, long outputs routinely hit the slow
 * truncate→continue path.
 */
export function resolveEffortMaxTokens(level: EffortLevel, configured?: number): number {
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(Math.floor(configured), STREAM_SAFE_MAX_OUTPUT_TOKENS));
  }
  return effortStrategy(level).maxOutputTokens;
}

/** One-line description per tier, mirroring the Claude Code slider semantics. */
export const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = Object.fromEntries(
  EFFORT_LEVELS.map((level) => [level, EFFORT_DEFINITIONS[level].summary]),
) as Record<EffortLevel, string>;

/** Narrow an arbitrary string to a valid tier, or null if unrecognized. */
export function parseEffort(value: string): EffortLevel | null {
  const v = value.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as EffortLevel) : null;
}

// --- Color helpers for the interactive slider (TUI) ---

/** Convert HSL (h∈[0,360), s/l∈[0,1]) to a #rrggbb hex string. */
export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Warm gradient color along the slider track: fraction 0 (Faster) is cool
 * cyan, fraction 1 (Smarter) is warm red. Higher effort = warmer.
 */
export function gradientColorAt(fraction: number): string {
  const f = Math.min(1, Math.max(0, fraction));
  return hslToHex(190 - 190 * f, 0.8, 0.6);
}

/**
 * A cycling rainbow palette of `count` colors, shifted by `phase` degrees.
 * Uses the official voice-waveform HSL params (s=0.7, l=0.6) so the max-tier
 * flow matches Claude Code's rainbow. Animating `phase` makes it flow.
 */
export function rainbowColors(count: number, phase = 0): string[] {
  const n = Math.max(1, count);
  return Array.from({ length: count }, (_, i) => hslToHex((i / n) * 360 + phase, 0.7, 0.6));
}

/** Read the active tier off a config's options bag (falls back to default). */
export function getEffort(options?: Record<string, unknown>): EffortLevel {
  const raw = options?.effort;
  return typeof raw === "string" && parseEffort(raw) ? (raw as EffortLevel) : DEFAULT_EFFORT;
}

/**
 * Map a tier to the native Anthropic `output_config.effort` value. The opus
 * models accept the full gradient; `ultracode` maps to `xhigh` per its
 * definition ("xhigh + workflows" — the workflow part is behavioral).
 */
export function anthropicEffort(effort: EffortLevel): string {
  return effort === "ultracode" ? "xhigh" : effort;
}

/**
 * Map a tier to an OpenAI-compatible `reasoning_effort`. That API only accepts
 * low/medium/high, so everything at or above `high` clamps to `high`.
 */
export function openaiReasoningEffort(effort: EffortLevel): "low" | "medium" | "high" {
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high";
}

/**
 * Heuristic: does this model honor `reasoning_effort`? Only reasoning-capable
 * models do; sending it to a plain chat model can 400 on strict providers.
 * The model-metadata table is consulted first (single source of truth); the
 * legacy regexes remain as the fallback for unlisted models.
 */
export function modelSupportsReasoningEffort(provider: string, model: string): boolean {
  if (isOpenAIReasoningModel(model)) return true;
  if (provider === "openai") {
    return /^(o\d|gpt-5|gpt-4\.\d-?(o|reason))/i.test(model) || /reason|think/i.test(model);
  }
  // DeepSeek reasoner, Qwen/GLM thinking variants, etc.
  return /reason|think|r1|qwq/i.test(model);
}

/**
 * Render the effort slider for the `/effort` command, marking the active tier.
 * Faithful to the Claude Code layout: gradient tiers, a `┆` divider, then the
 * special `ultracode` tier with its sub-label.
 */
export function renderEffortSlider(active: EffortLevel): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${chalk.bold("Effort")}`);
  lines.push("");

  const cells = EFFORT_GRADIENT.map((lvl) => {
    const label = lvl === active ? chalk.cyan.bold(lvl) : chalk.gray(lvl);
    return label.padEnd(lvl === active ? 8 : 8);
  });
  const ultra = active === "ultracode" ? chalk.cyan.bold("ultracode") : chalk.gray("ultracode");

  lines.push(`    ${chalk.dim("Faster")}${" ".repeat(28)}${chalk.dim("Smarter")}`);
  lines.push(`    ${cells.join("")}${chalk.dim("┆ ")}${ultra}`);

  // Marker row: a ▲ under the active gradient tier, or under ultracode.
  const markerCells = EFFORT_GRADIENT.map((lvl) => (lvl === active ? "▲" : " ").padEnd(8));
  const ultraMarker = active === "ultracode" ? "▲" : "";
  lines.push(`    ${markerCells.join("")}${chalk.dim("  ")}${ultraMarker}`);

  lines.push("");
  lines.push(`  Current: ${chalk.cyan(active)} — ${chalk.gray(EFFORT_DESCRIPTIONS[active])}`);
  return lines.join("\n");
}
