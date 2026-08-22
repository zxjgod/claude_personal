// ============================================================
// Tests: slash commands
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordChange, resetChangeTracker } from "../change-tracker.js";
import { type CommandContext, handleSlashCommand } from "../commands.js";
import { registerSkill, resetSkills } from "../skills.js";
import { SessionStats } from "../tui/session-stats.js";
import type { Message, ModelCaller, ModelConfig } from "../types.js";

// A model caller that yields a single text + done (used by /compact).
const fakeCaller: ModelCaller = async function* () {
  yield { type: "text_delta", delta: "summary" } as any;
  yield {
    type: "done",
    usage: { input_tokens: 1, output_tokens: 1 },
  } as any;
};

function makeCtx(messages: Message[]): CommandContext {
  return {
    messages,
    modelConfig: { provider: "openai", model: "gpt-4o", apiKey: "k" } as ModelConfig,
    callModel: fakeCaller,
    workspaceRoot: "/tmp/ws",
    sessionId: "sess1234",
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  resetSkills();
});

describe("handleSlashCommand", () => {
  it("returns handled=false for normal text", async () => {
    const r = await handleSlashCommand("hello there", makeCtx([]));
    expect(r.handled).toBe(false);
  });

  it("recognizes /help", async () => {
    const r = await handleSlashCommand("/help", makeCtx([]));
    expect(r.handled).toBe(true);
  });

  it("/clear empties the message array in place", async () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const r = await handleSlashCommand("/clear", makeCtx(messages));
    expect(r.handled).toBe(true);
    expect(messages).toHaveLength(0);
  });

  it("/model <id> switches the active model", async () => {
    const ctx = makeCtx([]);
    await handleSlashCommand("/model claude-opus-4-8", ctx);
    expect(ctx.modelConfig.model).toBe("claude-opus-4-8");
  });

  it("/model with no args leaves the model unchanged", async () => {
    const ctx = makeCtx([]);
    await handleSlashCommand("/model", ctx);
    expect(ctx.modelConfig.model).toBe("gpt-4o");
  });

  it("reports unknown commands as handled", async () => {
    const r = await handleSlashCommand("/bogus", makeCtx([]));
    expect(r.handled).toBe(true);
  });

  it("is case-insensitive on the command name", async () => {
    const r = await handleSlashCommand("/HELP", makeCtx([]));
    expect(r.handled).toBe(true);
  });

  it("/tokens on/off toggles token display", async () => {
    const ctx = makeCtx([]);
    ctx.ui = { showTokens: false, verbose: false };
    await handleSlashCommand("/tokens on", ctx);
    expect(ctx.ui.showTokens).toBe(true);
    await handleSlashCommand("/tokens off", ctx);
    expect(ctx.ui.showTokens).toBe(false);
  });

  it("/doctor reports environment status", async () => {
    const ctx = makeCtx([]);
    const r = await handleSlashCommand("/doctor", ctx);
    expect(r.handled).toBe(true);
    expect(console.log).toHaveBeenCalled();
  });

  it("/permissions shows and clears always-allow memory", async () => {
    const items = ["edit::a.txt"];
    const ctx = makeCtx([]);
    ctx.permissions = {
      listAlwaysAllow: () => items,
      clearAlwaysAllow: () => {
        items.length = 0;
      },
    };
    await handleSlashCommand("/permissions", ctx);
    expect(items).toEqual(["edit::a.txt"]);
    await handleSlashCommand("/permissions clear", ctx);
    expect(items).toEqual([]);
  });

  it("/sessions lists saved sessions", async () => {
    const ctx = makeCtx([]);
    ctx.persistence = {
      searchSessions: async () => [
        {
          sessionId: "abc123",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          messageCount: 2,
          completed: false,
          pinned: true,
          preview: "hello there",
        },
      ],
    } as any;
    const r = await handleSlashCommand("/sessions", ctx);
    expect(r.handled).toBe(true);
    expect(console.log).toHaveBeenCalled();
  });

  it("/sessions pin and search use the catalog helpers", async () => {
    const ctx = makeCtx([]);
    const calls: string[] = [];
    const setPinned = vi.fn(async () => {});
    ctx.persistence = {
      listSessions: async () => [
        {
          sessionId: "abc123456789",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          messageCount: 2,
          completed: false,
          taskState: "paused",
        },
      ],
      searchSessions: async (query: string) => {
        calls.push(query);
        return query
          ? [
              {
                sessionId: "abc123456789",
                createdAt: "2026-06-19T00:00:00.000Z",
                updatedAt: "2026-06-19T00:00:00.000Z",
                messageCount: 2,
                completed: false,
                taskState: "paused",
                pinned: true,
                preview: "needle in haystack",
              },
            ]
          : [];
      },
      load: async () => null,
      setPinned,
      deleteSession: vi.fn(async () => {}),
    } as any;

    await handleSlashCommand("/sessions search needle", ctx);
    await handleSlashCommand("/sessions pin abc123", ctx);
    expect(calls).toContain("needle");
    expect(setPinned).toHaveBeenCalledWith("abc123456789", true);
  });

  it("/sessions delete removes a uniquely matched session", async () => {
    const ctx = makeCtx([]);
    const deleteSession = vi.fn(async () => {});
    ctx.persistence = {
      listSessions: async () => [
        {
          sessionId: "abc123456789",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          messageCount: 2,
          completed: false,
        },
      ],
      deleteSession,
    } as any;
    await handleSlashCommand("/sessions delete abc123", ctx);
    expect(deleteSession).toHaveBeenCalledWith("abc123456789");
  });

  it("/sessions delete refuses ambiguous prefixes", async () => {
    const ctx = makeCtx([]);
    const deleteSession = vi.fn(async () => {});
    ctx.persistence = {
      listSessions: async () => [
        {
          sessionId: "abc123456789",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          messageCount: 2,
          completed: false,
        },
        {
          sessionId: "abc999999999",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          messageCount: 3,
          completed: true,
        },
      ],
      deleteSession,
    } as any;
    await handleSlashCommand("/sessions delete abc", ctx);
    expect(deleteSession).not.toHaveBeenCalled();
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("Ambiguous session prefix");
  });

  it("/resume delegates to resumeSession", async () => {
    const ctx = makeCtx([]);
    const resume = vi.fn(async () => true);
    ctx.resumeSession = resume;
    const r = await handleSlashCommand("/resume abc", ctx);
    expect(r.handled).toBe(true);
    expect(resume).toHaveBeenCalledWith("abc");
  });

  it("/status reports session info", async () => {
    const ctx = makeCtx([]);
    ctx.stats = new SessionStats();
    ctx.stats.addUsage(100, 50);
    ctx.permissionMode = "default";
    const r = await handleSlashCommand("/status", ctx);
    expect(r.handled).toBe(true);
    expect(console.log).toHaveBeenCalled();
  });

  it("/cost reports tokens and estimated cost for a known model", async () => {
    const ctx = makeCtx([]);
    ctx.modelConfig.model = "claude-opus-4-8";
    ctx.stats = new SessionStats();
    ctx.stats.addUsage(1000, 500);
    const r = await handleSlashCommand("/cost", ctx);
    expect(r.handled).toBe(true);
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("Est. cost");
  });

  it("/cost notes unknown pricing", async () => {
    const ctx = makeCtx([]);
    ctx.modelConfig.model = "some-unknown-model";
    ctx.stats = new SessionStats();
    ctx.stats.addUsage(1000, 500);
    await handleSlashCommand("/cost", ctx);
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("unknown");
  });

  it("/tools lists tools with source", async () => {
    const ctx = makeCtx([]);
    ctx.tools = [
      {
        tool: {
          name: "read",
          description: "Read a file",
          isReadOnly: () => true,
        } as any,
        source: "core",
      },
    ];
    const r = await handleSlashCommand("/tools", ctx);
    expect(r.handled).toBe(true);
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("read");
  });

  it("/context estimates token composition", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "x".repeat(40) }] },
    ];
    const ctx = makeCtx(messages);
    ctx.systemPrompt = "y".repeat(80);
    const r = await handleSlashCommand("/context", ctx);
    expect(r.handled).toBe(true);
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("Total");
  });

  it("/config shows runtime config", async () => {
    const ctx = makeCtx([]);
    const r = await handleSlashCommand("/config", ctx);
    expect(r.handled).toBe(true);
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("gpt-4o");
  });

  it("/effort with no args shows the slider and default tier", async () => {
    const ctx = makeCtx([]);
    const r = await handleSlashCommand("/effort", ctx);
    expect(r.handled).toBe(true);
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("Effort");
    expect(out).toContain("Effort levels");
    expect(out).toContain("OpenAI-compatible");
    // Default tier is "high" when nothing is set.
    expect(out).toContain("high");
  });

  it("/effort <level> sets modelConfig.options.effort", async () => {
    const ctx = makeCtx([]);
    await handleSlashCommand("/effort xhigh", ctx);
    expect(ctx.modelConfig.options?.effort).toBe("xhigh");
  });

  it("/effort ultracode is accepted", async () => {
    const ctx = makeCtx([]);
    await handleSlashCommand("/effort ultracode", ctx);
    expect(ctx.modelConfig.options?.effort).toBe("ultracode");
  });

  it("/effort rejects unknown levels without mutating config", async () => {
    const ctx = makeCtx([]);
    ctx.modelConfig.options = { effort: "high" };
    await handleSlashCommand("/effort turbo", ctx);
    expect(ctx.modelConfig.options?.effort).toBe("high");
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("Unknown effort");
  });

  it("/compact shows staged progress", async () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const ctx = makeCtx(messages);
    const r = await handleSlashCommand("/compact", ctx);
    expect(r.handled).toBe(true);
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("Scanning");
    expect(out).toContain("Running compaction summary");
    expect(out).toContain("Compaction complete");
  });

  it("/diff lists session file changes", async () => {
    resetChangeTracker();
    const ctx = makeCtx([]);
    recordChange(ctx.sessionId, "src/a.ts", "created", "10 B");
    const r = await handleSlashCommand("/diff", ctx);
    expect(r.handled).toBe(true);
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("src/a.ts");
  });

  it("/diff reports no changes when none recorded", async () => {
    resetChangeTracker();
    const ctx = makeCtx([]);
    await handleSlashCommand("/diff", ctx);
    const out = (console.log as any).mock.calls.flat().join("\n");
    expect(out).toContain("No files changed");
  });

  describe("/memory and /init (temp workspace)", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-cmd-"));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function ctxFor(): CommandContext {
      const ctx = makeCtx([]);
      ctx.workspaceRoot = dir;
      return ctx;
    }

    it("/memory add appends a bullet to CLAUDE.md", async () => {
      const ctx = ctxFor();
      await handleSlashCommand("/memory add use tabs not spaces", ctx);
      const content = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
      expect(content).toContain("- use tabs not spaces");
    });

    it("/memory shows existing CLAUDE.md", async () => {
      fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Project\nhello", "utf-8");
      const ctx = ctxFor();
      await handleSlashCommand("/memory", ctx);
      const out = (console.log as any).mock.calls.flat().join("\n");
      expect(out).toContain("hello");
    });

    it("/init generates a scaffold and refuses to overwrite without force", async () => {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "demo", description: "a demo", scripts: { build: "tsc" } }),
        "utf-8",
      );
      const ctx = ctxFor();
      await handleSlashCommand("/init", ctx);
      const content = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
      expect(content).toContain("# " + path.basename(dir));
      expect(content).toContain("npm run build");

      // Second /init without force must not overwrite.
      fs.writeFileSync(path.join(dir, "CLAUDE.md"), "MANUAL", "utf-8");
      await handleSlashCommand("/init", ctx);
      expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8")).toBe("MANUAL");

      // /init force overwrites.
      await handleSlashCommand("/init force", ctx);
      expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8")).not.toBe("MANUAL");
    });
  });

  // ---- M18 new commands: /branch /fork /review /recap /share /rewind /onboarding ----

  describe("/rewind (M18.6)", () => {
    function ctxWith(messages: Message[]): CommandContext {
      return makeCtx(messages);
    }

    it("rewinds one user turn by default, dropping trailing assistant/tool msgs", async () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: "hi", tool_calls: [] },
        { role: "user", content: [{ type: "text", text: "second" }] },
        { role: "assistant", content: "yo", tool_calls: [] },
      ];
      await handleSlashCommand("/rewind", ctxWith(messages));
      // Removed the 2nd user turn + its assistant reply → back to 2 messages.
      expect(messages).toHaveLength(2);
      const first = messages[0] as { content: Array<{ text?: string }> };
      expect(first.content[0]?.text).toBe("first");
    });

    it("rewinds N turns when given a number", async () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: "1", tool_calls: [] },
        { role: "user", content: [{ type: "text", text: "b" }] },
        { role: "assistant", content: "2", tool_calls: [] },
        { role: "user", content: [{ type: "text", text: "c" }] },
        { role: "assistant", content: "3", tool_calls: [] },
      ];
      await handleSlashCommand("/rewind 2", ctxWith(messages));
      expect(messages).toHaveLength(2);
      const first = messages[0] as { content: Array<{ text?: string }> };
      expect(first.content[0]?.text).toBe("a");
    });

    it("rewinds everything when N >= turn count", async () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: "1", tool_calls: [] },
      ];
      await handleSlashCommand("/rewind 5", ctxWith(messages));
      expect(messages).toHaveLength(0);
    });

    it("is a no-op (handled) when there are no user turns", async () => {
      const messages: Message[] = [];
      const r = await handleSlashCommand("/rewind", ctxWith(messages));
      expect(r.handled).toBe(true);
      expect(messages).toHaveLength(0);
    });
  });

  describe("prompt-injecting commands (M18.3 / 18.4 / 18.7)", () => {
    it("/review returns a prompt to inject", async () => {
      const ctx = makeCtx([]);
      const r = await handleSlashCommand("/review", ctx);
      expect(r.handled).toBe(true);
      expect(r.prompt).toBeTruthy();
      expect(r.prompt).toContain("code reviewer");
    });

    it("/recap returns a prompt referencing the change list", async () => {
      resetChangeTracker();
      const ctx = makeCtx([
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: "hello", tool_calls: [] },
      ]);
      const r = await handleSlashCommand("/recap", ctx);
      expect(r.handled).toBe(true);
      expect(r.prompt).toBeTruthy();
      expect(r.prompt).toContain("no files changed");
    });

    it("/onboarding injects a prompt only when gaps exist", async () => {
      // Empty workspace in /tmp has no .env / no CLAUDE.md → gaps → prompt.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-onboard-"));
      try {
        const ctx = makeCtx([]);
        ctx.workspaceRoot = dir;
        const r = await handleSlashCommand("/onboarding", ctx);
        expect(r.handled).toBe(true);
        expect(r.prompt).toBeTruthy();
        expect(r.prompt).toContain("onboarding");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("/fork returns a prompt that seeds a sub-agent", async () => {
      const ctx = makeCtx([
        { role: "user", content: [{ type: "text", text: "do X" }] },
        { role: "assistant", content: "ok", tool_calls: [] },
      ]);
      const r = await handleSlashCommand("/fork", ctx);
      expect(r.handled).toBe(true);
      expect(r.prompt).toContain("task tool");
      expect(r.prompt).toContain("do X");
    });

    it("/fork refuses on an empty conversation", async () => {
      const ctx = makeCtx([]);
      const r = await handleSlashCommand("/fork", ctx);
      expect(r.handled).toBe(true);
      expect(r.prompt).toBeUndefined();
    });
  });

  describe("/share (M18.5)", () => {
    it("renders a compact shareable transcript to stdout when no path given", async () => {
      const ctx = makeCtx([
        { role: "user", content: [{ type: "text", text: "hello world" }] },
        { role: "assistant", content: "hi there", tool_calls: [] },
      ]);
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await handleSlashCommand("/share", ctx);
        const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("hello world");
        expect(out).toContain("hi there");
        expect(out).toContain("Assistant:");
      } finally {
        writeSpy.mockRestore();
      }
    });

    it("writes a markdown file when a path is given", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-share-"));
      try {
        const ctx = makeCtx([
          { role: "user", content: [{ type: "text", text: "ping" }] },
          { role: "assistant", content: "pong", tool_calls: [] },
        ]);
        ctx.workspaceRoot = dir;
        const target = path.join(dir, "out.md");
        await handleSlashCommand(`/share ${target}`, ctx);
        const content = fs.readFileSync(target, "utf-8");
        expect(content).toContain("ping");
        expect(content).toContain("pong");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("/branch (M18.1)", () => {
    it("snapshots current messages into a new session via persistence", async () => {
      const saved: { id: string; msgs: Message[] }[] = [];
      const ctx = makeCtx([
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: "yo", tool_calls: [] },
      ]);
      ctx.persistence = {
        generateId: () => "new-branch-id",
        save: async (id: string, msgs: Message[]) => {
          saved.push({ id, msgs });
        },
      } as any;
      const r = await handleSlashCommand("/branch", ctx);
      expect(r.handled).toBe(true);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.id).toBe("new-branch-id");
      expect(saved[0]!.msgs).toHaveLength(2);
      // Original messages untouched.
      expect(ctx.messages).toHaveLength(2);
    });

    it("refuses to branch an empty conversation", async () => {
      const ctx = makeCtx([]);
      ctx.persistence = { generateId: () => "x", save: async () => {} } as any;
      const r = await handleSlashCommand("/branch", ctx);
      expect(r.handled).toBe(true);
      expect(r.prompt).toBeUndefined();
    });
  });

  // ---- M18 batch 2: /hooks /schedule /goal /vim + /context-/doctor enhancements ----

  describe("/hooks (M18.13)", () => {
    it("reports when no hook registry is present", async () => {
      const ctx = makeCtx([]);
      const r = await handleSlashCommand("/hooks", ctx);
      expect(r.handled).toBe(true);
      const out = (console.log as any).mock.calls.flat().join("\n");
      expect(out).toContain("not available");
    });

    it("lists registered hooks with their matcher and phases", async () => {
      const { HookRegistry } = await import("../hooks.js");
      const reg = new HookRegistry();
      reg.register({ matcher: "*", pre: () => {} });
      reg.register({ matcher: "edit", post: () => {} });
      const ctx = makeCtx([]);
      ctx.hooks = reg;
      await handleSlashCommand("/hooks", ctx);
      const out = (console.log as any).mock.calls.flat().join("\n");
      expect(out).toContain("2 registered");
      expect(out).toContain("PreToolUse");
      expect(out).toContain("edit");
    });
  });

  describe("/schedule (M18.14)", () => {
    it("reports no jobs when none are scheduled", async () => {
      const { resetScheduledJobs } = await import("../tools/m8/m9.js");
      resetScheduledJobs();
      const r = await handleSlashCommand("/schedule", makeCtx([]));
      expect(r.handled).toBe(true);
      const out = (console.log as any).mock.calls.flat().join("\n");
      expect(out).toContain("Scheduled jobs (0)");
    });

    it("lists and cancels a scheduled job", async () => {
      const { ScheduleCronTool, resetScheduledJobs, listScheduledJobs } = await import(
        "../tools/m8/m9.js"
      );
      resetScheduledJobs();
      await ScheduleCronTool.call(
        { cron: "5 9 * * 1", prompt: "weekly recap", recurring: true } as any,
        { workspaceRoot: "/tmp/ws", sessionId: "s" } as any,
      );
      const [job] = listScheduledJobs();
      expect(job).toBeTruthy();

      await handleSlashCommand("/schedule", makeCtx([]));
      const out = (console.log as any).mock.calls.flat().join("\n");
      expect(out).toContain("weekly recap");

      await handleSlashCommand(`/schedule cancel ${job.id}`, makeCtx([]));
      expect(listScheduledJobs()).toHaveLength(0);
    });
  });

  describe("/goal (M18.12)", () => {
    it("sets, shows, and clears the session goal via the shared holder", async () => {
      const ctx = makeCtx([]);
      ctx.goal = { value: "" };
      await handleSlashCommand("/goal ship the M18 commands", ctx);
      expect(ctx.goal.value).toBe("ship the M18 commands");

      await handleSlashCommand("/goal", ctx);
      const out = (console.log as any).mock.calls.flat().join("\n");
      expect(out).toContain("ship the M18 commands");

      await handleSlashCommand("/goal clear", ctx);
      expect(ctx.goal.value).toBe("");
    });

    it("notes when goals are unavailable", async () => {
      const r = await handleSlashCommand("/goal whatever", makeCtx([]));
      expect(r.handled).toBe(true);
      const out = (console.log as any).mock.calls.flat().join("\n");
      expect(out).toContain("not available");
    });
  });

  describe("/vim (M18.10)", () => {
    it("toggles the editor mode holder", async () => {
      const ctx = makeCtx([]);
      ctx.editorMode = { value: "default" };
      await handleSlashCommand("/vim", ctx);
      expect(ctx.editorMode.value).toBe("vim");
      await handleSlashCommand("/vim", ctx);
      expect(ctx.editorMode.value).toBe("default");
    });

    it("sets explicitly with on/off", async () => {
      const ctx = makeCtx([]);
      ctx.editorMode = { value: "default" };
      await handleSlashCommand("/vim on", ctx);
      expect(ctx.editorMode.value).toBe("vim");
      await handleSlashCommand("/vim off", ctx);
      expect(ctx.editorMode.value).toBe("default");
    });

    it("notes when vim mode is unavailable (non-TUI)", async () => {
      const r = await handleSlashCommand("/vim", makeCtx([]));
      expect(r.handled).toBe(true);
      const out = (console.log as any).mock.calls.flat().join("\n");
      expect(out).toContain("interactive TUI");
    });
  });

  describe("/context compaction headroom (M18.8)", () => {
    it("shows the compaction window bar", async () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "x".repeat(40) }] },
      ];
      const ctx = makeCtx(messages);
      ctx.systemPrompt = "y".repeat(80);
      await handleSlashCommand("/context", ctx);
      const out = (console.log as any).mock.calls.flat().join("\n");
      expect(out).toContain("Compaction window");
      expect(out).toContain("headroom");
    });
  });

  describe("/doctor enhanced checks (M18.9)", () => {
    it("includes git and MCP lines", async () => {
      const ctx = makeCtx([]);
      ctx.mcpManager = { serverCount: 0, getAllTools: () => [] } as any;
      const r = await handleSlashCommand("/doctor", ctx);
      expect(r.handled).toBe(true);
      const out = (console.log as any).mock.calls.flat().join("\n");
      expect(out).toContain("Git:");
      expect(out).toContain("MCP:");
    });
  });

  describe("/<name> skill slash sugar (M37)", () => {
    it("expands an inline skill into a prompt Command", async () => {
      registerSkill({ name: "myskill", description: "d", prompt: "Run the playbook." });
      const r = await handleSlashCommand("/myskill extra args", makeCtx([]));
      expect(r.handled).toBe(true);
      expect(r.prompt).toContain("Run the playbook.");
      // Args ride along on the expanded prompt.
      expect(r.prompt).toContain("Arguments: extra args");
    });

    it("does NOT expand a fork skill via slash sugar (must use the Skill tool)", async () => {
      registerSkill({
        name: "forky",
        description: "d",
        context: "fork",
        getPromptForCommand: async () => "fork body",
      });
      const r = await handleSlashCommand("/forky", makeCtx([]));
      expect(r.handled).toBe(true);
      expect(r.prompt).toBeUndefined();
    });

    it("still reports unknown for a name that is neither command nor skill", async () => {
      const r = await handleSlashCommand("/definitely-not-a-thing", makeCtx([]));
      expect(r.handled).toBe(true);
      expect(r.prompt).toBeUndefined();
    });
  });
});
