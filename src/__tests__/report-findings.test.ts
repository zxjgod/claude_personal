// ============================================================
// ReportFindings Tests
// ============================================================

import { beforeEach, describe, expect, it } from "vitest";
import {
  type CodeFinding,
  clearFindings,
  type FindingsReport,
  getFindings,
  recordFindings,
} from "../tools/extended/report-findings.js";

describe("ReportFindings", () => {
  const sessionId = "test-session";

  beforeEach(() => {
    clearFindings(sessionId);
  });

  describe("recordFindings", () => {
    it("should record a findings report", () => {
      const findings: CodeFinding[] = [
        {
          file: "src/auth.ts",
          line: 42,
          summary: "Potential SQL injection",
          category: "security",
          failure_scenario: "Malicious input bypasses sanitization",
          verdict: "CONFIRMED",
        },
      ];

      const report: FindingsReport = {
        findings,
        level: "high",
        reportedAt: process.hrtime.bigint(),
      };

      recordFindings(sessionId, report);

      const reports = getFindings(sessionId);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.findings).toHaveLength(1);
      expect(reports[0]?.findings[0]?.summary).toBe("Potential SQL injection");
    });

    it("should support multiple reports per session", () => {
      const report1: FindingsReport = {
        findings: [
          {
            file: "src/auth.ts",
            summary: "Issue 1",
            category: "security",
            failure_scenario: "Scenario 1",
          },
        ],
        reportedAt: process.hrtime.bigint(),
      };

      const report2: FindingsReport = {
        findings: [
          {
            file: "src/api.ts",
            summary: "Issue 2",
            category: "correctness",
            failure_scenario: "Scenario 2",
          },
        ],
        reportedAt: process.hrtime.bigint(),
      };

      recordFindings(sessionId, report1);
      recordFindings(sessionId, report2);

      const reports = getFindings(sessionId);
      expect(reports).toHaveLength(2);
    });

    it("should isolate findings by session", () => {
      const report1: FindingsReport = {
        findings: [
          {
            file: "file1.ts",
            summary: "Issue 1",
            category: "test",
            failure_scenario: "Scenario 1",
          },
        ],
        reportedAt: process.hrtime.bigint(),
      };

      const report2: FindingsReport = {
        findings: [
          {
            file: "file2.ts",
            summary: "Issue 2",
            category: "test",
            failure_scenario: "Scenario 2",
          },
        ],
        reportedAt: process.hrtime.bigint(),
      };

      recordFindings("session1", report1);
      recordFindings("session2", report2);

      expect(getFindings("session1")).toHaveLength(1);
      expect(getFindings("session2")).toHaveLength(1);
      expect(getFindings("session1")[0]?.findings[0]?.file).toBe("file1.ts");
      expect(getFindings("session2")[0]?.findings[0]?.file).toBe("file2.ts");
    });
  });

  describe("getFindings", () => {
    it("should return empty array for session with no findings", () => {
      const findings = getFindings("empty-session");
      expect(findings).toEqual([]);
    });

    it("should return all findings for a session", () => {
      const report: FindingsReport = {
        findings: [
          {
            file: "test.ts",
            summary: "Test finding",
            category: "test",
            failure_scenario: "Test scenario",
          },
        ],
        reportedAt: process.hrtime.bigint(),
      };

      recordFindings(sessionId, report);

      const findings = getFindings(sessionId);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.findings).toHaveLength(1);
    });
  });

  describe("clearFindings", () => {
    it("should clear findings for a session", () => {
      const report: FindingsReport = {
        findings: [
          {
            file: "test.ts",
            summary: "Test",
            category: "test",
            failure_scenario: "Test",
          },
        ],
        reportedAt: process.hrtime.bigint(),
      };

      recordFindings(sessionId, report);
      expect(getFindings(sessionId)).toHaveLength(1);

      clearFindings(sessionId);
      expect(getFindings(sessionId)).toHaveLength(0);
    });

    it("should not affect other sessions", () => {
      // Use fresh session IDs to avoid test pollution
      const session1 = "clear-test-session-1";
      const session2 = "clear-test-session-2";

      // Clear any existing data first
      clearFindings(session1);
      clearFindings(session2);

      const report: FindingsReport = {
        findings: [
          {
            file: "test.ts",
            summary: "Test",
            category: "test",
            failure_scenario: "Test",
          },
        ],
        reportedAt: process.hrtime.bigint(),
      };

      recordFindings(session1, report);
      recordFindings(session2, report);

      clearFindings(session1);

      expect(getFindings(session1)).toHaveLength(0);
      expect(getFindings(session2)).toHaveLength(1);
    });
  });

  describe("CodeFinding structure", () => {
    it("should support all finding fields", () => {
      const finding: CodeFinding = {
        file: "src/auth.ts",
        line: 42,
        summary: "Potential SQL injection vulnerability",
        category: "security",
        failure_scenario: "User input 'OR 1=1-- bypasses authentication",
        verdict: "CONFIRMED",
        outcome: "fixed",
      };

      const report: FindingsReport = {
        findings: [finding],
        level: "high",
        reportedAt: process.hrtime.bigint(),
      };

      recordFindings(sessionId, report);

      const retrieved = getFindings(sessionId)[0]?.findings[0];
      expect(retrieved?.file).toBe("src/auth.ts");
      expect(retrieved?.line).toBe(42);
      expect(retrieved?.summary).toBe("Potential SQL injection vulnerability");
      expect(retrieved?.category).toBe("security");
      expect(retrieved?.verdict).toBe("CONFIRMED");
      expect(retrieved?.outcome).toBe("fixed");
    });

    it("should support findings without line numbers", () => {
      const finding: CodeFinding = {
        file: "package.json",
        summary: "Outdated dependency",
        category: "maintenance",
        failure_scenario: "Using vulnerable version of library",
      };

      const report: FindingsReport = {
        findings: [finding],
        reportedAt: process.hrtime.bigint(),
      };

      recordFindings(sessionId, report);

      const retrieved = getFindings(sessionId)[0]?.findings[0];
      expect(retrieved?.line).toBeUndefined();
    });

    it("should support empty findings (no issues found)", () => {
      const report: FindingsReport = {
        findings: [],
        level: "high",
        reportedAt: process.hrtime.bigint(),
      };

      recordFindings(sessionId, report);

      const retrieved = getFindings(sessionId)[0];
      expect(retrieved?.findings).toEqual([]);
    });
  });

  describe("review levels", () => {
    it("should support different review effort levels", () => {
      const levels: Array<"low" | "medium" | "high" | "xhigh" | "max"> = [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ];

      for (const level of levels) {
        const report: FindingsReport = {
          findings: [],
          level,
          reportedAt: process.hrtime.bigint(),
        };

        recordFindings(`session-${level}`, report);

        const retrieved = getFindings(`session-${level}`)[0];
        expect(retrieved?.level).toBe(level);
      }
    });

    it("should support reports without level", () => {
      const report: FindingsReport = {
        findings: [],
        reportedAt: process.hrtime.bigint(),
      };

      recordFindings(sessionId, report);

      const retrieved = getFindings(sessionId)[0];
      expect(retrieved?.level).toBeUndefined();
    });
  });
});
