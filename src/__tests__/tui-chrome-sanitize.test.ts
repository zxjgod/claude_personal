// ============================================================
// Tests: terminal sanitization of the TUI chrome (round 5)
// ============================================================
// Round 4 pinned the render chain (markdown / diff / transcript rows). Round 5
// adds the chrome layer: tool labels, the permission / question /
// elicitation overlays, the pickers and the i18n interpolation all passed
// model- or disk-supplied strings through unescaped, plus the two slash
// commands that print stored records straight to stdout. Ink itself strips
// embedded control sequences from <Text>, so the overlay fixes are hardening
// rather than an exploit fix — these tests therefore assert on the store's
// DATA (and on captured stdout for the commands), not on a rendered frame.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentsCommand } from "../commands/agents.js";
import { scheduleCommand } from "../commands/schedule.js";
import type { CommandContext } from "../commands/types.js";
import { setLanguage, t } from "../tui/i18n.js";
import { parseError } from "../tui/markdown.js";
import { actionLabel } from "../tui/spinner-core.js";
import { TuiStore } from "../tui/store.js";

chalk.level = 1;
beforeAll(() => setLanguage("en"));

/** An OSC 52 clipboard write, the payload every assertion below hunts for. */
const OSC52 = "\x1b]52;c;SGVsbG8hHGludmFkaW5nIQ==\x07";
/** A DEC private-mode CSI (cursor visibility) with the `?` marker. */
const PRIVATE_CSI = "\x1b[?25l";

/** Assert no control payload survived into `text`. */
function expectClean(text: string, keep?: string): void {
  if (keep) expect(text).toContain(keep);
  expect(text).not.toContain("52;c");
  expect(text).not.toContain("\x07");
  expect(text).not.toContain("[?25l");
}

describe("actionLabel (live tool card)", () => {
  it("strips control sequences from the tool name", () => {
    // An MCP server controls the tool name; the fallback branch echoes it.
    const label = actionLabel(`srv__weird${OSC52}`, "");
    expectClean(label, "weird");
  });

  it("strips control sequences from the detail line", () => {
    const label = actionLabel("read", `/etc/hosts${PRIVATE_CSI}`);
    expectClean(label, "hosts");
  });
});

describe("parseError (structured tool error)", () => {
  it("strips control sequences from the parsed message", () => {
    const parsed = parseError(`ENOENT: no such file\n  at ${OSC52} (fs.readFile)`);
    // parseError splits the "ENOENT: " prefix off into `type`; the message is
    // the remainder — which is where a payload hidden mid-stack would land.
    expectClean(parsed.message, "no such file");
  });
});

describe("i18n t()", () => {
  it("sanitizes string parameters", () => {
    // Several placeholders carry untrusted text (a compaction-summary snippet,
    // an unknown tool's name, a retry reason from the API server).
    const out = t("ui.retry.status", { reason: `429 ${OSC52}`, s: 8, a: 1, m: 3 });
    expectClean(out, "429");
  });

  it("still interpolates numbers", () => {
    expect(t("ui.retry.now", { reason: "timeout", a: 2, m: 5 })).toContain("timeout");
  });
});

