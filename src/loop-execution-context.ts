import { AsyncLocalStorage } from "node:async_hooks";
import type { LoopTicket } from "./loop-runtime.js";

const context = new AsyncLocalStorage<LoopTicket>();
export function loopExecution(): LoopTicket | undefined {
  return context.getStore();
}
export function withLoopExecution<T>(ticket: LoopTicket, action: () => T): T {
  return context.run(ticket, action);
}
