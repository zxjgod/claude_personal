// Slash commands write straight to the parent terminal with console.log —
// there is no Ink <Text> wrapper between them and stdout, so nothing strips
// terminal control bytes for us. Every field a command prints that comes from
// outside the user's own keystrokes (git output, SKILL.md / CLAUDE.md /
// .claude/providers.json file content, MCP server declarations, agent
// definitions, model-authored memories and workflow logs) must pass through
// sanitizeTerminalText first.
//
// Each case here poisons one field with an OSC window-title sequence and
// asserts the emitted frame no longer carries it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listChanges } from "../change-tracker.js";
import { commitCommand } from "../commands/commit.js";
import { configCommand } from "../commands/config.js";
import { contextCommand } from "../commands/context.js";
import { diffCommand } from "../commands/diff.js";
import { bindCommandList, helpCommand } from "../commands/help.js";
import { hooksCommand } from "../commands/hooks.js";
import { keybindingsCommand } from "../commands/keybindings.js";
import { loopCommand } from "../commands/loop.js";
import { mcpCommand } from "../commands/mcp.js";
import { memoryCommand } from "../commands/memory.js";
import { outputStyleCommand } from "../commands/output-style.js";
import { permissionsCommand } from "../commands/permissions.js";
import { prCommand } from "../commands/pr.js";
import { providerCommand } from "../commands/provider.js";
import { releaseNotesCommand } from "../commands/release-notes.js";
import { skillsCommand } from "../commands/skills.js";
import { statusCommand } from "../commands/status.js";
import { toolsCommand } from "../commands/tools.js";
import type { CommandContext, SlashCommand } from "../commands/types.js";
import { workflowsCommand } from "../commands/workflows.js";
import { gatherDiffSummary } from "../git-context.js";
import { listOutputStyles } from "../output-style.js";
import { loadProviderProfiles } from "../provider-profiles.js";
import { listSkills, registerSkill, resetSkills } from "../skills.js";
import { listWakeupJobs } from "../tools/extended/schedule-wakeup.js";
import { loadUserBindings, parseBindings } from "../tui/keybindings/index.js";
import type { Tool } from "../types.js";
import { APP_VERSION } from "../version.js";
import { listWorkflows } from "../workflow.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// OSC "set window title" terminated by BEL — the payload a malicious file or
// git subject would embed.
const POISON = `${ESC}]0;pwned${BEL}`;
const POISON_ALT = `${ESC}[?25l`; // DECSET cursor-hide (private CSI)

function assertNoControlSequences(out: string): void {
  expect(out).not.toContain(POISON);
  expect(out).not.toContain(POISON_ALT);
  expect(out).not.toContain(ESC);
}

// ---------------------------------------------------------------------------
// mocks for commands that read from git / the filesystem
// ---------------------------------------------------------------------------
vi.mock("../git-context.js", () => ({
  gatherDiffSummary: vi.fn(),
  suggestCommitSubject: vi.fn(() => "feat: add thing"),
}));
vi.mock("../change-tracker.js", () => ({ listChanges: vi.fn(() => []) }));
vi.mock("../provider-profiles.js", () => ({
  applyProfile: vi.fn(),
  findProfile: vi.fn(),
  loadProviderProfiles: vi.fn(),
  providersFilePath: vi.fn(() => "C:/ws/.claude/providers.json"),
}));
vi.mock("../output-style.js", () => ({
  getOutputStyle: vi.fn(() => null),
  listOutputStyles: vi.fn(() => []),
}));
vi.mock("../workflow.js", () => ({ listWorkflows: vi.fn(() => []) }));
vi.mock("../tools/extended/schedule-wakeup.js", () => ({
  cancelAllWakeupJobs: vi.fn(),
  listWakeupJobs: vi.fn(() => []),
}));
vi.mock("../tui/keybindings/index.js", () => ({
  chordToString: vi.fn(() => "ctrl+k"),
  loadUserBindings: vi.fn(() => "{}"),
  parseBindings: vi.fn(() => []),
}));
const memoryMocks = vi.hoisted(() => ({
  listed: [] as Array<{ text: string; tags?: string[] }>,
  extracted: [] as Array<{ text: string; tags?: string[] }>,
  changelog: "",
}));
vi.mock("../memory-extract.js", () => ({
  MemoryStore: class {
    get path() {
      return ".claude/memories.jsonl";
    }
    list() {
      return memoryMocks.listed;
    }
    append(candidates: unknown[]) {
      return candidates;
    }
  },
  extractMemoriesHeuristic: vi.fn(() => memoryMocks.extracted),
  extractMemoriesWithModel: vi.fn(async () => memoryMocks.extracted),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      if (typeof p === "string" && p.includes("CHANGELOG.md")) return memoryMocks.changelog;
      return (actual.readFileSync as (...args: unknown[]) => unknown)(p, ...rest);
    },
  };
});

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    messages: [],
    modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "test" },
    callModel: async function* () {},
    workspaceRoot: "/workspace",
    sessionId: "sess-1",
    systemPrompt: "system",
    ...overrides,
  };
}

