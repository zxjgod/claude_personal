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
//   allowedTools: [read, grep] # only with context: fork (ignored for inline)
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

import * as path from "node:path";
import { userConfigRoot } from "../settings.js";
import { registerSkill, type SkillContext, type SkillDefinition } from "../skills.js";
import { loadDiskEntries } from "../utils/disk-loader.js";
import { expandDiskTemplate } from "../utils/disk-template.js";
import {
  frontmatterList,
  frontmatterString,
  type ParsedFrontmatter,
  parseFrontmatter,
} from "../utils/frontmatter.js";
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
  roots.unshift(process.env[USER_SKILLS_ENV] || path.join(userConfigRoot(), "skills"));
  return roots;
}

const asString = frontmatterString;

const asList = frontmatterList;

/**
 * Expand a disk skill template. trustedShell controls !`cmd` and ${ENV}
 * expansion; loadSkillsDir passes true for every disk template
 * (install-is-trust policy).
 */
export async function expandSkillBody(
  body: string,
  opts: { args?: string; workspaceRoot?: string; trustedShell: boolean; positional?: boolean },
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
    allowedTools: asList(fm["allowed-tools"] ?? fm.allowedTools),
    toolPermissionGrant: fm["allowed-tools"] !== undefined,
    disallowedTools: asList(fm["disallowed-tools"] ?? fm.disallowedTools),
    disableModelInvocation: asString(fm["disable-model-invocation"]) === "true",
    userInvocable: asString(fm["user-invocable"]) !== "false",
    model: asString(fm.model),
    effort: asString(fm.effort),
    hooks: fm.hooks,
    // Lazy: the template is expanded only when the skill is actually invoked.
    getPromptForCommand: (ctx) =>
      expandSkillBody(parsed.body, {
        args: ctx.args,
        workspaceRoot: ctx.workspaceRoot,
        trustedShell,
        positional: true,
      }),
  };
}

/**
 * Scan the disk skill roots and register every valid <name>/SKILL.md. Returns
 * the names registered (project entries override same-named user entries).
 * Missing roots are skipped silently — disk skills are optional.
 */
export function loadSkillsDir(
  workspaceRoot: string,
  options: { roots?: string[]; namespace?: string } = {},
): string[] {
  return loadDiskEntries({
    roots: options.roots ?? skillDirRoots(workspaceRoot),
    accepts: (entry) => entry.isDirectory() && isSafeSkillName(entry.name),
    nameOf: (entry) => entry.name,
    fileOf: (root, entry) => path.join(root, entry.name, "SKILL.md"),
    parse: (entry) => defFromFile(entry.name, parseFrontmatter(entry.raw), true),
    register: (skill) =>
      registerSkill(
        options.namespace ? { ...skill, name: `${options.namespace}:${skill.name}` } : skill,
      ),
    loadedName: (value, entry) => value.name || entry.name,
  });
}
