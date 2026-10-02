import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPermissionMode, getPermissionPolicy } from "../cli-config.js";
import {
  instructionAttachment,
  loadProjectInstructions,
  renderInstructions,
} from "../project-instructions.js";
import { readSettings } from "../settings.js";

let root: string;
function write(file: string, value: string | object) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-instructions-"));
  vi.stubEnv("CCR_USER_CONFIG_DIR", path.join(root, "user"));
  vi.stubEnv("CCR_MANAGED_SETTINGS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it("merges nested settings and keeps managed constraints above local and CLI allows", () => {
  write("user/settings.json", {
    env: { USER_NOTE: "user" },
    permissions: { allow: ["Read"], defaultMode: "acceptEdits" },
  });
  write("project/.claude/settings.json", {
    env: { PROJECT_NOTE: "project" },
    permissions: { deny: ["Write"] },
  });
  write("project/.claude/settings.local.json", {
    env: { PROJECT_NOTE: "local" },
    permissions: { ask: ["Bash"] },
  });
  write("policy.json", {
    model: "managed",
    permissionMode: "plan",
    permissions: { deny: ["Edit"] },
  });
  vi.stubEnv("CCR_MANAGED_SETTINGS", path.join(root, "policy.json"));
  const project = path.join(root, "project");
  expect(readSettings(project)).toMatchObject({
    env: { USER_NOTE: "user", PROJECT_NOTE: "local" },
    model: "managed",
  });
  expect(getPermissionMode(project)).toBe("plan");
  expect(getPermissionPolicy(project)).toEqual({
    allow: ["Read"],
    deny: ["Edit", "Write"],
    ask: ["Bash"],
  });
});
it("loads ancestor and user instructions and imports, lazily applies nested path rules", () => {
  write("user/CLAUDE.md", "User guidance");
  write("CLAUDE.md", "Ancestor guidance");
  write("project/CLAUDE.md", "Root guidance\n@docs/extra.md\n@../external.md");
  write("project/docs/extra.md", "Imported guidance\n@../CLAUDE.md");
  write("external.md", "External content must not be imported automatically");
  write("project/src/CLAUDE.md", "Source guidance");
  write("project/src/a.ts", "code");
  write("project/.claude/rules/ts.md", "---\npaths:\n  - 'src/**/*.ts'\n---\nTypeScript guidance");
  const project = path.join(root, "project");
  const startup = renderInstructions(loadProjectInstructions(project));
  expect(startup).toContain("User guidance");
  expect(startup).toContain("Ancestor guidance");
  expect(startup).toContain("Imported guidance");
  expect(startup).not.toContain("TypeScript guidance");
  expect(startup).not.toContain("External content must");
  const attachment = instructionAttachment("instructions-fixture", project, "src/a.ts");
  expect(attachment).toContain("Source guidance");
  expect(attachment).toContain("TypeScript guidance");
  expect(instructionAttachment("instructions-fixture", project, "src/a.ts")).toBe("");
});
it("uses AGENTS.md when Claude instructions are absent and ignores imports in fenced examples", () => {
  write("project/AGENTS.md", "Fallback instructions\n```\n@hidden.md\n```\n");
  write("project/hidden.md", "example import");
  expect(renderInstructions(loadProjectInstructions(path.join(root, "project")))).toContain(
    "Fallback instructions",
  );
  expect(renderInstructions(loadProjectInstructions(path.join(root, "project")))).not.toContain(
    "example import",
  );
});
