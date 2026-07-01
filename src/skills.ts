// ============================================================
// Skill Registry — pillar 7 (M13.3 / M14.2 / M37)
// ============================================================
// A "skill" is a named, reusable prompt template the model invokes via the
// Skill tool. It is NOT code — it is a Command(type:'prompt') whose body is
// injected into the conversation when called. Three kernel design points
// (kernel §Skill):
//
//   1. Discovery is cheap, loading is expensive. Only name + (truncated)
//      description + whenToUse participate in matching; they're budgeted to
//      ~1% of the context window. The full body loads only at the moment of
//      invocation, via getPromptForCommand().
//   2. Three sources, one registry: builtin (compiled in), disk (user/project
//      <name>/SKILL.md), MCP (remote). Disk/builtin are TRUSTED — their bodies
//      may run `!`shell`` expansion. MCP is UNTRUSTED — shell is disabled.
//   3. Dispatched through one Skill tool, not special-cased in the model layer.
//      The user's `/<name>` is just sugar that expands to the same prompt
//      Command (see handleSlashCommand).
//
// Back-compat: the old `Skill { name, description, prompt }` shape still
// registers and resolves — `prompt` becomes a trivial getPromptForCommand.
// ============================================================

/** Where a skill came from. Governs trust (shell expansion) on its body. */
export type SkillSource = "builtin" | "disk" | "mcp";

/** How a skill's body runs once invoked. */
export type SkillContext = "inline" | "fork";

/** Context passed to a skill body when it is expanded (kernel: getPromptForCommand). */
export interface SkillPromptContext {
  /** Raw argument string the caller passed (e.g. /name <args> or tool args). */
  args?: string;
  /** Workspace root, for ${WORKSPACE} and trusted shell cwd. */
  workspaceRoot?: string;
}

/**
 * The fields that participate in discovery/matching. Cheap — these are all the
 * model sees until a skill is actually invoked.
 */
export interface SkillInfo {
  /** Unique kebab-case skill name, e.g. "deep-research". */
  name: string;
  /** One-line description shown in /skills and the Skill tool prompt. */
  description: string;
  /** Optional grouping label for the catalog (e.g. "Research", "Review"). */
  group?: string;
  /**
   * When the model should reach for this skill (kernel §7). Phrased as the
   * triggering situation. Optional; participates in matching when present.
   */
  whenToUse?: string;
  /** Where the skill came from — governs trust. Defaults to "builtin". */
  source?: SkillSource;
}

/**
 * A fully registered skill. The body (`getPromptForCommand`) is lazy: it is
 * only called at invocation, so an expensive template / shell expansion never
 * runs during discovery.
 */
export interface SkillDefinition extends SkillInfo {
  /**
   * Lazily produce the prompt body to inject. Called once, at invocation.
   * Async so disk/MCP/shell-backed bodies can do I/O here (never at discovery).
   */
  getPromptForCommand(ctx: SkillPromptContext): Promise<string>;
  /** inline = inject into this conversation; fork = run in a sub-agent. */
  context?: SkillContext;
  /** Sub-agent type to run when context==="fork" (falls back to general-purpose). */
  agent?: string;
  /** Restrict the (fork) sub-agent to these core tools by name. */
  allowedTools?: string[];
}

/**
 * Legacy registration shape: a skill with a static inline `prompt` string.
 * Still accepted by registerSkill and resolved like any other skill.
 */
export interface Skill extends SkillInfo {
  /** The instruction text injected when this skill is invoked. */
  prompt: string;
}

const SKILLS = new Map<string, SkillDefinition>();

/** Normalize a legacy `Skill` (static prompt) into a SkillDefinition. */
function fromLegacy(skill: Skill): SkillDefinition {
  const { prompt, ...info } = skill;
  return {
    ...info,
    source: info.source ?? "builtin",
    getPromptForCommand: async () => prompt,
  };
}

