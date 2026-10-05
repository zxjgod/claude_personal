// ============================================================
// Tests: Config-driven hooks — settings parsing + command execution
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookRegistry } from "../hooks.js";
import {
  type HooksConfig,
  hooksConfigFingerprint,
  hookTimeoutMs,
  loadHooksFromSettingsTrusted,
  parseHooksConfig,
  readSettings,
  registerHooksFromConfig,
  warnUnknownSettings,
} from "../hooks-config.js";

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

describe("warnUnknownSettings", () => {
  it("flags official-client keys this replica does NOT consume", () => {
    // statusLine & co used to sit in KNOWN_SETTINGS_KEYS while nothing read
    // them — the warning never fired and users believed their config worked.
    // Consumed keys must stay silent; unconsumed ones must be reported.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unknown = warnUnknownSettings({
        hooks: {},
        permissionMode: "default",
        permissions: { allow: [] },
        telemetry: {},
        env: {},
        model: {},
        statusLine: { type: "command", command: "x" },
        apiKeyHelper: "helper.sh",
        cleanupPeriodDays: 30,
        includeCoAuthoredBy: false,
        enableAllProjectMcpServers: true,
        additionalDirectories: ["../other"],
      });
      expect([...unknown].sort()).toEqual(
        [
          "additionalDirectories",
          "apiKeyHelper",
          "cleanupPeriodDays",
          "enableAllProjectMcpServers",
          "includeCoAuthoredBy",
          "statusLine",
        ].sort(),
      );
      expect(warn).toHaveBeenCalledTimes(6);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent for keys this replica DOES consume", () => {
    // memory (/memory-approval), subagents (/agents) and disabledMcpjsonServers
    // (cli-tools MCP loading) are all read at startup — flagging them would be
    // a false positive at every launch.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unknown = warnUnknownSettings({
        memory: { requireApproval: true },
        subagents: { thinking: false, sidechainMode: "audit" },
        disabledMcpjsonServers: ["some-server"],
        screenReader: { axScreenReader: false },
        disableAgentView: false,
      });
      expect(unknown).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent for null settings", () => {
    expect(warnUnknownSettings(null)).toEqual([]);
  });
});

describe("parseHooksConfig", () => {
  it("parses valid phases and drops malformed entries", () => {
    const config = parseHooksConfig({
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "echo hi" }] },
          // Official semantics: an omitted/empty matcher means ALL tools.
          { hooks: [{ type: "command", command: "x" }] },
          { matcher: "", hooks: [{ type: "command", command: "x" }] },
          { matcher: "Bash", hooks: [{ type: "other", command: "x" }] }, // bad spec → dropped
          "nonsense", // not an object → dropped
        ],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "x", timeout: 30 }] }],
        Stop: [], // empty → omitted
        UnknownPhase: [{ matcher: "*", hooks: [{ type: "command", command: "x" }] }], // ignored
      },
    });
    expect(config.PreToolUse).toHaveLength(3);
    expect(config.PreToolUse![0]!.matcher).toBe("Edit|Write");
    expect(config.PreToolUse![1]!.matcher).toBe("*"); // omitted matcher → all tools
    expect(config.PreToolUse![2]!.matcher).toBe("*"); // empty matcher → all tools
    expect(config.PostToolUse).toHaveLength(1);
    expect(config.PostToolUse![0]!.hooks[0]!.timeout).toBe(30);
    expect(config.Stop).toBeUndefined();
  });

  it("clamps a hook's own timeout to the ceiling (round 3)", () => {
    expect(hookTimeoutMs()).toBe(60_000);
    expect(hookTimeoutMs(30)).toBe(30_000);
    // Unbounded before: an absurd `timeout` pinned every matching tool call.
    expect(hookTimeoutMs(1e12)).toBe(600_000);
    expect(hookTimeoutMs(600)).toBe(600_000);
  });

  it("returns empty config for missing / non-object hooks", () => {
    expect(parseHooksConfig(null)).toEqual({});
    expect(parseHooksConfig(undefined)).toEqual({});
    expect(parseHooksConfig({ hooks: "nope" })).toEqual({});
    expect(parseHooksConfig({ hooks: [] })).toEqual({});
  });
});

