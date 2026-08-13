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
//   - !`shell command`           → command stdout — TRUSTED SOURCES ONLY.
//
// Disk skills are trusted (the user authored them on their own machine), so
// shell expansion runs. MCP/remote skills are untrusted and disable it
// (see skills.ts SkillSource); this loader only ever produces trusted ones.
// ============================================================

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { registerSkill, type SkillContext, type SkillDefinition } from "../skills.js";
import { type ParsedFrontmatter, parseFrontmatter } from "../utils/frontmatter.js";

// Back-compat alias: the shared parser was previously defined in this module.
export { parseFrontmatter };
export type ParsedSkillFile = ParsedFrontmatter;

const execFileAsync = promisify(execFile);

/** Reject a skill directory name that would escape the skills root. */
function isSafeSkillName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name !== "." && name !== "..";
}

/** User-scope skills root can be redirected for tests / sandboxes. */
const USER_SKILLS_ENV = "CCR_USER_SKILLS_DIR";

/** Roots scanned for disk skills, lowest → highest precedence (project wins). */
export function skillDirRoots(workspaceRoot: string): string[] {
  const userRoot = process.env[USER_SKILLS_ENV] || path.join(os.homedir(), ".claude", "skills");
  return [userRoot, path.join(workspaceRoot, ".claude", "skills")];
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
 * Expand a trusted disk-skill body. `${VAR}` substitution always runs;
 * `` !`cmd` `` shell expansion runs only when `trustedShell` is true (it always
 * is for disk skills, but the flag keeps the contract explicit and testable).
 */
export async function expandSkillBody(
  body: string,
  opts: { args?: string; workspaceRoot?: string; trustedShell: boolean },
): Promise<string> {
  // ${VAR} — ARGUMENTS/ARGS, WORKSPACE, then process.env fallback.
  let out = body.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    if (name === "ARGUMENTS" || name === "ARGS") return opts.args ?? "";
    if (name === "WORKSPACE") return opts.workspaceRoot ?? process.cwd();
    const env = process.env[name];
    return env ?? "";
  });

  if (!opts.trustedShell) {
    // Untrusted source: strip shell directives rather than execute them.
    return out.replace(/!`[^`]*`/g, "");
  }

  // !`cmd` — run each, splice stdout in. Failures degrade to an inline note so
  // a broken command doesn't abort the whole expansion.
  const matches = [...out.matchAll(/!`([^`]+)`/g)];
  for (const match of matches) {
    const cmd = match[1]!.trim();
    let replacement: string;
    try {
      const { stdout } = await execFileAsync(
        process.platform === "win32" ? "cmd" : "sh",
        process.platform === "win32" ? ["/c", cmd] : ["-c", cmd],
        { cwd: opts.workspaceRoot ?? process.cwd(), timeout: 10_000, windowsHide: true },
      );
      replacement = stdout.trimEnd();
    } catch (error: any) {
      replacement = `[shell expansion failed: ${error?.message ?? String(error)}]`;
    }
    out = out.replace(match[0], replacement);
  }
  return out;
}

/** Build a SkillDefinition from one parsed SKILL.md (body stays lazy). */
function defFromFile(name: string, parsed: ParsedSkillFile): SkillDefinition {
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
        trustedShell: true,
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
      registerSkill(defFromFile(entry.name, parsed));
      loaded.push(asString(parsed.frontmatter.name) || entry.name);
    }
  }
  return loaded;
}
