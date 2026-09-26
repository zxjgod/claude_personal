import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Expand only directives present in the template, never in supplied values.
 *
 * trustedShell gates !`cmd` execution and ${ENV} expansion. Policy note
 * (user decision 2026-09, install-is-trust): every disk-template loader
 * (commands/skills, project/user/plugin roots) passes trustedShell:true —
 * installing or authoring a template vouches for it. The gate is kept as
 * defense-in-depth and a future policy hook for callers that want prompt-only
 * templates (they pass trustedShell:false explicitly).
 */
export async function expandDiskTemplate(
  body: string,
  opts: {
    args?: string;
    workspaceRoot?: string;
    trustedShell: boolean;
    positional?: boolean;
  },
): Promise<string> {
  const args = opts.args ?? "";
  const positions = args.split(/\s+/).filter(Boolean);
  const tokens = /!`([^`]+)`|\$\{([A-Z0-9_]+)\}|\$(ARGUMENTS|ARGS)\b|\$([1-9])\b/g;
  let output = "";
  let cursor = 0;
  for (const match of body.matchAll(tokens)) {
    output += body.slice(cursor, match.index);
    cursor = (match.index ?? 0) + match[0].length;
    if (match[1] !== undefined) {
      if (!opts.trustedShell) {
        output += "[shell expansion disabled: untrusted template source]";
        continue;
      }
      // Caller arguments and environment substitutions must never become shell
      // syntax. Trusted templates may execute literal commands only.
      if (/\$\{[A-Z0-9_]+\}|\$(?:ARGUMENTS|ARGS)\b|\$[1-9]\b/.test(match[1])) {
        output += "[shell expansion disabled: template substitutions in commands]";
        continue;
      }
      try {
        const { stdout } = await execFileAsync(
          process.platform === "win32" ? "cmd" : "sh",
          process.platform === "win32" ? ["/c", match[1]] : ["-c", match[1]],
          { cwd: opts.workspaceRoot ?? process.cwd(), timeout: 10_000, windowsHide: true },
        );
        output += stdout.trimEnd();
      } catch (error) {
        output += `[shell expansion failed: ${error instanceof Error ? error.message : String(error)}]`;
      }
    } else if (match[2] !== undefined) {
      const name = match[2];
      output +=
        name === "ARGUMENTS" || name === "ARGS"
          ? args
          : name === "WORKSPACE"
            ? (opts.workspaceRoot ?? process.cwd())
            : opts.trustedShell
              ? (process.env[name] ?? "")
              : "";
    } else if (match[3] !== undefined) {
      output += opts.positional ? args : match[0];
    } else {
      output += opts.positional ? (positions[Number(match[4]) - 1] ?? "") : match[0];
    }
  }
  return output + body.slice(cursor);
}
