import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentLoop, type LoopScope, resetLoopsForTests, startLoop } from "../loop-runtime.js";
import { loopConfig, persistLoopConfig } from "../loop-settings.js";
import { App } from "../tui/App.js";
import { runLoopMenu } from "../tui/loop-menu-flow.js";
import { Root, type TuiDeps } from "../tui/run.js";
import { TuiStore } from "../tui/store.js";
import { visualWidth } from "../tui/terminal-width.js";
import type { ModelCaller } from "../types.js";

let scope: LoopScope;
const flush = () => new Promise((resolve) => setTimeout(resolve, 35));
beforeEach(() => {
  scope = { workspaceRoot: mkdtempSync(join(tmpdir(), "ccr-loop-menu-")), sessionId: "menu" };
  mkdirSync(join(scope.workspaceRoot, ".claude"));
  writeFileSync(join(scope.workspaceRoot, ".claude/settings.json"), JSON.stringify({ loop: {} }));
  vi.stubEnv("CCR_USER_CONFIG_DIR", join(scope.workspaceRoot, "user"));
  resetLoopsForTests();
});
afterEach(() => {
  resetLoopsForTests();
  vi.unstubAllEnvs();
  rmSync(scope.workspaceRoot, { recursive: true, force: true });
});
function open() {
  const store = new TuiStore("test/model");
  const done = runLoopMenu(store, scope);
  const view = render(<App store={store} commands={[]} onSubmit={() => {}} />);
  return { store, done, ...view };
}

describe("loop secondary menu", () => {
  it.each([42, 80, 140])("keeps the menu and editor within %i columns", async (columns) => {
    const menu = open();
    try {
      Object.defineProperty(menu.stdout, "columns", { configurable: true, value: columns });
      menu.stdout.emit("resize");
      await flush();
      expect(
        (menu.lastFrame() ?? "").split("\n").every((line) => visualWidth(line) <= columns),
      ).toBe(true);
      expect((menu.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(24);
      menu.stdin.write("1");
      await flush();
      menu.stdin.write("\x1b[200~" + "很长的任务描述".repeat(100) + "\x1b[201~");
      await flush();
      expect(
        (menu.lastFrame() ?? "").split("\n").every((line) => visualWidth(line) <= columns),
      ).toBe(true);
      expect((menu.lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(24);
    } finally {
      menu.unmount();
      menu.store.cancelOverlays();
      await menu.done;
    }
  });
  it("shows nine independent actions and four named profiles", async () => {
    const menu = open();
    try {
      await flush();
      for (const label of [
        "Collaborative",
        "Autonomous",
        "Scheduled",
        "Conservative",
        "Status",
        "Pause",
        "Resume",
        "Stop",
        "Completion checks",
        "History",
        "Limits & recovery",
      ])
        expect(menu.lastFrame()).toContain(label);
      expect(menu.lastFrame()).not.toContain("bypass permissions");
      menu.stdin.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 70));
      await menu.done;
    } finally {
      menu.unmount();
      menu.store.cancelOverlays();
    }
  });
  it("handles rapid arrow presses and persists each profile independently", async () => {
    const menu = open();
    try {
      await flush();
      menu.stdin.write("\x1b[C\x1b[C");
      await flush();
      expect(loopConfig(scope.workspaceRoot).profile).toBe("scheduled");
      menu.stdin.write("\x1b[B\x1b[C\x1b[C");
      await flush();
      expect(loopConfig(scope.workspaceRoot).intervalMinutes).toBe(12);
      expect(loopConfig(scope.workspaceRoot, "collaborative").intervalMinutes).toBe(3);
      expect(menu.lastFrame()).toContain("12 min");
    } finally {
      menu.unmount();
      menu.store.cancelOverlays();
      await menu.done;
    }
  });
  it("starts a task from the menu using the selected configuration", async () => {
    const menu = open();
    try {
      await flush();
      menu.stdin.write("1");
      await flush();
      menu.stdin.write("finish this task");
      await flush();
      menu.stdin.write("\r");
      await flush();
      await menu.done;
      expect(currentLoop(scope)?.objective).toBe("finish this task");
      expect(currentLoop(scope)?.config.profile).toBe("collaborative");
    } finally {
      menu.unmount();
      menu.store.cancelOverlays();
    }
  });
  it("pause, status and resume are independent menu choices", async () => {
    startLoop(scope, "work");
    const menu = open();
    try {
      await flush();
      menu.stdin.write("3");
      await flush();
      expect(currentLoop(scope)?.status).toBe("paused");
      expect(menu.lastFrame()).toContain("Loop status");
      menu.stdin.write("\r");
      await flush();
      menu.stdin.write("4");
      await flush();
      await menu.done;
      expect(currentLoop(scope)?.status).toBe("waiting");
    } finally {
      menu.unmount();
      menu.store.cancelOverlays();
    }
  });
  it("opens completion, retry, limits and recovery modules", async () => {
    const menu = open();
    try {
      await flush();
      menu.stdin.write("6");
      await flush();
      expect(menu.lastFrame()).toContain("Verification");
      menu.stdin.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 70));
      menu.stdin.write("7");
      await flush();
      expect(menu.lastFrame()).toContain("Transient retries");
      menu.stdin.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 70));
      menu.stdin.write("9");
      await flush();
      expect(menu.lastFrame()).toContain("Token budget");
      menu.stdin.write("\t");
      await flush();
      expect(menu.lastFrame()).toContain("Recovery & schedule");
      expect(menu.lastFrame()).toContain("Time zone");
    } finally {
      menu.unmount();
      menu.store.cancelOverlays();
      await menu.done;
    }
  });
});

