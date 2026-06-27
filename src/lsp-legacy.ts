// ============================================================
// LSP legacy pure helpers (kept for the tsc-fallback path & tests)
// ============================================================
// These were the original lsp.ts surface. The real long-lived LSP client
// lives in lsp.ts now; this module holds the pure parsing/formatting
// helpers that don't need a server, so the tsc fallback and existing
// tests keep working unchanged.
// ============================================================

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

const DIAG_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

/**
 * Parse `tsc --noEmit` (non-pretty) stdout into diagnostics.
 * Exported for testing without spawning a compiler.
 */
export function parseTscOutput(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const m = DIAG_RE.exec(rawLine.trim());
    if (!m) continue;
    diagnostics.push({
      file: m[1],
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      severity: m[4] as "error" | "warning",
      code: m[5],
      message: m[6],
    });
  }
  return diagnostics;
}

/** Filter diagnostics to those whose file path contains `needle`. */
export function filterByFile(diagnostics: Diagnostic[], needle: string): Diagnostic[] {
  const norm = needle.replace(/\\/g, "/").toLowerCase();
  return diagnostics.filter((d) => d.file.replace(/\\/g, "/").toLowerCase().includes(norm));
}

/** Format diagnostics into a compact, model-friendly report. */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "No diagnostics. ✓";
  const lines = diagnostics
    .slice(0, 100)
    .map(
      (d) => `${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.column} ${d.code} — ${d.message}`,
    );
  const more = diagnostics.length > 100 ? `\n… and ${diagnostics.length - 100} more` : "";
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  return `${errors} error(s), ${warnings} warning(s):\n${lines.join("\n")}${more}`;
}
