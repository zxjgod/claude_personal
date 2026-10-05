import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fg from "fast-glob";
import picomatch from "picomatch";
import { userConfigRoot } from "./settings.js";
import { frontmatterList, parseFrontmatter } from "./utils/frontmatter.js";

export interface InstructionFile {
  path: string;
  content: string;
}
function parents(directory: string): string[] {
  const result: string[] = [];
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    result.unshift(current);
    if (path.dirname(current) === current) return result;
  }
}
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function readInstruction(
  file: string,
  trustedRoot: string,
  depth = 0,
  visited = new Set<string>(),
): InstructionFile[] {
  const resolved = path.resolve(file);
  if (depth > 4 || visited.has(resolved) || path.extname(resolved).toLowerCase() !== ".md")
    return [];
  try {
    const canonical = fs.realpathSync(resolved);
    if (!inside(trustedRoot, canonical) && process.env.CCR_TRUST_INSTRUCTION_IMPORTS !== "1")
      return [];
    const stat = fs.statSync(canonical);
    if (stat.size > 256000 || !stat.isFile()) return [];
    visited.add(resolved);
    const content = fs.readFileSync(canonical, "utf8");
    const output = [{ path: resolved, content }];
    let fence = false;
    for (const line of content.split(/\r?\n/)) {
      if (/^\s*```|^\s*~~~/.test(line)) {
        fence = !fence;
        continue;
      }
      if (fence) continue;
      for (const match of line.matchAll(/(?:^|\s)@(?:"([^"]+\.md)"|([^\s`]+\.md))(?=\s|$|[),])/g)) {
        const target = match[1] || match[2];
        output.push(
          ...readInstruction(
            target.startsWith("~/")
              ? path.join(os.homedir(), target.slice(2))
              : path.resolve(path.dirname(resolved), target),
            trustedRoot,
            depth + 1,
            visited,
          ),
        );
      }
    }
    return output;
  } catch {
    return [];
  }
}

function directoryInstructions(directory: string, trustedRoot: string): InstructionFile[] {
  const candidates = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];
  const found = candidates.flatMap((file) =>
    readInstruction(path.join(directory, file), trustedRoot),
  );
  if (!found.length || process.env.CCR_INSTRUCTION_FILES === "both")
    found.push(...readInstruction(path.join(directory, "AGENTS.md"), trustedRoot));
  return found;
}
function rules(directory: string, target?: string): InstructionFile[] {
  const root = path.join(directory, ".claude", "rules");
  return fg
    .sync("**/*.md", { cwd: root, absolute: true, followSymbolicLinks: false })
    .sort()
    .flatMap((file) => {
      try {
        const parsed = parseFrontmatter(fs.readFileSync(file, "utf8"));
        const paths = frontmatterList(parsed.frontmatter.paths);
        if (
          paths?.length &&
          (!target ||
            !paths.some((pattern) =>
              picomatch(pattern, { dot: true })(
                path.relative(directory, target).replaceAll("\\", "/"),
              ),
            ))
        )
          return [];
        return [{ path: file, content: parsed.body }];
      } catch {
        return [];
      }
    });
}
export function loadProjectInstructions(workspace: string, target?: string): InstructionFile[] {
  if (process.argv.includes("--safe-mode") || process.argv.includes("--bare")) {
    const managed = process.env.CCR_MANAGED_INSTRUCTIONS;
    return managed ? readInstruction(managed, path.dirname(path.resolve(managed))) : [];
  }
  const root = path.resolve(workspace);
  const userRoot = userConfigRoot();
  const files = [
    ...readInstruction(path.join(userRoot, "CLAUDE.md"), userRoot),
    ...rules(userRoot),
    ...parents(root).flatMap((directory) => [
      ...directoryInstructions(directory, directory),
      ...rules(directory, target),
    ]),
  ];
  if (target && inside(root, target)) {
    const directories = parents(path.dirname(path.resolve(target))).filter(
      (directory) => directory !== root && inside(root, directory),
    );
    for (const directory of directories)
      files.push(...directoryInstructions(directory, directory), ...rules(directory, target));
  }
  const managed = process.env.CCR_MANAGED_INSTRUCTIONS;
  if (managed) files.push(...readInstruction(managed, path.dirname(path.resolve(managed))));
  return [...new Map(files.map((file) => [file.path, file])).values()];
}
export function renderInstructions(files: InstructionFile[]): string {
  return files
    .map((file) => {
      // Instruction content is repo-controlled text rendered into privileged
      // system/user context. Neutralize system-reminder tag sequences so a
      // planted file can't forge or close a privileged frame (same treatment
      // as summary.ts / prefetch.ts).
      const content = file.content.replace(/<\/?system-reminder/gi, "<system_reminder");
      return `Instructions from ${file.path}:\n${content}`;
    })
    .join("\n\n");
}
const seen = new Map<string, Set<string>>();
export function instructionAttachment(
  sessionId: string,
  workspace: string,
  target: string,
): string {
  const key = `${sessionId}\0${workspace}`;
  let loaded = seen.get(key);
  if (!loaded) {
    loaded = new Set(
      loadProjectInstructions(workspace).map((file) => `${file.path}\0${file.content}`),
    );
    seen.set(key, loaded);
  }
  const files = loadProjectInstructions(workspace, path.resolve(workspace, target)).filter(
    (file) => {
      const fingerprint = `${file.path}\0${file.content}`;
      if (loaded!.has(fingerprint)) return false;
      loaded!.add(fingerprint);
      return true;
    },
  );
  return files.length ? `\n\n[PROJECT INSTRUCTIONS]\n${renderInstructions(files)}` : "";
}
