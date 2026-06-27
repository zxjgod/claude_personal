// ============================================================
// CLI input reader — readline wrapper with EOF-safe semantics
// ============================================================
// readline.question throws ERR_USE_AFTER_CLOSE if stdin has already closed
// (piped input drained, Ctrl+D, etc.). It also behaves poorly for automated
// multi-line pipes because the stream may close before the next question is
// issued. This wrapper consumes readline's `line` events into a queue so both
// real TTY input and `printf '...\n...' | node dist/cli.js` work reliably.
// ============================================================

import type * as readline from "node:readline";

export interface CliInputReader {
  askQuestion(prompt: string): Promise<string | null>;
  readInput(): Promise<string | null>;
  isClosed(): boolean;
}

export function createCliInputReader(rl: readline.Interface): CliInputReader {
  let stdinClosed = false;
  const queue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];

  const flushWaiter = (line: string | null): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else if (line !== null) queue.push(line);
  };

  rl.on("line", (line) => flushWaiter(line));
  rl.on("close", () => {
    stdinClosed = true;
    while (waiters.length > 0) {
      waiters.shift()!(null);
    }
  });

  const askQuestion = (prompt: string): Promise<string | null> => {
    if (prompt) process.stdout.write(prompt);
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    if (stdinClosed) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };

  const readInput = async (): Promise<string | null> => {
    const first0 = await askQuestion("\n> ");
    if (first0 === null) return null;
    let first = first0;
    if (!first) return first;

    const lines: string[] = [];
    let inFence = /^```/.test(first.trimStart());

    const continues = (line: string) => line.endsWith("\\");
    let pendingContinuation = continues(first) && !inFence;
    if (pendingContinuation) first = first.slice(0, -1);
    lines.push(first);

    while (inFence || pendingContinuation) {
      const next = await askQuestion(inFence ? "… " : "… ");
      if (next === null) break;
      if (inFence) {
        lines.push(next);
        if (/^```/.test(next.trimStart())) inFence = false;
      } else {
        pendingContinuation = continues(next);
        lines.push(pendingContinuation ? next.slice(0, -1) : next);
      }
    }

    return lines.join("\n");
  };

  return {
    askQuestion,
    readInput,
    isClosed: () => stdinClosed,
  };
}