function rootDeps(callModel: ModelCaller): TuiDeps {
  const messages: TuiDeps["messages"] = [];
  const modelConfig: TuiDeps["modelConfig"] = {
    provider: "openai",
    model: "test",
    apiKey: "test",
    maxTokens: 64,
  };
  return {
    ...scope,
    messages,
    modelConfig,
    callModel,
    systemPrompt: "Test system",
    tools: [],
    commands: [{ name: "loop", description: "Manage loops" }],
    permissionMode: "default",
    onSave: () => {},
    alwaysAllow: new Set(),
    permissionKey: () => "key",
    makeCommandContext: () => ({ ...scope, messages, modelConfig, callModel }),
  };
}
describe("loop command dispatch", () => {
  it("runs two actual UI iterations with a final-round system injection and independent verification", async () => {
    persistLoopConfig(scope.workspaceRoot, "collaborative", { maxRounds: 2 });
    const workPrompts: string[] = [];
    let checks = 0;
    const callModel: ModelCaller = async function* (_messages, _tools, prompt) {
      if (prompt.startsWith("Independently verify completion")) {
        checks++;
        yield {
          type: "text_delta",
          delta: JSON.stringify({
            complete: checks === 2,
            reason: checks === 2 ? "Verified" : "One fix remains",
          }),
        };
      } else {
        workPrompts.push(prompt);
        yield { type: "text_delta", delta: "Verified increment." };
      }
      yield { type: "done", usage: { input_tokens: 20, output_tokens: 10 }, finish_reason: "stop" };
    };
    const store = new TuiStore("test/model");
    const view = render(<Root store={store} deps={rootDeps(callModel)} />);
    try {
      await flush();
      view.stdin.write("/loop finish");
      await flush();
      view.stdin.write("\r");
      for (let i = 0; i < 30 && currentLoop(scope)?.rounds !== 1; i++) await flush();
      for (let i = 0; i < 30 && currentLoop(scope)?.status !== "waiting"; i++) await flush();
      const record = currentLoop(scope);
      if (!record) throw new Error("Missing loop");
      expect(record.rounds).toBe(1);
      expect(record.status).toBe("waiting");
      record.nextRunAt = Date.now();
      for (let i = 0; i < 80 && record.status !== "completed"; i++) await flush();
      expect(record.status).toBe("completed");
      expect(record.rounds).toBe(2);
      expect(workPrompts).toHaveLength(2);
      expect(workPrompts[0]).toContain("CONVERGENCE ROUND");
      expect(workPrompts[1]).toContain("FINAL WRAP-UP ROUND");
      expect(record.inputTokens).toBe(80);
      expect(view.lastFrame()).not.toContain("[Managed loop ");
    } finally {
      view.unmount();
      store.cancelOverlays();
    }
  });
  it("/loop Enter opens the secondary menu instead of calling the model", async () => {
    const callModel = vi.fn(async function* () {});
    const store = new TuiStore("test/model");
    const view = render(<Root store={store} deps={rootDeps(callModel)} />);
    try {
      await flush();
      view.stdin.write("/loop");
      await flush();
      view.stdin.write("\r");
      await flush();
      expect(store.getSnapshot().overlay?.kind).toBe("loopMenu");
      expect(view.lastFrame()).toContain("Start task");
      expect(callModel).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      store.cancelOverlays();
    }
  });
  it("/loop stop bypasses type-ahead while busy and cancels the running iteration", async () => {
    const callModel: ModelCaller = async function* (_messages, _tools, _prompt, _config, signal) {
      yield { type: "text_delta", delta: "working" };
      if (signal?.aborted) return;
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    };
    const store = new TuiStore("test/model");
    const view = render(<Root store={store} deps={rootDeps(callModel)} />);
    try {
      await flush();
      view.stdin.write("/loop do work");
      await flush();
      view.stdin.write("\r");
      for (let i = 0; i < 20 && currentLoop(scope)?.status !== "running"; i++) await flush();
      expect(currentLoop(scope)?.status).toBe("running");
      view.stdin.write("/loop stop");
      await flush();
      view.stdin.write("\r");
      for (let i = 0; i < 20 && store.getSnapshot().busy; i++) await flush();
      expect(currentLoop(scope)?.status).toBe("stopped");
      expect(store.getSnapshot().queuedMessages).toEqual([]);
      expect(store.getSnapshot().busy).toBe(false);
    } finally {
      view.unmount();
      store.cancelOverlays();
    }
  });
});