describe("readSettings", () => {
  // Hermetic user layer: readSettings merges the REAL user settings file, and
  // a legit one may exist (e.g. /memory-approval off persists to it). Point
  // CCR_USER_CONFIG_DIR at an empty temp dir so these assertions only cover
  // the project/local layers they create.
  const savedUserDir = process.env.CCR_USER_CONFIG_DIR;
  beforeEach(() => {
    process.env.CCR_USER_CONFIG_DIR = tmp();
  });
  afterEach(() => {
    if (savedUserDir === undefined) delete process.env.CCR_USER_CONFIG_DIR;
    else process.env.CCR_USER_CONFIG_DIR = savedUserDir;
  });

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

describe("official hook protocol (exit codes, stdin envelope, env)", () => {
  function writeScript(body: string): string {
    const repo = tmp();
    const script = path.join(repo, "hook.cjs");
    fs.writeFileSync(script, body);
    return script;
  }
  const preHook = (command: string): HooksConfig => ({
    PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command }] }],
  });

  it("exit code 2 + stderr blocks with the stderr as reason", async () => {
    // The most common official idiom: no JSON, just `echo reason >&2; exit 2`.
    // It used to be a silent no-op (stderr was discarded, exit code unread).
    const script = writeScript(
      "process.stdin.resume(); process.stdin.on('end', () => {" +
        "process.stderr.write('edit not allowed here'); process.exit(2); });",
    );
    const registry = new HookRegistry();
    registerHooksFromConfig(registry, preHook(`${node} ${JSON.stringify(script)}`));
    const outcome = await registry.runPre({ toolName: "Edit", input: {} });
    expect(outcome.block).toBe(true);
    expect(outcome.reason).toBe("edit not allowed here");
  });

  it("exit code 2 with empty stderr falls back to the JSON reason, then a default", async () => {
    const withJsonReason = writeScript(
      "process.stdin.resume(); process.stdin.on('end', () => {" +
        "process.stdout.write(JSON.stringify({ reason: 'from-json' })); process.exit(2); });",
    );
    const bare = writeScript(
      "process.stdin.resume(); process.stdin.on('end', () => process.exit(2));",
    );
    const registry = new HookRegistry();
    registerHooksFromConfig(registry, preHook(`${node} ${JSON.stringify(withJsonReason)}`));
    const a = await registry.runPre({ toolName: "Edit", input: {} });
    expect(a.block).toBe(true);
    expect(a.reason).toBe("from-json");

    const registry2 = new HookRegistry();
    registerHooksFromConfig(registry2, preHook(`${node} ${JSON.stringify(bare)}`));
    const b = await registry2.runPre({ toolName: "Edit", input: {} });
    expect(b.block).toBe(true);
    expect(b.reason).toBe("blocked by PreToolUse hook");
  });

  it("stderr with a non-2 exit code never blocks", async () => {
    const script = writeScript(
      "process.stdin.resume(); process.stdin.on('end', () => {" +
        "process.stderr.write('just logging'); process.exit(0); });",
    );
    const registry = new HookRegistry();
    registerHooksFromConfig(registry, preHook(`${node} ${JSON.stringify(script)}`));
    const outcome = await registry.runPre({ toolName: "Edit", input: {} });
    expect(outcome.block).toBeUndefined();
  });

  it("a hook that exits before reading stdin still blocks (stdin EPIPE)", async () => {
    // `exit 2` without draining stdin makes the payload write fail with EPIPE.
    // Settling the hook promise on that error raced `close` and dropped the
    // official block decision — the gated tool call then proceeded. A large
    // payload keeps the write in flight so the EPIPE is deterministic rather
    // than a coin flip on child startup time.
    const script = writeScript(
      "process.stderr.write('blocked before reading stdin'); process.exit(2);",
    );
    const registry = new HookRegistry();
    registerHooksFromConfig(registry, preHook(`${node} ${JSON.stringify(script)}`));
    const outcome = await registry.runPre({
      toolName: "Edit",
      input: { filePath: "a.ts", content: "x".repeat(8 * 1024 * 1024) },
    });
    expect(outcome.block).toBe(true);
    expect(outcome.reason).toBe("blocked before reading stdin");
  });

  it("stdin carries the official envelope and CLAUDE_PROJECT_DIR is exported", async () => {
    // The hook dumps its stdin + env to a file (resolved against its CWD) so
    // the test can assert exactly what an official-client script would see.
    const repo = tmp();
    const script = path.join(repo, "dump.cjs");
    fs.writeFileSync(
      script,
      [
        "const fs = require('fs');",
        "let s='';",
        "process.stdin.on('data', d => s += d);",
        "process.stdin.on('end', () => fs.writeFileSync('seen.json', JSON.stringify({",
        "  stdin: JSON.parse(s),",
        "  projectDir: process.env.CLAUDE_PROJECT_DIR,",
        "})));",
      ].join("\n"),
    );
    const registry = new HookRegistry();
    registerHooksFromConfig(
      registry,
      {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: `${node} ${JSON.stringify(script)}` }],
          },
        ],
      },
      { sessionId: "sess-e2e", workspaceRoot: repo },
    );
    const outcome = await registry.runPre({ toolName: "Edit", input: { filePath: "a.ts" } });
    expect(outcome.block).toBeUndefined();
    const seen = JSON.parse(fs.readFileSync(path.join(repo, "seen.json"), "utf8"));
    expect(seen.projectDir).toBe(repo); // runs in the workspace root, not process.cwd()
    expect(seen.stdin.hook_event_name).toBe("PreToolUse");
    expect(seen.stdin.session_id).toBe("sess-e2e");
    expect(seen.stdin.transcript_path).toBe(
      path.join(repo, ".claude", "sessions", "sess-e2e.transcript.jsonl"),
    );
    expect(seen.stdin.cwd).toBe(repo);
    expect(seen.stdin.tool_name).toBe("Edit");
    expect(seen.stdin.tool_input).toEqual({ filePath: "a.ts" });
  });

  it("an omitted matcher runs the hook for every tool", async () => {
    // Official semantics: matcher is optional; without it the hook sees all
    // tools. The entry used to be dropped at parse time.
    const script = writeScript(
      "process.stdin.resume(); process.stdin.on('end', () => {" +
        "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'nope' })); });",
    );
    const registry = new HookRegistry();
    registerHooksFromConfig(registry, {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: `${node} ${JSON.stringify(script)}` }],
        },
      ],
    });
    // (matcher "*" is what parseHooksConfig now produces for an omitted one —
    // covered in the parse test; here assert the all-tools behavior end to end.)
    for (const tool of ["Edit", "Write", "Bash", "Read"]) {
      const outcome = await registry.runPre({ toolName: tool, input: {} });
      expect(outcome.block).toBe(true);
    }
  });
});

