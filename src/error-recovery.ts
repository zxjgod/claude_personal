// ============================================================
// Error Recovery — Structured error handling and retry strategies
// ============================================================
// Centralizes all error classification and recovery logic that was
// previously scattered throughout the agent loop.
// ============================================================

export interface RecoveryState {
  compactCount: number;
  maxCompacts: number;
  retries: number;
  maxRetries: number;
  rateLimitRetries: number;
  maxRateLimitRetries: number;
  abortSignal?: AbortSignal;
}

export type ModelErrorRecovery =
  | { action: "retry" }
  | { action: "compact-then-retry" }
  | { action: "abort"; reason: string }
  | { action: "skip"; message: string };

/** Check if error is a context length error. */
export function isContextLengthError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("context") ||
      msg.includes("length") ||
      msg.includes("limit") ||
      msg.includes("maximum") ||
      msg.includes("too long") ||
      msg.includes("tokens")
    );
  }
  return false;
}

/** Check if error is a rate limit error. */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
  }
  return false;
}

/** Check if error indicates a temporary failure that can be retried. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("network") ||
      msg.includes("503") ||
      msg.includes("502")
    );
  }
  return false;
}

/**
 * Get retry delay with exponential backoff and jitter.
 */
export function calculateRetryDelay(error: unknown, attempt: number, maxDelay = 60000): number {
  let baseDelay = 5000; // 5 seconds default

  // Try to extract retry-after from error
  if (error instanceof Error) {
    const match = error.message.match(/retry[_-]?after[:\s]*(\d+)/i);
    if (match) {
      baseDelay = parseInt(match[1], 10) * 1000;
    }
  }

  const exponentialDelay = baseDelay * 2 ** attempt;
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  const jitter = cappedDelay * 0.2 * (Math.random() * 2 - 1);
  return Math.round(cappedDelay + jitter);
}

/**
 * Main error recovery decision function.
 * Returns the recovery action to take based on error type and state.
 */
export async function handleModelError(
  error: unknown,
  state: RecoveryState,
): Promise<ModelErrorRecovery> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Abort signal check
  if (state.abortSignal?.aborted) {
    return { action: "abort", reason: "Aborted by user" };
  }

  // Context length error: compact and retry
  if (isContextLengthError(error)) {
    if (state.compactCount >= state.maxCompacts) {
      return {
        action: "abort",
        reason: `Context too long after ${state.maxCompacts} compactions`,
      };
    }
    return { action: "compact-then-retry" };
  }

  // Rate limit error: wait and retry
  if (isRateLimitError(error)) {
    if (state.rateLimitRetries >= state.maxRateLimitRetries) {
      return {
        action: "abort",
        reason: `Rate limit exceeded after ${state.maxRateLimitRetries} retries`,
      };
    }

    const delay = calculateRetryDelay(error, state.rateLimitRetries);

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), delay);
        state.abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Aborted"));
          },
          { once: true },
        );
      });
    } catch {
      return { action: "abort", reason: "Aborted during rate limit wait" };
    }

    return { action: "retry" };
  }

  // Retryable error: retry with backoff
  if (isRetryableError(error)) {
    if (state.retries >= state.maxRetries) {
      return {
        action: "abort",
        reason: `Retry limit reached after ${state.maxRetries} attempts`,
      };
    }

    const delay = calculateRetryDelay(error, state.retries);

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), delay);
        state.abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Aborted"));
          },
          { once: true },
        );
      });
    } catch {
      return { action: "abort", reason: "Aborted during retry wait" };
    }

    return { action: "retry" };
  }

  // Unknown error: abort
  return {
    action: "abort",
    reason: `Unknown error: ${errorMessage.slice(0, 200)}`,
  };
}

/** Sleep utility with optional abort signal. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}
