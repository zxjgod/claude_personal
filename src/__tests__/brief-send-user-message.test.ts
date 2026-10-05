// Tests for the official `--brief` flag and the SendUserMessage tool it
// registers (src/tools/extended/send-user-message.ts).
//
// The gap these lock down: official's own one-liner for --brief is "Enable
// SendUserMessage tool for agent-to-user communication" — the tool IS the
// feature. Registering it unconditionally would advertise a channel the user
// never asked for, so the gating itself is part of the contract, not an
// implementation detail.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli-args.js";
import { parseBriefFlag } from "../cli-session-flags.js";
import { setupTools } from "../cli-tools.js";
import { buildSystemPrompt, renderSystemPrompt } from "../system-prompt.js";
import {
  SEND_USER_MESSAGE_TOOL_NAME,
  SendUserMessageTool,
} from "../tools/extended/send-user-message.js";
import type { ToolContext } from "../types.js";

const temporaries: string[] = [];
function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ccr-brief-")));
  temporaries.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function contextFor(workspaceRoot: string): ToolContext {
  return { workspaceRoot, sessionId: "brief-test", permissionMode: "default" };
}

describe("--brief parsing", () => {
  it("is a bare boolean that consumes no value", () => {
    expect(parseBriefFlag(["ccr"])).toBe(false);
    expect(parseBriefFlag(["ccr", "--brief"])).toBe(true);
    // Official prints no <value> placeholder, so the next token must survive as
    // the positional prompt — swallowing it would delete the user's question.
    expect(parseBriefFlag(["ccr", "--brief", "review the diff"])).toBe(true);
  });

  it("reaches CliArgs", () => {
    expect(parseCliArgs(["ccr"]).brief).toBe(false);
    expect(parseCliArgs(["ccr", "--brief"]).brief).toBe(true);
  });
});

describe("registration", () => {
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
  });

  async function setup(argv: string[]) {
    process.argv = ["node", "ccr", ...argv];
    return setupTools({ workspaceRoot: tempDir(), verbose: false });
  }

  it("registers SendUserMessage only under the flag", async () => {
    const without = await setup([]);
    expect(without.tools.map((t) => t.name)).not.toContain(SEND_USER_MESSAGE_TOOL_NAME);

    const with_ = await setup(["--brief"]);
    expect(with_.tools.map((t) => t.name)).toContain(SEND_USER_MESSAGE_TOOL_NAME);
    expect(with_.toolRegistry.getEnabledTools().map((t) => t.name)).toContain(
      SEND_USER_MESSAGE_TOOL_NAME,
    );
  });

  it("keeps the tool subject to --tools", async () => {
    // Registered BEFORE --tools is applied, so restricting the session to it
    // actually works instead of silently leaving the channel available.
    const only = await setup(["--brief", "--tools", "SendUserMessage"]);
    expect(only.tools.map((t) => t.name)).toEqual([SEND_USER_MESSAGE_TOOL_NAME]);

    const denied = await setup(["--brief", "--tools", "Read"]);
    expect(denied.tools.map((t) => t.name)).toEqual(["read"]);
  });
});

describe("SendUserMessage tool", () => {
  it("delivers the message verbatim", async () => {
    const result = await SendUserMessageTool.call(
      { message: "Your test failed: row 42." },
      contextFor(tempDir()),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("Your test failed: row 42.");
    // The user-facing line is the message itself — the default formatter's
    // "[0ms]" suffix would be noise on every message the user reads.
    expect(SendUserMessageTool.formatResult(result)).toBe("Your test failed: row 42.");
  });

  it("rejects a whitespace-only message instead of delivering a blank one", async () => {
    const result = await SendUserMessageTool.call({ message: "   \n " }, contextFor(tempDir()));
    expect(result.error).toMatch(/non-empty message/);
    expect(result.content).toBe("");
  });

  it("accepts an explicit status and keeps the text unchanged", async () => {
    const result = await SendUserMessageTool.call(
      { message: "Nightly build finished.", status: "proactive" },
      contextFor(tempDir()),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("Nightly build finished.");
  });

  it("resolves a workspace-relative attachment path", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "build.log"), "boom");
    const result = await SendUserMessageTool.call(
      { message: "See the log.", attachments: ["build.log"] },
      contextFor(root),
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("build.log");
  });

  it("refuses an attachment that escapes the workspace", async () => {
    const result = await SendUserMessageTool.call(
      { message: "See the log.", attachments: ["../../etc/passwd"] },
      contextFor(tempDir()),
    );
    expect(result.error).toMatch(/attachments:/);
    expect(result.content).toBe("");
  });

  it("refuses the device-upload object form with a named reason", async () => {
    // Fail-closed and loud: the model can never legitimately hold a file_uuid
    // here, so silently dropping it would look like a successful attachment.
    const result = await SendUserMessageTool.call(
      {
        message: "Here.",
        attachments: [{ file_uuid: "abc", file_name: "shot.png", size: 12, is_image: true }],
      },
      contextFor(tempDir()),
    );
    expect(result.error).toMatch(/device upload channel/);
    expect(result.error).toContain("shot.png");
  });
});

describe("BRIEF CHANNEL prompt section", () => {
  const promptFor = (brief?: boolean) =>
    renderSystemPrompt(buildSystemPrompt({ workspaceRoot: "/t", tools: [], brief }));

  it("is absent by default", () => {
    expect(promptFor()).not.toContain("[BRIEF CHANNEL]");
    expect(promptFor(false)).not.toContain("[BRIEF CHANNEL]");
  });

  it("appears only under the flag and keeps the behavioural guidance", () => {
    const text = promptFor(true);
    expect(text).toContain("[BRIEF CHANNEL]");
    expect(text).toContain("SendUserMessage");
    expect(text).toContain("ack");
    expect(text).toContain("Second person");
  });

  it("does not repeat official's detail-view claim", () => {
    // Official's section says replies outside the tool are "visible if the
    // user expands the detail view, but most won't". That is a fact about
    // official's chat view; in this terminal plain text is fully visible, so
    // copying it would teach the model to distrust output the user does read.
    expect(promptFor(true)).not.toContain("detail view");
  });

  it("sits in the static prefix so a brief session does not re-pay it per turn", () => {
    const blocks = buildSystemPrompt({ workspaceRoot: "/t", tools: [], brief: true });
    const briefIndex = blocks.findIndex((b) => b.includes("[BRIEF CHANNEL]"));
    const boundaryIndex = blocks.findIndex((b) => b.includes("SYSTEM PROMPT DYNAMIC BOUNDARY"));
    expect(briefIndex).toBeGreaterThanOrEqual(0);
    expect(boundaryIndex).toBeGreaterThanOrEqual(0);
    expect(briefIndex).toBeLessThan(boundaryIndex);
  });
});
