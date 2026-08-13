// ============================================================
// Output Styles — named response-format presets (kernel §Output style)
// ============================================================
// Real Claude Code ships a set of output styles (default / explanatory /
// learning, plus user-defined ones) that reshape the model's response voice via
// a system-prompt section. This module is the registry of those presets; the
// active style is resolved into the "OUTPUT STYLE" section by system-prompt.ts
// and switched at runtime by the /output-style command.
//
// A style is pure text — no code. The prompt replaces the default concise
// "OUTPUT STYLE" block, so it stays inside the cacheable static prefix (the
// active style is fixed at session start; switching recomputes just that
// memoized section, keyed by style name).
// ============================================================

export interface OutputStyle {
  /** Kebab-case style name (e.g. "explanatory"). */
  name: string;
  /** One-line description shown by /output-style. */
  description: string;
  /** The "OUTPUT STYLE" section body injected into the system prompt. */
  prompt: string;
}

const DEFAULT_PROMPT = `- Be concise and direct. Get to the point quickly.
- Do not add narration inside code blocks just to explain what the code does.
- Use the following format when citing code:
  \`\`\`startLine:endLine:filepath
- Respond in the same language as the user's query.
  If the user writes in Chinese, respond in Chinese.
- Minimize output tokens while maintaining quality.`;

const BUILTIN_STYLES: OutputStyle[] = [
  { name: "default", description: "Concise, direct, minimal narration", prompt: DEFAULT_PROMPT },
  {
    name: "explanatory",
    description: "Explain reasoning and trade-offs behind each change",
    prompt: `- Explain your reasoning and the trade-offs behind each non-trivial decision.
- When you make a change, describe what you changed and why, in prose.
- Use the following format when citing code:
  \`\`\`startLine:endLine:filepath
- Respond in the same language as the user's query.
- Prefer clarity over brevity; err on the side of explaining.`,
  },
  {
    name: "learning",
    description: "Teach concepts and the 'why' as you work",
    prompt: `- This is a learning session. Explain concepts as you go, not just actions.
- Define jargon and acronyms the first time they appear.
- Summarize the "why" behind each step so the user can generalize.
- When you cite code, show the relevant snippet and explain it.
- Respond in the same language as the user's query.`,
  },
];

const STYLES = new Map<string, OutputStyle>();

let seeded = false;
function ensureSeeded(): void {
  if (seeded) return;
  for (const s of BUILTIN_STYLES) STYLES.set(s.name, s);
  seeded = true;
}

/** Register or override an output style. */
export function registerOutputStyle(style: OutputStyle): void {
  ensureSeeded();
  STYLES.set(style.name, style);
}

/** Look up a style by name; undefined when unknown. */
export function getOutputStyle(name: string): OutputStyle | undefined {
  ensureSeeded();
  return STYLES.get(name);
}

/** List all styles in registration order (built-ins first). */
export function listOutputStyles(): OutputStyle[] {
  ensureSeeded();
  return [...STYLES.values()];
}

/**
 * Resolve the "OUTPUT STYLE" section body for a style name. Unknown names fall
 * back to "default" so a stale config can't produce an empty section.
 */
export function outputStylePrompt(name: string | undefined): string {
  return getOutputStyle(name ?? "default")?.prompt ?? DEFAULT_PROMPT;
}

/** Test/util: clear the registry (including built-ins). */
export function resetOutputStyles(): void {
  STYLES.clear();
  seeded = false;
}
