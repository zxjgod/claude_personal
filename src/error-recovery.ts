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

/**
 * Sleep utility that respects an abort signal (Top10 follow-up E1): resolves
 * EARLY (never rejects) when the signal fires, so a Ctrl+C during a 429
 * backoff returns control immediately instead of hanging for up to 60s. The
 * caller's next loop iteration handles the aborted state.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Extract the server's Retry-After from an error and normalize to
 * MILLISECONDS (Top10 follow-up E3/M-second-round). The old `err.retryAfter`
 * property was never set by anything (dead) and its unit was ambiguous; both
 * SDKs' APIError objects carry the raw `headers`, where Retry-After is
 * SECONDS (or an HTTP-date) per RFC — reading it as ms made every real hint
 * 1000× too small, and `|| 5000` swallowed a legitimate 0.
 */
export function retryAfterMsFrom(error: unknown): number | null {
  const err = error as { retryAfterMs?: unknown; headers?: unknown } | null;
  if (
    typeof err?.retryAfterMs === "number" &&
    Number.isFinite(err.retryAfterMs) &&
    err.retryAfterMs >= 0
  ) {
    return err.retryAfterMs;
  }
  const headers = (err?.headers ?? undefined) as Record<string, string> | undefined;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw === undefined || raw === null) return null;
  const secs = Number.parseFloat(String(raw));
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const dateMs = Date.parse(String(raw));
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/** Smallest backoff we will actually sleep, even when the server says 0. */
const MIN_BACKOFF_MS = 100;

/**
 * Context-overflow error message wordings across BOTH provider families
 * (Top10 #3): OpenAI-compatible ("context_length_exceeded", "maximum context
 * length") and Anthropic ("prompt is too long: N tokens > M maximum"). The
 * Anthropic wording was missing, which made compact_and_retry a dead path on
 * the native route — the loop instead burned the whole fallback chain with the
 * same oversized prompt and aborted.
 */
const CONTEXT_LENGTH_RE = /context_length|maximum context|prompt is too long/i;

/** Check if an error is a context-length error (400 with an overflow wording). */
export function isContextLengthError(error: unknown): boolean {
  const err = error as { status?: number; message?: string } | null;
  const msg = err?.message ?? "";
  return err?.status === 400 && CONTEXT_LENGTH_RE.test(msg);
}

/**
 * Whether a model error is worth retrying on a DIFFERENT model (fallback chain).
 * Auth (401/403) and rate-limit (429) are account-level, and user aborts must
 * never fall through to another model — switching wouldn't help or would be
 * wrong. Context overflow is NOT model-specific either: the same oversized
 * prompt will not fit into any fallback, so re-sending it down the chain only
 * burns quota — recovery is compact_and_retry (handleModelError). Everything
 * else (5xx, 404 model-not-found, 400 non-context, connection errors) is
 * model-specific enough that a fallback model may succeed.
 */
export function isFallbackableModelError(error: unknown): boolean {
  const err = error as { status?: number; name?: string; message?: string } | null;
  const status = err?.status;
  if (status === 401 || status === 403 || status === 429) return false;
  if (isContextLengthError(error)) return false;
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
  abortSignal?: AbortSignal,
): Promise<ModelErrorRecovery> {
  const err = error as Record<string, unknown> | null;

  // Rate limit → wait and retry (bounded).
  if (err?.status === 429) {
    if (state.rateLimitRetries >= state.maxRateLimitRetries) {
      return "abort";
    }

    // P1 Enhancement: Exponential backoff with jitter. The server's
    // Retry-After header (normalized to ms) replaces the dead `retryAfter`
    // property; `?? 5000` (not `||`) so a legitimate 0 is honored — with a
    // small floor so we never busy-loop.
    const baseDelay = Math.max(retryAfterMsFrom(error) ?? 5000, MIN_BACKOFF_MS);
    const exponentialDelay = baseDelay * 2 ** state.rateLimitRetries;
    const cappedDelay = Math.min(exponentialDelay, 60000);
    const jitter = cappedDelay * 0.2 * (Math.random() * 2 - 1);
    const finalDelay = Math.round(cappedDelay + jitter);

    onRetry?.({ kind: "rate_limit", delayMs: finalDelay });
    await sleep(finalDelay, abortSignal);
    if (abortSignal?.aborted) return "abort";
    return "retry";
  }

  // Context too long → compact once and retry (bounded). Both provider
  // wordings are recognized via the shared CONTEXT_LENGTH_RE.
  if (isContextLengthError(error)) {
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

  // Transient timeout / connection error / server-side 5xx & 529 overloaded →
  // retry, bounded by its OWN budget (independent of rate-limit retries).
  // 5xx/529 previously fell through to "abort" and burned the fallback chain
  // on what a short backoff would have ridden out (Top10 follow-up E2).
  const status = err?.status;
  const serverHiccup = typeof status === "number" && status >= 500; // includes 529
  if (
    name === "TimeoutError" ||
    name === "ETIMEDOUT" ||
    err?.code === "ETIMEDOUT" ||
    err?.code === "ECONNRESET" ||
    err?.code === "ECONNREFUSED" ||
    msg.includes("timeout") ||
    msg.includes("socket hang up") ||
    serverHiccup
  ) {
    if (state.transientRetries >= state.maxTransientRetries) {
      return "abort";
    }
    // Exponential backoff with jitter, mirroring the 429 path: base 1s, cap
    // 30s. A fixed 2s retry on a flaky connection just hammers it in lockstep.
    // A server-provided Retry-After (normalized to ms) wins over the formula.
    const retryAfter = serverHiccup ? retryAfterMsFrom(error) : null;
    const exponentialDelay = retryAfter ?? 1000 * 2 ** state.transientRetries;
    const cappedDelay = Math.min(exponentialDelay, 30_000);
    const jitter = cappedDelay * 0.2 * (Math.random() * 2 - 1);
    const finalDelay = Math.round(Math.max(cappedDelay + jitter, MIN_BACKOFF_MS));
    onRetry?.({ kind: "transient", delayMs: finalDelay });
    await sleep(finalDelay, abortSignal);
    if (abortSignal?.aborted) return "abort";
    return "retry_transient";
  }

  // Unknown error → abort
  return "abort";
}
