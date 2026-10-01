import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Check the live navigation documents, never historical archive claims. */
export function checkArchitectureDocs(root) {
  const errors = [];
  for (const name of ["项目架构.md", "模块维护方案.md"]) {
    const file = join(root, "docs", name);
    const text = readFileSync(file, "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^[a-z]+:|^#/i.test(target)) continue;
      const relative = target.split("#")[0];
      if (relative && !existsSync(resolve(dirname(file), decodeURIComponent(relative))))
        errors.push(`${name}: missing linked path ${relative}`);
    }
    for (const [command, implementation] of [
      ["npm run build", "esbuild"],
      ["npm run typecheck", "tsc --noEmit"],
      ["npm test", ".test.tsx"],
    ]) {
      const row = text
        .split("\n")
        .find((line) => line.startsWith("|") && line.includes(`\`${command}\``));
      if (!row?.includes(implementation))
        errors.push(`${name}: ${command} must describe ${implementation}`);
    }
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.scripts.typecheck !== "tsc --noEmit")
    errors.push("typecheck command changed: update architecture docs and this check together");
  const build = readFileSync(join(root, "scripts", "build.mjs"), "utf8");
  if (!build.includes('from "esbuild"'))
    errors.push("build implementation changed: update architecture docs");
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  if (!ci.includes("ubuntu-latest") || !ci.includes("windows-latest"))
    errors.push("CI platforms changed: update architecture docs");
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const errors = checkArchitectureDocs(root);
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else console.log("architecture docs: paths, build, typecheck, test scope and CI are consistent");
}
