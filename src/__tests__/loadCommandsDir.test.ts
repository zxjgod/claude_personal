// ============================================================
// Tests: Disk slash-command loader — frontmatter, ${VAR}/$1, !`shell` (M18.x)
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandCommandBody,
  getCustomCommands,
  loadCommandsDir,
  registerCustomCommand,
  resetCustomCommands,
} from "../commands/loadCommandsDir.js";

let repo: string;

function writeCommand(name: string, content: string) {
  const dir = path.join(repo, ".claude", "commands");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content);
}

beforeEach(() => {
  resetCustomCommands();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-cmds-"));
  // Pin the user-scope commands root to an empty sandbox so the host machine's
  // real ~/.claude/commands can't leak into these assertions.
  process.env.CCR_USER_COMMANDS_DIR = path.join(repo, "user-commands-empty");
});

afterEach(() => {
  resetCustomCommands();
  delete process.env.CCR_USER_COMMANDS_DIR;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("expandCommandBody", () => {
  it("substitutes $ARGUMENTS / ${ARGUMENTS} / ${ARGS}", async () => {
    const out = await expandCommandBody("Focus: $ARGUMENTS | ${ARGS}", { args: "auth module" });
    expect(out).toBe("Focus: auth module | auth module");
  });

  it("substitutes positional $1..$9", async () => {
    const out = await expandCommandBody("Fix $1 in $2", { args: "login-page src/auth.ts" });
    expect(out).toBe("Fix login-page in src/auth.ts");
  });

  it("leaves unknown positional args empty", async () => {
    const out = await expandCommandBody("x $1 y $3", { args: "one" });
    expect(out).toBe("x one y ");
  });

  it("expands !`shell` (trusted command body)", async () => {
    const out = await expandCommandBody("v=!`echo hi`", {
      args: "",
      workspaceRoot: repo,
      trustedShell: true,
    });
    expect(out.trim()).toBe("v=hi");
  });
});

describe("loadCommandsDir", () => {
  it("registers each <name>.md as a prompt-injection command", async () => {
    writeCommand("commit", "---\ndescription: Draft a commit message\n---\nDraft for: $ARGUMENTS");
    const loaded = loadCommandsDir(repo);
    expect(loaded).toEqual(["commit"]);

    const cmd = getCustomCommands().get("commit");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toBe("Draft a commit message");

    const res = await cmd!.run("the login fix", { workspaceRoot: repo } as never);
    expect(res?.prompt).toContain("Draft for: the login fix");
  });

  it("skips files without a body", () => {
    writeCommand("empty", "---\ndescription: nothing\n---\n");
    expect(loadCommandsDir(repo)).toEqual([]);
  });

  it("ignores non-md files and unsafe names", () => {
    const dir = path.join(repo, ".claude", "commands");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a command");
    fs.writeFileSync(path.join(dir, "bad name.md"), "---\n---\nbody");
    expect(loadCommandsDir(repo)).toEqual([]);
  });

  it("registerCustomCommand / resetCustomCommands are idempotent", () => {
    registerCustomCommand({ name: "x", description: "d", run: () => undefined });
    expect(getCustomCommands().has("x")).toBe(true);
    resetCustomCommands();
    expect(getCustomCommands().has("x")).toBe(false);
  });
});
