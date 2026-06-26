// ============================================================
// Skill Registry — discoverable, loadable skills (M13.3 / M14.2)
// ============================================================
// A "skill" is a named, reusable prompt+behavior bundle the model can invoke
// via the Skill tool (M14.2). This module is the registry the /skills command
// reads and that SkillTool will resolve against. Built-in skills ship here;
// extensions register their own via registerSkill.
//
// For now this is the registry surface only — execution lands with the
// SkillTool in M14.2. /skills lists what's available so users see the
// catalog before the tool exists.
// ============================================================

export interface SkillInfo {
  /** Unique kebab-case skill name, e.g. "deep-research". */
  name: string;
  /** One-line description shown in /skills and the Skill tool prompt. */
  description: string;
  /** Optional grouping label for the catalog (e.g. "Research", "Review"). */
  group?: string;
}

/** A registered skill, including the prompt the Skill tool will expand. */
export interface Skill extends SkillInfo {
  /** The instruction text injected when this skill is invoked. */
  prompt: string;
}

const SKILLS = new Map<string, Skill>();

/** Built-in skills seeded at first import. */
const BUILTIN_SKILLS: Skill[] = [
  {
    name: "deep-research",
    description: "Fan out web searches, verify claims, synthesize a cited report",
    group: "Research",
    prompt:
      "Run a deep-research harness: fan out web searches across sources, fetch and read them, adversarially verify the key claims, and synthesize a cited report.",
  },
  {
    name: "code-review",
    description: "Review the current diff for bugs and cleanups at a given effort",
    group: "Review",
    prompt:
      "Review the current git diff for correctness bugs and reuse/simplification/efficiency cleanups. Report findings with file:line references.",
  },
  {
    name: "security-review",
    description: "Security review of the pending changes on this branch",
    group: "Review",
    prompt:
      "Perform a security review of the pending changes on the current branch. Flag injection, auth, path-traversal, and secret-handling issues with file:line evidence.",
  },
  {
    name: "verify",
    description: "Run the app and observe behavior to confirm a change works",
    group: "Testing",
    prompt:
      "Verify that a code change does what it should by building/running the app and observing its behavior. Report pass/fail with evidence.",
  },
];

let seeded = false;
function ensureSeeded(): void {
  if (seeded) return;
  for (const s of BUILTIN_SKILLS) SKILLS.set(s.name, s);
  seeded = true;
}

/** Register or override a skill. */
export function registerSkill(skill: Skill): void {
  ensureSeeded();
  SKILLS.set(skill.name, skill);
}

/** Look up a skill by name. */
export function getSkill(name: string): Skill | undefined {
  ensureSeeded();
  return SKILLS.get(name);
}

/** List registered skills as catalog entries (without the prompt bodies). */
export function listSkills(): SkillInfo[] {
  ensureSeeded();
  return [...SKILLS.values()].map(({ name, description, group }) => ({
    name,
    description,
    group,
  }));
}

/** Test/util: clear the registry (including built-ins). */
export function resetSkills(): void {
  SKILLS.clear();
  seeded = false;
}
