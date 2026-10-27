import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportCommand } from "../commands/export.js";
import { shareCommand } from "../commands/share.js";
import type { CommandContext } from "../commands/types.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-export-overwrite-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function makeContext(): CommandContext {
  return {
    workspaceRoot: root,
    sessionId: "session-1234567890",
    messages: [{ role: "user", content: [{ type: "text", text: "original content" }] }],
    modelConfig: { provider: "openai", model: "test-model" },
  } as unknown as CommandContext;
}

function setText(ctx: CommandContext, text: string): void {
  ctx.messages = [{ role: "user", content: [{ type: "text", text }] }];
}

function consoleOutput(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => call.join(" "))
    .join("\n");
}

describe.each([exportCommand, shareCommand])("$name overwrite protection", (command) => {
  it("uses wx by default and allows explicit force with spaced paths", async () => {
    const ctx = makeContext();
    const requested = path.join("folder with spaces", "transcript final.md");
    const target = path.join(root, requested);

    await command.run(requested, ctx);
    expect(fs.readFileSync(target, "utf8")).toContain("original content");

    setText(ctx, "must not replace this");
    await command.run(requested, ctx);
    expect(fs.readFileSync(target, "utf8")).toContain("original content");
    expect(fs.readFileSync(target, "utf8")).not.toContain("must not replace this");
    expect(consoleOutput()).toContain("--force");

    setText(ctx, "prefix force replacement");
    await command.run(`--force ${requested}`, ctx);
    expect(fs.readFileSync(target, "utf8")).toContain("prefix force replacement");

    setText(ctx, "trailing force replacement");
    await command.run(`${requested} --force`, ctx);
    const final = fs.readFileSync(target, "utf8");
    expect(final).toContain("trailing force replacement");
    expect(final).not.toContain("prefix force replacement");
  });
});
