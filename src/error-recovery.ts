// ============================================================
// Error Recovery — model error handling with retry budgets (M31)
// ============================================================
// Centralizes error classification and recovery logic for the agent loop.
// Handles: 429 rate limits, context_length errors, timeouts, auth failures.
// ============================================================

/**
 * Decision returned by handleModelError.
 * - "retry": wait then re-call the model with the same messages (429).
 * - "retry_transient": wait then re-call after a timeout/connection error.
 * - "compact_and_retry": compress context once, then re-call the model
 *   (context_length exceeded).
 * - "abort": unrecoverable (auth, unknown, or retry budget exhausted).
 */
export type ModelErrorRecovery = "retry" | "retry_transient" | "compact_and_retry" | "abort";

/**
 * Fired right before a retry sleeps, so the UI can show a countdown
 * ("retrying in Ns · attempt N/M") instead of hanging silently.
 */
export interface RetryNotice {
  kind: "rate_limit" | "transient";
  /** Computed backoff (with jitter) that will be slept. */
  delayMs: number;
}

export interface RecoveryState {
  rateLimitRetries: number;
  contextLengthRetries: number;
  /** Transient transport-error retries (timeouts/connection resets), separate */
  /** from rate-limit retries so a 429 burst can't exhaust the timeout budget. */
  transientRetries: number;
  maxRateLimitRetries: number;
  maxContextLengthRetries: number;
  maxTransientRetries: number;
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
 * Whether a model error is worth retrying on a DIFFERENT model (fallback chain).
 * Auth (401/403) and rate-limit (429) are account-level, and user aborts must
 * never fall through to another model — switching wouldn't help or would be
 * wrong. Everything else (5xx, 404 model-not-found, 400 non-context, connection
 * errors) is model-specific enough that a fallback model may succeed.
 */
export function isFallbackableModelError(error: unknown): boolean {
  const err = error as { status?: number; name?: string; message?: string } | null;
  const status = err?.status;
  if (status === 401 || status === 403 || status === 429) return false;
  const name = err?.name ?? "";
  const msg = err?.message ?? "";
  if (name === "AbortError" || msg === "Aborted" || msg.includes("aborted")) return false;
  return true;
}

/**
 * Main error recovery decision function.
 * Returns the recovery action to take based on error type and state.
 */
export async function handleModelError(
  error: unknown,
  state: RecoveryState,
  onRetry?: (notice: RetryNotice) => void,
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

    onRetry?.({ kind: "rate_limit", delayMs: finalDelay });
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

  // Transient timeout / connection error → retry once, bounded by its OWN
  // budget (independent of rate-limit retries).
  if (
    name === "TimeoutError" ||
    name === "ETIMEDOUT" ||
    err?.code === "ETIMEDOUT" ||
    err?.code === "ECONNRESET" ||
    err?.code === "ECONNREFUSED" ||
    msg.includes("timeout") ||
    msg.includes("socket hang up")
  ) {
    if (state.transientRetries >= state.maxTransientRetries) {
      return "abort";
    }
    onRetry?.({ kind: "transient", delayMs: 2000 });
    await sleep(2000);
    return "retry_transient";
  }

  // Unknown error → abort
  return "abort";
}
