// ============================================================
// Disk Skill Source — load <name>/SKILL.md (kernel §Skill point 2, M37)
// ============================================================
// Scans user (~/.claude/skills) and project (<root>/.claude/skills) skill
// directories. Each skill is a folder containing a SKILL.md:
//
//   ---
//   name: release-notes
//   description: Draft release notes from the git log
//   whenToUse: When cutting a release and you need notes from recent commits.
//   context: inline            # or fork
//   agent: general-purpose     # only meaningful with context: fork
//   allowedTools: [read, grep] # restrict the fork sub-agent
//   ---
//   Draft release notes from these commits:
//   !`git log --oneline -20`
//   Focus area: ${ARGUMENTS}
//
// frontmatter → SkillInfo/config; the body is a lazy template. At invocation
// (NOT discovery) the body is expanded:
//   - ${ARGUMENTS} / ${ARGS}     → the caller's argument string
//   - ${WORKSPACE}               → workspace root
//   - ${ENV_NAME}                → process.env.ENV_NAME (when set)
//   - !`shell command`           → command stdout (see trust note below)
//
// Trust policy (user decision 2026-09, install-is-trust): ALL disk templates —
// project, user and plugin — expand shell commands and environment values.
// Installing/creating a skill vouches for it. The trustedShell gate in
// disk-template.ts remains as defense-in-depth and a future policy hook
// (callers can still pass trustedShell:false explicitly).
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSkill, type SkillContext, type SkillDefinition } from "../skills.js";
import { expandDiskTemplate } from "../utils/disk-template.js";
import { type ParsedFrontmatter, parseFrontmatter } from "../utils/frontmatter.js";
import { ccrPath } from "../workspace-config.js";

// Back-compat alias: the shared parser was previously defined in this module.
export { parseFrontmatter };
export type ParsedSkillFile = ParsedFrontmatter;

/** Reject a skill directory name that would escape the skills root. */
function isSafeSkillName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name !== "." && name !== "..";
}

/** User-scope skills root can be redirected for tests / sandboxes. */
const USER_SKILLS_ENV = "CCR_USER_SKILLS_DIR";

/** Roots scanned for disk skills, lowest → highest precedence (project wins). */
export function skillDirRoots(workspaceRoot: string): string[] {
  const roots = [ccrPath(workspaceRoot, "skills")];
  if (process.env[USER_SKILLS_ENV]) roots.unshift(process.env[USER_SKILLS_ENV]!);
  return roots;
}

function asString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(", ") : v;
}

function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v)
    ? v
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Expand a disk skill template. trustedShell controls !`cmd` and ${ENV}
 * expansion; loadSkillsDir passes true for every disk template
 * (install-is-trust policy).
 */
export async function expandSkillBody(
  body: string,
  opts: { args?: string; workspaceRoot?: string; trustedShell: boolean },
): Promise<string> {
  return expandDiskTemplate(body, opts);
}

/** Build a SkillDefinition from one parsed SKILL.md (body stays lazy). */
function defFromFile(
  name: string,
  parsed: ParsedSkillFile,
  trustedShell: boolean,
): SkillDefinition {
  const fm = parsed.frontmatter;
  const context = asString(fm.context) === "fork" ? "fork" : "inline";
  return {
    name: asString(fm.name) || name,
    description: asString(fm.description) || `Disk skill "${name}"`,
    group: asString(fm.group),
    whenToUse: asString(fm.whenToUse),
    source: "disk",
    context: context as SkillContext,
    agent: asString(fm.agent),
    allowedTools: asList(fm.allowedTools),
    // Lazy: the template is expanded only when the skill is actually invoked.
    getPromptForCommand: (ctx) =>
      expandSkillBody(parsed.body, {
        args: ctx.args,
        workspaceRoot: ctx.workspaceRoot,
        trustedShell,
      }),
  };
}

/**
 * Scan the disk skill roots and register every valid <name>/SKILL.md. Returns
 * the names registered (project entries override same-named user entries).
 * Missing roots are skipped silently — disk skills are optional.
 */
export function loadSkillsDir(workspaceRoot: string): string[] {
  const loaded: string[] = [];
  for (const root of skillDirRoots(workspaceRoot)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root doesn't exist — fine
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeSkillName(entry.name)) continue;
      const file = path.join(root, entry.name, "SKILL.md");
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue; // no SKILL.md in this dir
      }
      const parsed = parseFrontmatter(raw);
      // trustedShell: true for every root — the old `index === 0` heuristic
      // claimed "user-scope only" but silently trusted the project root in the
      // default environment (no CCR_USER_SKILLS_DIR set). Install-is-trust is
      // now the explicit, documented policy (Top10 #2 decision).
      registerSkill(defFromFile(entry.name, parsed, true));
      loaded.push(asString(parsed.frontmatter.name) || entry.name);
    }
  }
  return loaded;
}