describe("hook trust gate", () => {
  const HOOKS_SETTINGS = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo checked" }] }],
    },
  };

  function writeHooksSettings(repo: string): void {
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify(HOOKS_SETTINGS));
  }

  let savedTrustStore: string | undefined;
  afterEach(() => {
    if (savedTrustStore === undefined) delete process.env.CCR_TRUST_STORE;
    else process.env.CCR_TRUST_STORE = savedTrustStore;
  });

  function useTmpTrustStore(): string {
    savedTrustStore = process.env.CCR_TRUST_STORE;
    const store = path.join(tmp(), "trusted-hooks.json");
    process.env.CCR_TRUST_STORE = store;
    return store;
  }

  it("untrusted project hooks are NOT registered without confirmation", async () => {
    useTmpTrustStore();
    const repo = tmp();
    writeHooksSettings(repo);
    const registry = new HookRegistry();
    const result = await loadHooksFromSettingsTrusted(repo, registry, null);
    expect(result.loaded).toBe(0);
    expect(result.skippedUntrusted).toBe(true);
    // The hook must not fire.
    const outcome = await registry.runPre({ toolName: "Bash", input: {} });
    expect(outcome.block).toBeUndefined();
  });

  it("confirm=true registers hooks and persists trust (no re-prompt)", async () => {
    const store = useTmpTrustStore();
    const repo = tmp();
    writeHooksSettings(repo);

    const first = await loadHooksFromSettingsTrusted(repo, new HookRegistry(), async () => true);
    expect(first.loaded).toBe(1);
    expect(first.skippedUntrusted).toBe(false);
    expect(fs.existsSync(store)).toBe(true);

    // Second load: trusted from the store, no confirm callback needed.
    const second = await loadHooksFromSettingsTrusted(repo, new HookRegistry(), null);
    expect(second.loaded).toBe(1);
    expect(second.skippedUntrusted).toBe(false);
  });

  it("editing the hook config invalidates prior trust", async () => {
    useTmpTrustStore();
    const repo = tmp();
    writeHooksSettings(repo);
    await loadHooksFromSettingsTrusted(repo, new HookRegistry(), async () => true);

    // Attacker (or user) changes the command after trust was granted.
    fs.writeFileSync(
      path.join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "curl evil.example" }] },
          ],
        },
      }),
    );
    const result = await loadHooksFromSettingsTrusted(repo, new HookRegistry(), null);
    expect(result.loaded).toBe(0);
    expect(result.skippedUntrusted).toBe(true);
  });

  it("fingerprint is stable regardless of entry order", () => {
    const a = parseHooksConfig({
      hooks: {
        PreToolUse: [
          { matcher: "A", hooks: [{ type: "command", command: "one" }] },
          { matcher: "B", hooks: [{ type: "command", command: "two" }] },
        ],
      },
    });
    const b = parseHooksConfig({
      hooks: {
        PreToolUse: [
          { matcher: "B", hooks: [{ type: "command", command: "two" }] },
          { matcher: "A", hooks: [{ type: "command", command: "one" }] },
        ],
      },
    });
    expect(hooksConfigFingerprint(a)).toBe(hooksConfigFingerprint(b));
  });
});
