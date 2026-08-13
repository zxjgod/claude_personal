// ============================================================
// Tests: Config-driven hooks — settings parsing + command execution
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookRegistry } from "../hooks.js";
import { parseHooksConfig, readSettings, registerHooksFromConfig } from "../hooks-config.js";

const node = JSON.stringify(process.execPath);

let tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-hookcfg-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe("parseHooksConfig", () => {
  it("parses valid phases and drops malformed entries", () => {
    const config = parseHooksConfig({
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "echo hi" }] },
          { matcher: "", hooks: [{ type: "command", command: "x" }] }, // empty matcher → dropped
          { matcher: "Bash", hooks: [{ type: "other", command: "x" }] }, // bad spec → dropped
          "nonsense", // not an object → dropped
        ],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "x", timeout: 30 }] }],
        Stop: [], // empty → omitted
        UnknownPhase: [{ matcher: "*", hooks: [{ type: "command", command: "x" }] }], // ignored
      },
    });
    expect(config.PreToolUse).toHaveLength(1);
    expect(config.PreToolUse![0]!.matcher).toBe("Edit|Write");
    expect(config.PostToolUse).toHaveLength(1);
    expect(config.PostToolUse![0]!.hooks[0]!.timeout).toBe(30);
    expect(config.Stop).toBeUndefined();
  });

  it("returns empty config for missing / non-object hooks", () => {
    expect(parseHooksConfig(null)).toEqual({});
    expect(parseHooksConfig(undefined)).toEqual({});
    expect(parseHooksConfig({ hooks: "nope" })).toEqual({});
    expect(parseHooksConfig({ hooks: [] })).toEqual({});
  });
});

describe("readSettings", () => {
  it("merges settings.json and settings.local.json (local wins)", () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [] }, telemetry: { enabled: true } }),
    );
    fs.writeFileSync(
      path.join(repo, ".claude", "settings.local.json"),
      JSON.stringify({ telemetry: { enabled: false } }),
    );
    const settings = readSettings(repo);
    expect(settings).toEqual({ hooks: { Stop: [] }, telemetry: { enabled: false } });
  });

  it("returns null when no settings file exists", () => {
    expect(readSettings(tmp())).toEqual({});
  });
});

describe("registerHooksFromConfig (command execution)", () => {
  function writeBlockScript(): string {
    const repo = tmp();
    const script = path.join(repo, "block.cjs");
    fs.writeFileSync(
      script,
      [
        "let s='';",
        "process.stdin.on('data', d => s += d);",
        "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ decision: 'block', reason: 'nope' })));",
      ].join("\n"),
    );
    return script;
  }

  it("blocks a tool when the command emits decision: block", async () => {
    const script = writeBlockScript();
    const registry = new HookRegistry();
    registerHooksFromConfig(registry, {
      PreToolUse: [
        {
          matcher: "Edit",
          hooks: [{ type: "command", command: `${node} ${JSON.stringify(script)}` }],
        },
      ],
    });
    const outcome = await registry.runPre({ toolName: "Edit", input: { filePath: "a.ts" } });
    expect(outcome.block).toBe(true);
    expect(outcome.reason).toBe("nope");
  });

  it("regex matcher matches multiple tool names", async () => {
    const script = writeBlockScript();
    const registry = new HookRegistry();
    registerHooksFromConfig(registry, {
      PreToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [{ type: "command", command: `${node} ${JSON.stringify(script)}` }],
        },
      ],
    });
    const edit = await registry.runPre({ toolName: "Edit", input: {} });
    const write = await registry.runPre({ toolName: "Write", input: {} });
    const read = await registry.runPre({ toolName: "Read", input: {} });
    expect(edit.block).toBe(true);
    expect(write.block).toBe(true);
    expect(read.block).toBeUndefined();
  });

  it("a failing command is a no-op (fail-open)", async () => {
    const registry = new HookRegistry();
    registerHooksFromConfig(registry, {
      PreToolUse: [
        {
          matcher: "Edit",
          hooks: [{ type: "command", command: "definitely-not-a-real-command-xyz" }],
        },
      ],
    });
    const outcome = await registry.runPre({ toolName: "Edit", input: {} });
    expect(outcome.block).toBeUndefined();
  });
});
