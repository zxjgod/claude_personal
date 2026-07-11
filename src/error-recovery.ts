// ============================================================
// Error Recovery — model error handling with retry budgets (M31)
// ============================================================
// Centralizes error classification and recovery logic for the agent loop.
// Handles: 429 rate limits, context_length errors, timeouts, auth failures.
// ============================================================

/**
 * Decision returned by handleModelError.
 * - "retry": wait then re-call the model with the same messages (429).
 * - "compact_and_retry": compress context once, then re-call the model
 *   (context_length exceeded).
 * - "abort": unrecoverable (auth, unknown, or retry budget exhausted).
 */
export type ModelErrorRecovery = "retry" | "compact_and_retry" | "abort";

export interface RecoveryState {
  rateLimitRetries: number;
  contextLengthRetries: number;
  maxRateLimitRetries: number;
  maxContextLengthRetries: number;
}

/** Sleep utility. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if an error is a context-length error (400 with context_length). */
export function isContextLengthError(error: unknown): boolean {
  const err = error as { status?: number; message?: string } | null;
  const msg = err?.message ?? "";
  return err?.status === 400 && (msg.includes("context_length") || msg.includes("maximum context"));
}

/**
 * Main error recovery decision function.
 * Returns the recovery action to take based on error type and state.
 */
export async function handleModelError(
  error: unknown,
  state: RecoveryState,
): Promise<ModelErrorRecovery> {
  const err = error as Record<string, unknown> | null;

  // Rate limit → wait and retry (bounded).
  if (err?.status === 429) {
    if (state.rateLimitRetries >= state.maxRateLimitRetries) {
      return "abort";
    }

    // P1 Enhancement: Exponential backoff with jitter
    const baseDelay = (err?.retryAfter as number) || 5000;
    const exponentialDelay = baseDelay * 2 ** state.rateLimitRetries;
    const cappedDelay = Math.min(exponentialDelay, 60000);
    const jitter = cappedDelay * 0.2 * (Math.random() * 2 - 1);
    const finalDelay = Math.round(cappedDelay + jitter);

    await sleep(finalDelay);
    return "retry";
  }

  // Context too long → compact once and retry (bounded).
  if (
    err?.status === 400 &&
    ((err?.message as string | undefined) ?? "").match(/context_length|maximum context/)
  ) {
    if (state.contextLengthRetries >= state.maxContextLengthRetries) {
      return "abort";
    }
    return "compact_and_retry";
  }

  // Auth error → abort
  if (err?.status === 401 || err?.status === 403) {
    return "abort";
  }

  // User-initiated abort (Ctrl+C / turn abort) → never retry.
  const name = err?.name as string | undefined;
  const msg = (err?.message as string | undefined) ?? "";
  if (name === "AbortError" || msg === "Aborted" || msg.includes("aborted")) {
    return "abort";
  }

  // Transient timeout / connection error → retry once (bounded).
  if (
    name === "TimeoutError" ||
    name === "ETIMEDOUT" ||
    err?.code === "ETIMEDOUT" ||
    err?.code === "ECONNRESET" ||
    err?.code === "ECONNREFUSED" ||
    msg.includes("timeout") ||
    msg.includes("socket hang up")
  ) {
    if (state.rateLimitRetries >= state.maxRateLimitRetries) {
      return "abort";
    }
    await sleep(2000);
    return "retry";
  }

  // Unknown error → abort
  return "abort";
}
