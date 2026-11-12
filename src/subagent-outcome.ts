import type { LoopEvent, Terminal } from "./types.js";

/** UI events may include recoverable errors or an end_turn before a hard
 * stop limit. The generator's returned Terminal is the authoritative outcome. */
export async function consumeSubagentLoop(
  loop: AsyncGenerator<LoopEvent, Terminal>,
  onEvent: (event: LoopEvent) => void,
): Promise<Terminal> {
  let finished = false;
  try {
    while (true) {
      const step = await loop.next();
      if (step.done) {
        finished = true;
        return step.value;
      }
      onEvent(step.value);
    }
  } finally {
    if (!finished) await loop.return({ reason: "hook_stopped", turns: 0 });
  }
}

export function subagentFinishReason(terminal: Terminal): string {
  return terminal.reason === "completed" || terminal.reason === "stop_hook_prevented"
    ? "end_turn"
    : terminal.reason;
}

export function subagentTerminalError(terminal: Terminal): string | undefined {
  if (subagentFinishReason(terminal) === "end_turn") return undefined;
  return `${terminal.reason}${terminal.error ? `: ${String(terminal.error)}` : ""}`;
}