/** Built-in skills seeded at first import. */
const BUILTIN_SKILLS: Skill[] = [
  {
    name: "deep-research",
    description: "Fan out web searches, verify claims, synthesize a cited report",
    group: "Research",
    whenToUse: "When a question needs evidence from multiple sources, cross-checked and cited.",
    prompt:
      "Run a deep-research harness: fan out web searches across sources, fetch and read them, adversarially verify the key claims, and synthesize a cited report.",
  },
  {
    name: "code-review",
    description: "Review the current diff for bugs and cleanups at a given effort",
    group: "Review",
    whenToUse: "When you have pending changes and want a correctness + cleanup pass before commit.",
    prompt:
      "Review the current git diff for correctness bugs and reuse/simplification/efficiency cleanups. Report findings with file:line references.",
  },
  {
    name: "security-review",
    description: "Security review of the pending changes on this branch",
    group: "Review",
    whenToUse: "When changes touch auth, input handling, paths, secrets, or external I/O.",
    prompt:
      "Perform a security review of the pending changes on the current branch. Flag injection, auth, path-traversal, and secret-handling issues with file:line evidence.",
  },
  {
    name: "verify",
    description: "Run the app and observe behavior to confirm a change works",
    group: "Testing",
    whenToUse:
      "When a change is done and you want to confirm it works by running it, not guessing.",
    prompt:
      "Verify that a code change does what it should by building/running the app and observing its behavior. Report pass/fail with evidence.",
  },
];

let seeded = false;
function ensureSeeded(): void {
  if (seeded) return;
  for (const s of BUILTIN_SKILLS) SKILLS.set(s.name, fromLegacy(s));
  seeded = true;
}

/**
 * Register or override a skill. Accepts either the rich SkillDefinition or the
 * legacy `{ ..., prompt }` shape (normalized to a trivial lazy body).
 */
export function registerSkill(skill: SkillDefinition | Skill): void {
  ensureSeeded();
  const def: SkillDefinition =
    "prompt" in skill && typeof (skill as Skill).prompt === "string"
      ? fromLegacy(skill as Skill)
      : { source: "builtin", ...(skill as SkillDefinition) };
  SKILLS.set(def.name, def);
}

/** Look up a skill by name. */
export function getSkill(name: string): SkillDefinition | undefined {
  ensureSeeded();
  return SKILLS.get(name);
}

/** List registered skills as catalog entries (discovery fields only). */
export function listSkills(): SkillInfo[] {
  ensureSeeded();
  return [...SKILLS.values()].map(({ name, description, group, whenToUse, source }) => ({
    name,
    description,
    group,
    whenToUse,
    source,
  }));
}

/**
 * Resolve a skill's body at invocation (kernel: loading is expensive, done
 * once, here). Returns the prompt text plus a trailing Arguments line when
 * args are present (preserves the M14 SkillTool output contract).
 */
export async function resolveSkillPrompt(
  skill: SkillDefinition,
  ctx: SkillPromptContext = {},
): Promise<string> {
  const body = await skill.getPromptForCommand(ctx);
  const argsLine = ctx.args?.trim() ? `\n\nArguments: ${ctx.args}` : "";
  return body + argsLine;
}

// ============================================================
// Discovery budget (kernel §Skill point 1: ~1% of the context window)
// ============================================================
// The skill catalog the model sees is capped so a large skill library can't
// crowd out the conversation. We budget in characters (≈ chars/4 tokens) at a
// default 1% of a 200k-token window. Skills are listed in registry order until
// the budget is spent; the rest are summarized as an overflow count.

/** Default context window (tokens) the 1% discovery budget is taken from. */
export const DEFAULT_SKILL_DISCOVERY_WINDOW = 200_000;
/** Fraction of the context window the skill catalog may occupy. */
export const SKILL_DISCOVERY_FRACTION = 0.01;

/** One catalog line: name + truncated description (+ whenToUse when it fits). */
function catalogLine(s: SkillInfo): string {
  const desc = s.description.length > 100 ? `${s.description.slice(0, 97)}...` : s.description;
  const when = s.whenToUse ? ` — use when: ${s.whenToUse}` : "";
  return `- ${s.name}: ${desc}${when}`;
}

/**
 * Render the skill catalog within the discovery budget. Returns the lines that
 * fit (cheap fields only — never a body) plus how many skills were omitted.
 * Budget is in characters: window tokens × fraction × ~4 chars/token.
 */
export function renderSkillCatalog(windowTokens: number = DEFAULT_SKILL_DISCOVERY_WINDOW): {
  text: string;
  shown: number;
  omitted: number;
} {
  const all = listSkills();
  const budgetChars = Math.floor(windowTokens * SKILL_DISCOVERY_FRACTION * 4);
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const s of all) {
    const line = catalogLine(s);
    // +1 for the newline join. Always allow at least one line through.
    const cost = line.length + 1;
    if (shown > 0 && used + cost > budgetChars) break;
    lines.push(line);
    used += cost;
    shown++;
  }
  const omitted = all.length - shown;
  const text = omitted > 0 ? `${lines.join("\n")}\n- …and ${omitted} more` : lines.join("\n");
  return { text, shown, omitted };
}

/** Test/util: clear the registry (including built-ins). */
export function resetSkills(): void {
  SKILLS.clear();
  seeded = false;
}
