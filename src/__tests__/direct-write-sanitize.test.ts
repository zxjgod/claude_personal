// ============================================================
// Tests: round-7 direct-write sanitize sweep
// ============================================================
// Sites found by the tool-layer/REPL console.* scan:
//   1. /share with no path prints the transcript (assistant text is
//      model-produced) raw to stdout — must sanitize the PRINT, while the
//      file-write path keeps the raw export document.
//   2. formatNotificationLine embeds background-task summaries (model/shell
//      produced) — sanitize inside the human-facing formatter.
//   3. ToolRegistry's canonical-collision warning prints tool names that can
//      come from remote MCP servers — sanitize before console.error.
//   4. warnUnknownSettings prints keys from (untrusted) project settings.json.
//   5. cli-repl thinking_delta bypasses the markdown renderer (the text path
//      gets sanitized inside cli-renderer) — guard that the raw stream write
//      passes through sanitizeTerminalText.
// Control bytes are built with String.fromCharCode so the source file stays
// free of literal ESC/BEL.
// ============================================================

import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderShareableTranscript, shareCommand } from "../commands/share.js";
import type { CommandContext } from "../commands/types.js";
import { warnUnknownSettings } from "../hooks-config.js";
import { formatNotificationLine } from "../tools/notifications.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../types.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_TITLE = `${ESC}]0;pwned${BEL}`;

function shareCtx(): CommandContext {
  return {
    modelConfig: { model: "m", provider: "p" },
    workspaceRoot: process.cwd(),
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: `safe ${OSC_TITLE} tail` },
    ],
  } as unknown as CommandContext;
}

describe("/share stdout print sanitizes model text", () => {
  afterEach(() => vi.restoreAllMocks());

  it("strips control sequences from the printed transcript", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    shareCommand.run("", shareCtx());
    const out = writes.join("");
    expect(out).toContain("safe  tail");
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
  });

  it("keeps the raw export document intact (file path is not a terminal)", () => {
    const md = renderShareableTranscript(shareCtx());
    expect(md).toContain(OSC_TITLE);
  });
});

describe("formatNotificationLine", () => {
  it("strips control sequences from task-produced fields", () => {
    const line = formatNotificationLine({
      id: "job-3",
      kind: "bash",
      status: "done",
      summary: `finished ${OSC_TITLE}`,
    });
    expect(line).not.toContain(ESC);
    expect(line).not.toContain(BEL);
    expect(line).toContain("finished");
  });
});

describe("ToolRegistry collision warning", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sanitizes (possibly remote MCP) tool names in the warning", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = new ToolRegistry();
    const tainted = `EvilTool${OSC_TITLE}`;
    const colliding = `evil_tool${OSC_TITLE}`; // same canonical key
    registry.register({ name: tainted, description: "a" } as unknown as Tool);
    registry.register({ name: colliding, description: "b" } as unknown as Tool);
    expect(err).toHaveBeenCalledTimes(1);
    const printed = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("canonically collides");
    expect(printed).not.toContain(ESC);
    expect(printed).not.toContain(BEL);
  });
});

describe("warnUnknownSettings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sanitizes settings keys from untrusted project settings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = `bogus${OSC_TITLE}`;
    const unknown = warnUnknownSettings({ [key]: true });
    expect(unknown).toEqual([key]); // return value stays raw (programmatic)
    expect(warn).toHaveBeenCalledTimes(1);
    const printed = String(warn.mock.calls[0][0]);
    expect(printed).not.toContain(ESC);
    expect(printed).not.toContain(BEL);
  });
});

describe("cli-repl thinking stream (source guard)", () => {
  it("the thinking_delta raw write passes through sanitizeTerminalText", () => {
    // thinking_delta deliberately bypasses the markdown renderer — the place
    // where text deltas get sanitized — so this write is the only barrier
    // between model reasoning prose and the terminal. Guard the call shape.
    const src = fs.readFileSync(new URL("../cli-repl.ts", import.meta.url), "utf-8");
    const block = src.slice(src.indexOf('case "thinking_delta"'));
    const handler = block.slice(0, block.indexOf("break;"));
    expect(handler).toContain("sanitizeTerminalText(event.delta)");
  });
});
