// ============================================================
// Sub-agent context derivation
// ------------------------------------------------------------
// A sub-agent's ToolContext used to be built by hand at each call
// site, and elsewhere by a spread (`{ ...context, abortSignal }`).
// The spread looked equivalent but silently handed every worker the
// parent's fork hooks and its unrestricted approver — authority leaks
// that raise no error, because a worker with more power than intended
// still runs.
//
// deriveSubContext is the explicit allow-list that replaces both. These
// tests pin what a worker must NOT inherit, which is the whole point.
// ============================================================

import { describe, expect, it } from "vitest";
import { deriveSubContext, type ToolContext } from "../types.js";

/** A parent context carrying every field that could leak authority. */
function richParent(): ToolContext {
  return {
    workspaceRoot: "/ws",
    allowedDirectories: ["/elsewhere"],
    sessionId: "parent-sess",
    permissionMode: "default",
    getPermissionMode: () => "default",
    setPermissionMode: () => {},
    modelConfig: { provider: "deepseek", model: "deepseek-chat", apiKey: "k" },
    onSubAgentProgress: () => {},
    askUser: async () => true,
    askUserQuestion: async () => null,
    requestPlanApproval: async () => ({ choice: "approve", plan: "p" }),
    permissionClassifier: {
      callModel: () => (async function* () {})(),
      modelConfig: { provider: "deepseek", model: "deepseek-chat", apiKey: "k" },
    },
    permissionPolicy: { allow: [], deny: ["Bash"], ask: [] },
    hooks: { runPre: async () => ({}), runPost: async () => ({}) } as never,
    abortSignal: new AbortController().signal,
    getParentMessages: () => [],
    parentSystemPrompt: "PARENT PROMPT",
    subagentDepth: 0,
    collapseStore: undefined as never,
  };
}

describe("deriveSubContext", () => {
  it("carries the environment a worker legitimately needs", () => {
    const child = deriveSubContext(richParent());
    expect(child.workspaceRoot).toBe("/ws");
    expect(child.sessionId).toBe("parent-sess");
    expect(child.permissionMode).toBe("default");
    expect(child.modelConfig?.model).toBe("deepseek-chat");
  });

  it("does NOT let a worker re-fork", () => {
    // The concrete leak: Task/Agent compute `canFork` purely from the
    // presence of these two fields, so inheriting them would let a TYPED
    // sub-agent spawn an unbounded fork chain.
    const child = deriveSubContext(richParent());
    expect(child.getParentMessages).toBeUndefined();
    expect(child.parentSystemPrompt).toBeUndefined();
  });

  it("uses the CALLER's approver, never the parent's", () => {
    const restricted = async () => false;
    const child = deriveSubContext(richParent(), { askUser: restricted });
    expect(child.askUser).toBe(restricted);
    expect(child.askUser).not.toBe(richParent().askUser);
  });

  it("does not inherit the parent's human-facing overlays", () => {
    // Those overlays are not mounted during a worker turn; inheriting the
    // function would leave the worker able to await a promise that can
    // never settle.
    const child = deriveSubContext(richParent());
    expect(child.requestPlanApproval).toBeUndefined();
    expect(child.askUserQuestion).toBeUndefined();
  });

  it("does not widen the worker's file reach", () => {
    const child = deriveSubContext(richParent());
    expect(child.allowedDirectories).toBeUndefined();
  });

  it("does not inherit the LLM permission classifier", () => {
    // It sits on the tool-execution critical path and makes a model call
    // per flagged call; running it for every worker call is a cost and
    // latency multiplier with no safety gain (the regex layer still runs).
    const child = deriveSubContext(richParent());
    expect(child.permissionClassifier).toBeUndefined();
  });

  it("honors explicit overrides", () => {
    const child = deriveSubContext(richParent(), {
      workspaceRoot: "/ws/.claude/worktrees/x",
      sessionId: "parent-sess-agent-123",
      subagentDepth: 1,
      permissionMode: "plan",
    });
    expect(child.workspaceRoot).toBe("/ws/.claude/worktrees/x");
    expect(child.sessionId).toBe("parent-sess-agent-123");
    expect(child.permissionMode).toBe("plan");
    expect(child.subagentDepth).toBe(1);
  });

  it("forwards hooks / progress only when asked", () => {
    const parent = richParent();
    expect(deriveSubContext(parent).hooks).toBeUndefined();
    expect(deriveSubContext(parent).onSubAgentProgress).toBeUndefined();

    const hooks = parent.hooks!;
    const onSubAgentProgress = () => {};
    const wired = deriveSubContext(parent, { hooks, onSubAgentProgress });
    expect(wired.hooks).toBe(hooks);
    expect(wired.onSubAgentProgress).toBe(onSubAgentProgress);
  });

  it("produces only the allow-listed keys", () => {
    // A regression guard: a field added to ToolContext later must not reach
    // a worker unless deriveSubContext names it. Keys the caller did not
    // override are present but undefined, which is equivalent to absent for
    // every consumer (`if (context.x)`, `?? fallback`).
    const child = deriveSubContext(richParent());
    expect(Object.keys(child).sort()).toEqual(
      [
        "abortSignal",
        "askUser",
        "hooks",
        "modelConfig",
        "onSubAgentProgress",
        "permissionMode",
        "permissionPolicy",
        "sessionId",
        "skillScopeId",
        "subagentDepth",
        "workspaceRoot",
      ].sort(),
    );
  });

  it("defaults the nesting depth to 0 and does not inherit the parent's", () => {
    // A worker that reported its parent's depth would look shallower than it
    // is, defeating the fork-in-fork cap.
    const parent = { ...richParent(), subagentDepth: 2 };
    expect(deriveSubContext(parent).subagentDepth).toBe(0);
    expect(deriveSubContext(parent, { subagentDepth: 3 }).subagentDepth).toBe(3);
  });

  it("uses the worker's own abort signal, not the parent's", () => {
    const workerSignal = new AbortController().signal;
    const child = deriveSubContext(richParent(), { abortSignal: workerSignal });
    expect(child.abortSignal).toBe(workerSignal);
    // With no override it does not silently reuse the parent's signal.
    expect(deriveSubContext(richParent()).abortSignal).toBeUndefined();
  });
});
