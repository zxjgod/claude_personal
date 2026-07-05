// ============================================================
// Health Check System
// ============================================================
// Provides system health monitoring and diagnostics for the
// Claude Code replica application.

import * as fs from "node:fs";
import { ResourceLimiter } from "./resource-limiter.js";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  status: HealthStatus;
  checks: {
    filesystem: boolean;
    memory: boolean;
    tools: boolean;
    resources: boolean;
  };
  metrics: {
    uptime: number;
    totalTools: number;
    failedTools: number;
    memoryUsage: number;
    memoryLimit: number;
    openFiles: number;
    runningTools: number;
  };
  errors: string[];
  timestamp: number;
}

// Module-level state
let startTime = Date.now();

/**
 * Perform complete health check
 */
export async function checkHealth(): Promise<HealthCheckResult> {
  const errors: string[] = [];
  const checks = {
    filesystem: await checkFilesystem(errors),
    memory: checkMemory(errors),
    tools: checkTools(errors),
    resources: checkResources(errors),
  };

  const status = determineStatus(checks, errors);
  const resourceSummary = ResourceLimiter.getSummary();
  const memoryCheck = ResourceLimiter.checkMemoryUsage();

  return {
    status,
    checks,
    metrics: {
      uptime: Date.now() - startTime,
      totalTools: resourceSummary.tools.total,
      failedTools: resourceSummary.tools.failed,
      memoryUsage: memoryCheck.usage,
      memoryLimit: memoryCheck.limit,
      openFiles: resourceSummary.files.open,
      runningTools: resourceSummary.tools.running,
    },
    errors,
    timestamp: Date.now(),
  };
}

/**
 * Check filesystem health
 */
async function checkFilesystem(errors: string[]): Promise<boolean> {
  try {
    const testPath = ".health-check-test";
    await fs.promises.writeFile(testPath, "test", "utf-8");
    await fs.promises.readFile(testPath, "utf-8");
    await fs.promises.unlink(testPath);
    return true;
  } catch (error: any) {
    errors.push(`Filesystem check failed: ${error.message}`);
    return false;
  }
}

/**
 * Check memory health
 */
function checkMemory(errors: string[]): boolean {
  const memoryCheck = ResourceLimiter.checkMemoryUsage();

  if (!memoryCheck.withinLimits) {
    const usagePct = ((memoryCheck.usage / memoryCheck.limit) * 100).toFixed(1);
    errors.push(`Memory usage high: ${usagePct}% of limit`);
    return false;
  }

  const usagePct = (memoryCheck.usage / memoryCheck.limit) * 100;
  if (usagePct > 80) {
    errors.push(`Memory usage elevated: ${usagePct.toFixed(1)}%`);
  }

  return true;
}

/**
 * Check tool execution health
 */
function checkTools(errors: string[]): boolean {
  const summary = ResourceLimiter.getSummary();
  const totalCalls = summary.tools.total;
  const failedCalls = summary.tools.failed;

  if (totalCalls === 0) {
    return true;
  }

  const failureRate = (failedCalls / totalCalls) * 100;

  if (failureRate > 10) {
    errors.push(`High tool failure rate: ${failureRate.toFixed(1)}%`);
    return false;
  }

  if (failureRate > 5) {
    errors.push(`Elevated tool failure rate: ${failureRate.toFixed(1)}%`);
  }

  return true;
}

/**
 * Check resource limits
 */
function checkResources(errors: string[]): boolean {
  const summary = ResourceLimiter.getSummary();
  const limits = ResourceLimiter.getLimits();

  let healthy = true;

  const fileUsagePct = (summary.files.open / limits.maxOpenFiles) * 100;
  if (fileUsagePct > 90) {
    errors.push(`Open files near limit: ${summary.files.open}/${limits.maxOpenFiles}`);
    healthy = false;
  } else if (fileUsagePct > 75) {
    errors.push(`Open files elevated: ${summary.files.open}/${limits.maxOpenFiles}`);
  }

  const toolUsagePct = (summary.tools.running / limits.maxConcurrentTools) * 100;
  if (toolUsagePct > 90) {
    errors.push(
      `Concurrent tools near limit: ${summary.tools.running}/${limits.maxConcurrentTools}`,
    );
    healthy = false;
  }

  return healthy;
}

/**
 * Determine overall health status
 */
function determineStatus(checks: Record<string, boolean>, errors: string[]): HealthStatus {
  const failedChecks = Object.values(checks).filter((v) => !v).length;

  if (failedChecks === 0 && errors.length === 0) {
    return "healthy";
  }

  if (failedChecks <= 1 || errors.length <= 2) {
    return "degraded";
  }

  return "unhealthy";
}

/**
 * Get human-readable health report
 */
export async function getHealthReport(): Promise<string> {
  const health = await checkHealth();
  const lines: string[] = [];

  const statusEmoji = {
    healthy: "✅",
    degraded: "⚠️",
    unhealthy: "❌",
  };
  lines.push(`${statusEmoji[health.status]} Health Status: ${health.status.toUpperCase()}`);
  lines.push("");

  lines.push("Checks:");
  for (const [name, passed] of Object.entries(health.checks)) {
    lines.push(`  ${passed ? "✅" : "❌"} ${name}: ${passed ? "OK" : "FAILED"}`);
  }
  lines.push("");

  lines.push("Metrics:");
  lines.push(`  Uptime: ${formatDuration(health.metrics.uptime)}`);
  lines.push(
    `  Tools: ${health.metrics.runningTools} running, ${health.metrics.totalTools} total, ${health.metrics.failedTools} failed`,
  );
  lines.push(
    `  Memory: ${formatBytes(health.metrics.memoryUsage)} / ${formatBytes(health.metrics.memoryLimit)}`,
  );
  lines.push(`  Open files: ${health.metrics.openFiles}`);
  lines.push("");

  if (health.errors.length > 0) {
    lines.push("Issues:");
    for (const error of health.errors) {
      lines.push(`  ⚠️  ${error}`);
    }
    lines.push("");
  }

  lines.push(`Last check: ${new Date(health.timestamp).toISOString()}`);

  return lines.join("\n");
}

/**
 * Format bytes for display
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format duration for display
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Reset start time (for testing)
 */
export function resetStartTime(): void {
  startTime = Date.now();
}

// Backward compatibility: export class-like interface
export const HealthChecker = {
  check: checkHealth,
  getReport: getHealthReport,
  resetStartTime,
};
