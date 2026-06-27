// ============================================================
// CLI Error Formatting — concise provider/API errors
// ============================================================
// SDK errors often contain large headers/request objects. Terminal users need
// the action item, not a dumped object. This formatter keeps the detail short
// and avoids printing secrets or noisy response metadata.
// ============================================================

export function formatCliError(error: unknown): string {
  const anyErr = error as any;
  const status = anyErr?.status;
  const type = anyErr?.type || anyErr?.error?.type || anyErr?.error?.error?.type;
  const message =
    anyErr?.error?.message || anyErr?.error?.error?.message || anyErr?.message || String(error);

  if (status === 401 || status === 403) {
    return `Authentication/permission error (${status}). Check LLM_API_KEY, provider, base URL, and account access. ${message}`;
  }

  if (status === 429) {
    return `Rate limit error (429). Slow down or raise your provider quota. ${message}`;
  }

  if (status === 400 && /context|token|maximum/i.test(message)) {
    return `Context/token limit error (400). Try /compact or a smaller request. ${message}`;
  }

  if (typeof status === "number" && status >= 500) {
    return `Provider server error (${status}). Retry later or switch provider. ${message}`;
  }

  if (type) {
    return `Provider error${status ? ` (${status})` : ""} [${type}]: ${message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