let captured: string[] = [];

async function run(cmd: SlashCommand, args: string, ctx: CommandContext): Promise<string> {
  await cmd.run(args, ctx);
  return captured.join("\n");
}

beforeEach(() => {
  captured = [];
  memoryMocks.listed.length = 0;
  memoryMocks.extracted.length = 0;
  memoryMocks.changelog = "";
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSkills();
});

describe("slash command output sanitization", () => {
  it("/help — disk command descriptions carry no control sequences", async () => {
    bindCommandList(() => [
      {
        name: `evil${POISON}`,
        description: `desc${POISON_ALT}`,
        run: () => undefined,
      },
    ]);
    const out = await run(helpCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("evil");
    expect(out).toContain("desc");
  });

  it("/skills — SKILL.md frontmatter is sanitized", async () => {
    registerSkill({
      name: `skill${POISON}`,
      description: `desc${POISON_ALT}`,
      whenToUse: "when",
      allowedTools: [],
      path: "/x/SKILL.md",
    } as never);
    const out = await run(skillsCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("skill");
    expect(out).toContain("desc");
  });

  it("/context — skill names are sanitized in the context breakdown", async () => {
    registerSkill({
      name: `ctxskill${POISON}`,
      description: "d",
      whenToUse: "w",
      allowedTools: [],
      path: "/x/SKILL.md",
    } as never);
    const out = await run(contextCommand, "", makeContext({ systemPrompt: "p".repeat(400) }));
    assertNoControlSequences(out);
    expect(out).toContain("ctxskill");
  });

  it("/tools — MCP tool names and descriptions are sanitized", async () => {
    const tool = {
      name: `mcp__srv__${POISON}`,
      description: `desc${POISON_ALT}`,
      inputSchema: { type: "object", properties: {} },
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      requiresApproval: () => false,
    } as unknown as Tool;
    const out = await run(toolsCommand, "", makeContext({ tools: [{ tool, source: "mcp" }] }));
    assertNoControlSequences(out);
    expect(out).toContain("mcp__srv__");
  });

  it("/hooks — a settings.json matcher is sanitized", async () => {
    const hooks = {
      list: () => [
        { matcher: `Bash${POISON}`, pre: {}, post: null, stop: null, event: null, command: "x" },
      ],
    } as unknown as NonNullable<CommandContext["hooks"]>;
    const out = await run(hooksCommand, "", makeContext({ hooks }));
    assertNoControlSequences(out);
    expect(out).toContain("Bash");
  });

  it("/permissions — remembered always-allow rules are sanitized", async () => {
    const permissions = {
      listAlwaysAllow: () => [`Bash(npm run build)${POISON}`],
      clearAlwaysAllow: () => {},
    };
    const out = await run(permissionsCommand, "list", makeContext({ permissions }));
    assertNoControlSequences(out);
    expect(out).toContain("npm run build");
  });

  it("/mcp — server and tool names are sanitized", async () => {
    const tool = {
      name: `mcp__srv${POISON}__${POISON_ALT}tool`,
      description: "d",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      requiresApproval: () => false,
    } as unknown as Tool;
    const mcpManager = {
      refresh: vi.fn(),
      getAllTools: () => [tool],
      serverCount: 1,
    } as unknown as NonNullable<CommandContext["mcpManager"]>;
    const out = await run(mcpCommand, "", makeContext({ mcpManager }));
    assertNoControlSequences(out);
    expect(out).toContain("srv");
  });

  it("/commit — git branch, subject and file paths are sanitized", async () => {
    vi.mocked(gatherDiffSummary).mockReturnValue({
      branch: `main${POISON}`,
      files: [{ path: `evil.ts${POISON_ALT}`, status: "M", insertions: 1, deletions: 0 }],
      branchCommits: [`commit subject${POISON}`],
      upstreamFiles: [],
    } as never);
    const out = await run(commitCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("evil.ts");
  });

  it("/pr — branch commits and file paths are sanitized", async () => {
    vi.mocked(gatherDiffSummary).mockReturnValue({
      branch: `feat${POISON}`,
      files: [],
      branchCommits: [`commit ${POISON_ALT}`],
      upstreamFiles: [{ path: `src/x.ts${POISON}`, status: "A", insertions: 1, deletions: 0 }],
    } as never);
    const out = await run(prCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("src/x.ts");
  });

  it("/diff — change-tracker paths are sanitized", async () => {
    vi.mocked(listChanges).mockReturnValue([
      { path: `notes.md${POISON}`, sessionId: "s", count: 2 },
    ] as never);
    const out = await run(diffCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("notes.md");
  });

  it("/provider — .claude/providers.json profile fields are sanitized", async () => {
    vi.mocked(loadProviderProfiles).mockReturnValue([
      {
        name: `relay${POISON}`,
        provider: "openai",
        model: `gpt${POISON_ALT}`,
        apiKey: "k",
      },
    ] as never);
    const out = await run(providerCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("relay");
  });

  it("/output-style — style name and description are sanitized", async () => {
    vi.mocked(listOutputStyles).mockReturnValue([
      { name: `loud${POISON}`, description: `d${POISON_ALT}`, content: "" },
    ] as never);
    const out = await run(outputStyleCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("loud");
  });

  it("/loop — pending wakeup prompts are sanitized", async () => {
    vi.mocked(listWakeupJobs).mockReturnValue([
      {
        id: `wake${POISON}`,
        prompt: `p${POISON_ALT}`,
        fireAt: process.hrtime.bigint() + 60_000_000_000n,
      },
    ] as never);
    const out = await run(loopCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("wake");
  });

  it("/workflows — model-authored log lines and result are sanitized", async () => {
    vi.mocked(listWorkflows).mockReturnValue([
      {
        id: `wf${POISON}`,
        status: "completed",
        startedAt: 0,
        finishedAt: 10,
        logs: [`log line${POISON_ALT}`],
        result: `result text${POISON}`,
      },
    ] as never);
    const out = await run(workflowsCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("log line");
  });

  it("/keybindings — keybinding context and action are sanitized", async () => {
    vi.mocked(loadUserBindings).mockReturnValue("{}" as never);
    vi.mocked(parseBindings).mockReturnValue([
      { chord: { key: "k", ctrl: true }, context: `chat${POISON}`, action: `send${POISON_ALT}` },
    ] as never);
    const out = await run(keybindingsCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("chat");
  });

  it("/status — model config fields are sanitized", async () => {
    const out = await run(
      statusCommand,
      "",
      makeContext({
        modelConfig: {
          provider: `p${POISON}` as "openai",
          model: `m${POISON_ALT}`,
          apiKey: "k",
          baseURL: `https://x${POISON}`,
        },
      }),
    );
    assertNoControlSequences(out);
    expect(out).toContain("gpt-4o".slice(0, 1));
  });

  it("/config — model config fields are sanitized", async () => {
    const out = await run(
      configCommand,
      "",
      makeContext({
        modelConfig: {
          provider: `p${POISON}` as "openai",
          model: `m${POISON_ALT}`,
          apiKey: "k",
        },
      }),
    );
    assertNoControlSequences(out);
    expect(out).toContain("Provider");
  });

  it("/memory — CLAUDE.md content is sanitized", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mem-cmd-"));
    writeFileSync(join(tmp, "CLAUDE.md"), `# notes\n- remember ${POISON}\n- also ${POISON_ALT}\n`);
    try {
      const out = await run(memoryCommand, "", makeContext({ workspaceRoot: tmp }));
      assertNoControlSequences(out);
      expect(out).toContain("remember");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("/memory list — stored memory text and tags are sanitized", async () => {
    memoryMocks.listed.push({ text: `fact${POISON}`, tags: [`t${POISON_ALT}`] });
    const out = await run(memoryCommand, "list", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("fact");
  });

  it("/memory extract — extracted memory text is sanitized", async () => {
    memoryMocks.extracted.push({ text: `learned${POISON}`, tags: [`t${POISON_ALT}`] });
    const out = await run(memoryCommand, "extract", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("learned");
  });

  it("/release-notes — changelog body is sanitized", async () => {
    memoryMocks.changelog = `# Changelog\n\n## v${APP_VERSION}\n### 使用影响\n- line with ${POISON}\n\n## v1.0.0\n- old\n`;
    const out = await run(releaseNotesCommand, "", makeContext());
    assertNoControlSequences(out);
    expect(out).toContain("line with");
  });

  it("listSkills() callers still receive the raw value (display-only fix)", () => {
    registerSkill({
      name: "safe-name",
      description: "d",
      whenToUse: "w",
      allowedTools: [],
      path: "/x/SKILL.md",
    } as never);
    expect(listSkills().some((s) => s.name === "safe-name")).toBe(true);
  });
});
