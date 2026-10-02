import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createResumeSession } from "../cli-session.js";
import { sessionGoal, setSessionGoal } from "../goal-runtime.js";
import { HookRegistry } from "../hooks.js";
import { registerHooksFromConfig } from "../hooks-config.js";
import {
  confirmProjectLspConfig,
  disposeLanguageServers,
  languageServerFor,
} from "../language-servers.js";
import { restoreSessionRuntime, saveSessionRuntime } from "../session-runtime.js";
import {
  listScheduledJobs,
  registerScheduledJob,
  resetScheduledJobs,
} from "../tools/extended/cron-shared.js";
import { enqueueScheduledInput, takeScheduledInput } from "../tools/extended/schedule-scope.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-review-state-"));
  vi.stubEnv("CCR_USER_CONFIG_DIR", path.join(root, "user"));
  resetScheduledJobs();
});
afterEach(async () => {
  await disposeLanguageServers();
  resetScheduledJobs();
  setSessionGoal("old", "");
  setSessionGoal("new", "");
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it("resume releases old scheduling state after saving it, and can restore its queued input later", async () => {
  setSessionGoal("new", "new objective");
  saveSessionRuntime(root, "new");
  setSessionGoal("new", "");
  setSessionGoal("old", "old objective");
  const job = registerScheduledJob({
    cron: "* * * * *",
    prompt: "old prompt",
    recurring: true,
    durable: false,
    workspaceRoot: root,
    sessionId: "old",
  })!;
  enqueueScheduledInput({
    registry: "cron",
    source: "cron",
    jobId: job.id,
    prompt: "queued old prompt",
    label: "old",
    workspaceRoot: root,
    sessionId: "old",
  });
  const holder = { value: "old objective" };
  const session = { id: "old" };
  const persistence = {
    workspaceRoot: root,
    searchSessions: async () => [{ sessionId: "new" }],
    load: async () => ({ sessionId: "new", messages: [], updatedAt: new Date().toISOString() }),
  };
  await createResumeSession({
    persistence: persistence as never,
    session,
    messages: [],
    onResume: () => {
      holder.value = sessionGoal(session.id)?.objective ?? "";
    },
  })("new");
  expect(holder.value).toBe("new objective");
  expect(sessionGoal("old")).toBeUndefined();
  expect(listScheduledJobs()).toHaveLength(0);
  expect(takeScheduledInput({ workspaceRoot: root, sessionId: "new" })).toBeUndefined();
  restoreSessionRuntime(root, "old");
  expect(listScheduledJobs()).toHaveLength(1);
  expect(takeScheduledInput({ workspaceRoot: root, sessionId: "old" })?.prompt).toBe(
    "queued old prompt",
  );
});
it("legacy goal snapshots remain suspended rather than silently recreating autonomous work", () => {
  const directory = path.join(root, ".claude", "session-runtime");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "old.json"),
    JSON.stringify({ version: 1, goal: "legacy objective" }),
  );
  restoreSessionRuntime(root, "old");
  expect(sessionGoal("old")).toMatchObject({
    objective: "legacy objective",
    complete: false,
    suspended: true,
  });
});
it("Hook envelopes follow the live session and storage root while relative commands keep their trusted cwd", async () => {
  const script = path.join(root, "hook.cjs");
  const output = path.join(root, "seen.json");
  fs.writeFileSync(
    script,
    `let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({stdin:JSON.parse(text),actualCwd:process.cwd()})));`,
  );
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub);
  let sid = "old";
  let workspace = root;
  const hooks = new HookRegistry();
  registerHooksFromConfig(
    hooks,
    {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: `"${process.execPath}" "${script}"` }],
        },
      ],
    },
    {
      get sessionId() {
        return sid;
      },
      get workspaceRoot() {
        return workspace;
      },
      transcriptRoot: root,
    },
  );
  await hooks.runPre({ toolName: "read", input: {} });
  sid = "new";
  workspace = sub;
  await hooks.runPre({ toolName: "read", input: {} });
  const seen = JSON.parse(fs.readFileSync(output, "utf8"));
  expect(seen.stdin.session_id).toBe("new");
  expect(seen.stdin.cwd).toBe(sub);
  expect(seen.stdin.transcript_path).toBe(
    path.join(root, ".claude", "sessions", "new.transcript.jsonl"),
  );
  expect(seen.actualCwd).toBe(root);
});
it("changing trusted project LSP config invalidates its approval before spawning", async () => {
  const file = path.join(root, ".claude", "lsp.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(path.join(root, "fixture.py"), "pass");
  fs.writeFileSync(
    file,
    JSON.stringify({ fixture: { command: "not-run", extensionToLanguage: { ".py": "python" } } }),
  );
  await confirmProjectLspConfig(root, async () => true);
  fs.writeFileSync(
    file,
    JSON.stringify({
      fixture: { command: "still-not-run", extensionToLanguage: { ".py": "python" } },
    }),
  );
  expect(await languageServerFor(root, "fixture.py")).toBeUndefined();
});
