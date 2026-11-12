// ============================================================
// Headless control channel — official-shaped stream-json control
// protocol for `-p --input-format stream-json --output-format
// stream-json` sessions.
//   CLI → peer: control_request{can_use_tool} (only with
//               --permission-prompt-tool stdio)
//   peer → CLI: control_request{initialize,interrupt,set_model,
//               set_permission_mode}, control_response{can_use_tool}
// Frames are consumed while a turn is running; permission asks
// park until the matching control_response arrives (EOF denies).
// ============================================================

import { randomUUID } from "node:crypto";
import type { PermissionMode } from "./types.js";

export type CanUseToolDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string; interrupt?: boolean };

export interface ControlHandlers {
  interrupt: () => void;
  /** Local client teardown: stop the active turn and discard queued inputs. */
  shutdown?: () => void;
  /** Always a non-empty model name: the channel rejects resets and blanks. */
  setModel: (model: string) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  currentModel: () => string;
}

const PERMISSION_MODES = new Set<string>([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "auto",
  "dontAsk",
]);

export class HeadlessControlChannel {
  private pending = new Map<string, (decision: CanUseToolDecision) => void>();
  private closed = false;

  constructor(
    private emit: (value: unknown) => void,
    private handlers: ControlHandlers,
  ) {}

  handleRequest(requestId: unknown, request: unknown): void {
    if (typeof requestId !== "string" || requestId === "") return;
    const req = request as { subtype?: unknown } | null;
    const subtype = typeof req?.subtype === "string" ? req.subtype : "";
    try {
      let response: Record<string, unknown> = {};
      switch (subtype) {
        case "initialize":
          response = { commands: [], models: [this.handlers.currentModel()] };
          break;
        case "interrupt":
          this.denyPending("permission prompt interrupted");
          this.handlers.interrupt();
          break;
        case "shutdown":
          if (!this.handlers.shutdown) throw new Error("Shutdown is not supported by this host");
          this.denyAllPending("headless session shutting down");
          this.handlers.shutdown();
          break;
        case "set_permission_mode": {
          const mode = (req as { mode?: unknown }).mode;
          if (typeof mode !== "string" || !PERMISSION_MODES.has(mode))
            throw new Error(`Invalid permission mode: ${String(mode)}`);
          this.handlers.setPermissionMode(mode as PermissionMode);
          break;
        }
        case "set_model": {
          const model = (req as { model?: unknown }).model;
          // Official's "no model field = reset to the default" is not
          // implemented: answer an error frame instead of a silent success
          // no-op, and reject blanks the handler could not act on either.
          if (model === undefined || model === null)
            throw new Error(
              "set_model: resetting the default model is not supported; pass an explicit model name",
            );
          if (typeof model !== "string" || model.trim() === "")
            throw new Error("set_model: model must be a non-empty string");
          this.handlers.setModel(model);
          break;
        }
        default:
          throw new Error(`Unsupported control request subtype: ${subtype || "(missing)"}`);
      }
      this.emit({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      });
    } catch (error) {
      this.emit({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  handleResponse(response: unknown): void {
    const res = response as {
      subtype?: unknown;
      request_id?: unknown;
      response?: unknown;
      error?: unknown;
    } | null;
    if (typeof res?.request_id !== "string") return;
    const resolve = this.pending.get(res.request_id);
    if (!resolve) return; // late or unknown response — nothing parked on it
    this.pending.delete(res.request_id);
    if (res.subtype === "error") {
      resolve({ behavior: "deny", message: String(res.error ?? "control request failed") });
      return;
    }
    // Only a successful envelope can carry approval. Missing/unknown
    // subtypes must fail closed even if their nested payload says allow.
    if (res.subtype !== "success") {
      resolve({ behavior: "deny", message: "invalid control response subtype" });
      return;
    }
    const decision = res.response as CanUseToolDecision | null;
    if (decision?.behavior === "allow") {
      if (decision.updatedInput !== undefined) {
        if (
          !decision.updatedInput ||
          typeof decision.updatedInput !== "object" ||
          Array.isArray(decision.updatedInput)
        ) {
          resolve({ behavior: "deny", message: "updatedInput must be an object" });
          return;
        }
        resolve({ behavior: "allow", updatedInput: decision.updatedInput });
        return;
      }
      resolve({ behavior: "allow" });
    } else {
      resolve({
        behavior: "deny",
        message: typeof decision?.message === "string" ? decision.message : undefined,
        interrupt: decision?.interrupt === true,
      });
    }
  }

  requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    riskHint?: string,
  ): Promise<CanUseToolDecision> {
    if (this.closed)
      return Promise.resolve({ behavior: "deny", message: "permission prompt stream closed" });
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.emit({
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "can_use_tool",
          tool_name: toolName,
          input,
          permission_suggestions: [],
          ...(riskHint ? { decision_reason: riskHint } : {}),
        },
      });
    });
  }

  /** EOF or shutdown: every parked approval fails closed. */
  denyAllPending(reason: string): void {
    this.closed = true;
    this.denyPending(reason);
  }

  /** Resolve current approvals without closing the channel for later turns. */
  private denyPending(reason: string): void {
    for (const resolve of this.pending.values()) resolve({ behavior: "deny", message: reason });
    this.pending.clear();
  }
}
