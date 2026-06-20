// ============================================================
// Tests: slash commands
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleSlashCommand, type CommandContext } from "../commands.js";
import type { Message, ModelConfig, ModelCaller } from "../types.js";
import { SessionStats } from "../session-stats.js";
import { recordChange, resetChangeTracker } from "../change-tracker.js";

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
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
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
      listSessions: async () => [
        {
          sessionId: "abc123",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          messageCount: 2,
          completed: false,
        },
      ],
    } as any;
    const r = await handleSlashCommand("/sessions", ctx);
    expect(r.handled).toBe(true);
    expect(console.log).toHaveBeenCalled();
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
});
