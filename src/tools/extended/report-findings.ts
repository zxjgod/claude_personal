// ============================================================
// ReportFindings Tool — Code review structured output
// ============================================================
// Report code-review findings as a typed list for UI rendering.
// Used by /review skill and code review workflows.
// ============================================================

import { z } from "zod";
import type { Tool, ToolResult } from "../../types.js";
import { buildTool } from "../registry.js";

// ============================================================
// Types
// ============================================================

export type FindingVerdict = "CONFIRMED" | "PLAUSIBLE";
export type FindingOutcome = "fixed" | "skipped" | "no_change_needed";

export interface CodeFinding {
  file: string;
  line?: number;
  summary: string;
  category: string;
  failure_scenario: string;
  verdict?: FindingVerdict;
  outcome?: FindingOutcome;
}

export interface FindingsReport {
  findings: CodeFinding[];
  level?: "low" | "medium" | "high" | "xhigh" | "max";
  reportedAt: bigint;
}

// Session-scoped findings registry
const FINDINGS_REGISTRY = new Map<string, FindingsReport[]>();

/**
 * Store a findings report for a session.
 */
export function recordFindings(sessionId: string, report: FindingsReport): void {
  const reports = FINDINGS_REGISTRY.get(sessionId) ?? [];
  reports.push(report);
  FINDINGS_REGISTRY.set(sessionId, reports);
}

/**
 * Get all findings reports for a session.
 */
export function getFindings(sessionId: string): FindingsReport[] {
  return FINDINGS_REGISTRY.get(sessionId) ?? [];
}

/**
 * Clear findings for a session (for tests).
 */
export function clearFindings(sessionId: string): void {
  FINDINGS_REGISTRY.delete(sessionId);
}

// ============================================================
// ReportFindings Tool
// ============================================================

const FindingSchema = z.strictObject({
  file: z.string().min(1).describe("Repo-relative path of the file the finding is in"),
  line: z.number().int().min(1).optional().describe("1-indexed line the finding anchors to"),
  summary: z.string().min(1).describe("One-sentence statement of the defect"),
  category: z
    .string()
    .max(40)
    .describe(
      'Short kebab-case slug of finding type (e.g., "correctness", "simplification", "efficiency")',
    ),
  failure_scenario: z.string().min(1).describe("Concrete inputs/state → wrong output/crash"),
  verdict: z
    .enum(["CONFIRMED", "PLAUSIBLE"])
    .optional()
    .describe("Set when a verify pass ran; absent on inline-only reviews"),
  outcome: z
    .enum(["fixed", "skipped", "no_change_needed"])
    .optional()
    .describe("Set ONLY when re-reporting after applying fixes: what happened to this finding"),
});

const ReportFindingsSchema = z.strictObject({
  findings: z
    .array(FindingSchema)
    .max(32)
    .describe("Verified findings, most-severe first; empty if none survived"),
  level: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Effort level the review ran at"),
});

export const ReportFindingsTool: Tool = buildTool({
  name: "ReportFindings",
  description: "Report code-review findings as a structured list",
  promptDescription:
    "Report code-review findings as a typed list so the UI can render them. " +
    "Use this only when active code-review instructions tell you to report with this tool. " +
    "Call once with verified findings ranked most-severe first (empty array if nothing). " +
    "Do not also print findings as text. " +
    "\n\n" +
    "Each finding requires:\n" +
    "  - file: repo-relative path\n" +
    "  - summary: one-sentence defect statement\n" +
    "  - category: short kebab-case slug (correctness/simplification/efficiency/test-coverage)\n" +
    "  - failure_scenario: concrete inputs → wrong output\n" +
    "  - line (optional): 1-indexed anchor line\n" +
    "  - verdict (optional): CONFIRMED or PLAUSIBLE (set when verify pass ran)\n" +
    "  - outcome (optional): fixed/skipped/no_change_needed (set when re-reporting after fixes)\n" +
    "\n\n" +
    "When re-reporting after applying fixes (only if instructions ask), set outcome on each finding.",
  schema: ReportFindingsSchema,
  isReadOnly: false,
  requiresApproval: false,
  isConcurrencySafe: true,
  searchHint: "report findings code review defect bug issue",
  aliases: ["report_findings"],

  async call(input, context): Promise<ToolResult> {
    const report: FindingsReport = {
      findings: input.findings as CodeFinding[],
      level: input.level,
      reportedAt: process.hrtime.bigint(),
    };

    // Store for session
    recordFindings(context.sessionId, report);

    // Format output
    if (report.findings.length === 0) {
      return {
        content:
          "Code review complete. No findings.\n" +
          (report.level ? `Review level: ${report.level}\n` : ""),
      };
    }

    const lines: string[] = [
      `Code review complete. ${report.findings.length} finding(s)${report.level ? ` (level: ${report.level})` : ""}:`,
      "",
    ];

    for (let i = 0; i < report.findings.length; i++) {
      const f = report.findings[i]!;
      const location = f.line ? `${f.file}:${f.line}` : f.file;
      const verdict = f.verdict ? ` [${f.verdict}]` : "";
      const outcome = f.outcome ? ` → ${f.outcome}` : "";

      lines.push(`${i + 1}. [${f.category}] ${location}${verdict}${outcome}`);
      lines.push(`   ${f.summary}`);
      lines.push(`   Scenario: ${f.failure_scenario}`);
      lines.push("");
    }

    return { content: lines.join("\n") };
  },
});
