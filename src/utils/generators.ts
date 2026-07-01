// ============================================================
// Async-generator concurrency primitives (kernel §6, M29)
// ============================================================

/**
 * Merge N async generators into one, running at most `maxConcurrency` of them
 * concurrently. Values are yielded in completion order (whichever generator
 * settles first), NOT launch order — so fast work surfaces immediately while
 * slow work is still in flight. A generator that yields multiple values keeps
 * its slot until it is exhausted; a fresh generator is pulled from the queue
 * each time a slot frees up.
 *
 * This is the bounded-concurrency engine behind the agent loop's parallel tool
 * batch. Kept generic and dependency-free so it is trivially testable.
 */
export async function* all<T>(
  generators: Array<AsyncGenerator<T>>,
  maxConcurrency = Number.POSITIVE_INFINITY,
): AsyncGenerator<T> {
  // Each in-flight entry maps the promise of `gen.next()` to its generator, so
  // when Promise.race resolves we know which generator to advance next.
  type Settled = { gen: AsyncGenerator<T>; res: IteratorResult<T> };
  const inFlight = new Map<Promise<Settled>, AsyncGenerator<T>>();
  const waiting = [...generators];

  const start = (gen: AsyncGenerator<T>): void => {
    const p: Promise<Settled> = gen.next().then((res) => ({ gen, res }));
    inFlight.set(p, gen);
  };

  // Prime up to the concurrency limit.
  while (waiting.length > 0 && inFlight.size < maxConcurrency) {
    start(waiting.shift()!);
  }

  while (inFlight.size > 0) {
    // Race the currently in-flight `next()` calls; take the first to settle.
    const settled = await Promise.race(inFlight.keys());
    // Find and remove the promise that produced this result. We re-derive it by
    // identity: only one entry has this exact gen as a freshly-settled value.
    for (const [promise, gen] of inFlight) {
      if (gen === settled.gen) {
        // Confirm this is the settled promise (a gen has at most one in flight).
        inFlight.delete(promise);
        break;
      }
    }

    if (!settled.res.done) {
      yield settled.res.value;
      // Same generator may have more — keep it going (re-occupies a slot).
      start(settled.gen);
    }

    // Backfill freed slots from the waiting queue.
    while (waiting.length > 0 && inFlight.size < maxConcurrency) {
      start(waiting.shift()!);
    }
  }
}

/**
 * Max tool calls run concurrently in a parallel batch (kernel §6). Overridable
 * via CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY; defaults to 10.
 */
export function maxToolConcurrency(): number {
  const raw = Number(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 10;
}