describe("TuiStore overlays (the Ink prompt chokepoint)", () => {
  it("sanitizes the permission dialog's model-authored fields", () => {
    const store = new TuiStore("p/m");
    const pending = store.askPermission(
      `Bash request${OSC52}`,
      `rm -rf /tmp${OSC52}`,
      `recursive delete${PRIVATE_CSI}`,
      undefined,
      undefined,
      { subtitle: `sub${OSC52}`, description: `desc${OSC52}` },
    );
    const overlay = store.getSnapshot().overlay;
    expect(overlay).not.toBeNull();
    if (overlay?.kind !== "permission") throw new Error("expected a permission overlay");
    expectClean(overlay.header, "Bash request");
    expectClean(overlay.detail ?? "", "rm -rf");
    expectClean(overlay.riskHint ?? "", "recursive delete");
    expectClean(overlay.subtitle ?? "", "sub");
    expectClean(overlay.description ?? "", "desc");
    overlay.resolve("no");
    void pending;
  });

  it("sanitizes the question prompt's option labels and descriptions", () => {
    const store = new TuiStore("p/m");
    const pending = store.askQuestion(
      `Which?${OSC52}`,
      `pick one${PRIVATE_CSI}`,
      [{ label: `A${OSC52}`, description: `first${OSC52}`, preview: `p${OSC52}` }],
      false,
    );
    const overlay = store.getSnapshot().overlay;
    if (overlay?.kind !== "question") throw new Error("expected a question overlay");
    expectClean(overlay.question, "pick one");
    expectClean(overlay.options[0]?.label ?? "", "A");
    expectClean(overlay.options[0]?.description ?? "", "first");
    expectClean(overlay.options[0]?.preview ?? "", "p");
    overlay.resolve(null);
    void pending;
  });

  it("sanitizes the elicitation prompt's display fields but keeps the answer key intact", () => {
    const store = new TuiStore("p/m");
    const pending = store.askElicitation(`server says${OSC52}`, [
      {
        name: `field${OSC52}`,
        title: `Title${OSC52}`,
        description: `d${OSC52}`,
        enum: [`a${OSC52}`],
      },
    ]);
    const overlay = store.getSnapshot().overlay;
    if (overlay?.kind !== "elicitation") throw new Error("expected an elicitation overlay");
    expectClean(overlay.message, "server says");
    expectClean(overlay.fields[0]?.title ?? "", "Title");
    expectClean(overlay.fields[0]?.enum?.[0] ?? "", "a");
    // `name` is the key of the submitted content record — sanitizing it would
    // make the server reject our answer.
    expect(overlay.fields[0]?.name).toContain("52;c");
    overlay.resolve({ action: "cancel" });
    void pending;
  });

  it("sanitizes the session picker's label and preview (read back from disk)", () => {
    const store = new TuiStore("p/m");
    const pending = store.pickSession([
      { sessionId: "s1", label: `2026-10-04${OSC52}`, preview: `first user msg${PRIVATE_CSI}` },
    ]);
    const overlay = store.getSnapshot().overlay;
    if (overlay?.kind !== "sessionPicker") throw new Error("expected a sessionPicker overlay");
    expectClean(overlay.sessions[0]?.label ?? "", "2026-10-04");
    expectClean(overlay.sessions[0]?.preview ?? "", "first user msg");
    overlay.resolve(null);
    void pending;
  });

  it("sanitizes the rewind picker's label (a user message replayed from disk)", () => {
    const store = new TuiStore("p/m");
    const pending = store.askRewind([
      {
        turnIndex: 1,
        label: `first turn${OSC52}`,
        timestamp: "2026-10-04 10:00",
        filesChanged: 1,
      },
    ]);
    const overlay = store.getSnapshot().overlay;
    if (overlay?.kind !== "rewind") throw new Error("expected a rewind overlay");
    expectClean(overlay.entries[0]?.label ?? "", "first turn");
    overlay.resolve(null);
    void pending;
  });
});

describe("slash commands that print records from disk", () => {
  it("/agents history strips control sequences from the model-authored description", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-agents-hist-"));
    try {
      const sessionId = "sess-test";
      const dir = path.join(root, ".claude", "sessions", `subagents-${sessionId}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "run1.json"),
        JSON.stringify({
          agentId: "ag1",
          typeName: `general${OSC52}`,
          status: "completed",
          description: `triage the repo${OSC52}`,
          report: `found nothing${PRIVATE_CSI}`,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }),
        "utf-8",
      );
      const lines = captureConsole(() => {
        agentsCommand.run("history", ctxFor(root, sessionId));
      });
      expectClean(lines.join("\n"), "triage the repo");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("/schedule strips control sequences from durable job prompts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-schedule-"));
    try {
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".claude", "scheduled_tasks.json"),
        JSON.stringify({
          version: 1,
          jobs: [
            {
              id: `job1${OSC52}`,
              cron: "0 9 * * *",
              prompt: `run the report${OSC52}`,
              recurring: true,
              createdAtMs: 1,
            },
          ],
        }),
        "utf-8",
      );
      const lines = captureConsole(() => {
        scheduleCommand.run("", ctxFor(root, "sess-test"));
      });
      expectClean(lines.join("\n"), "run the report");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- helpers ---------------------------------------------------------------

/** Minimal CommandContext: the two commands under test only read these. */
function ctxFor(workspaceRoot: string, sessionId: string): CommandContext {
  return {
    messages: [],
    workspaceRoot,
    sessionId,
    modelConfig: { provider: "openai", model: "test" } as CommandContext["modelConfig"],
    callModel: (() => {
      throw new Error("not used");
    }) as unknown as CommandContext["callModel"],
  };
}

/** Run `fn` with console.log captured. */
function captureConsole(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}
