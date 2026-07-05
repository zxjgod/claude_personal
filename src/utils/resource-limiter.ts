// ============================================================
// Resource Limiter - Prevent resource exhaustion
// ============================================================
// Provides centralized resource tracking and limits to prevent:
// - Too many concurrent tools
// - Too many open files
// - Excessive memory usage
// - Tool execution time limits

export interface ResourceLimits {
  maxFileSize: number; // Max file size to read/write (bytes)
  maxConcurrentTools: number; // Max concurrent tool executions
  maxToolExecutionTime: number; // Max time per tool (ms)
  maxMemoryUsage: number; // Max heap memory (bytes)
  maxOpenFiles: number; // Max open file handles
  maxContentLength: number; // Max content string length (chars)
}

export interface ResourceMetrics {
  openFiles: Set<string>;
  runningTools: number;
  totalToolCalls: number;
  failedToolCalls: number;
  startTime: number;
}

/**
 * Resource Limiter - Tracks and enforces resource limits
 */
export class ResourceLimiter {
  private static limits: ResourceLimits = {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxConcurrentTools: 10, // 10 concurrent tools
    maxToolExecutionTime: 5 * 60 * 1000, // 5 minutes
    maxMemoryUsage: 1024 * 1024 * 1024, // 1GB
    maxOpenFiles: 100, // 100 open files
    maxContentLength: 10 * 1024 * 1024, // 10MB text
  };

  private static metrics: ResourceMetrics = {
    openFiles: new Set<string>(),
    runningTools: 0,
    totalToolCalls: 0,
    failedToolCalls: 0,
    startTime: Date.now(),
  };

  // ============================================================
  // Configuration
  // ============================================================

  /**
   * Update resource limits (for testing or special cases)
   */
  static setLimits(limits: Partial<ResourceLimits>): void {
    ResourceLimiter.limits = { ...ResourceLimiter.limits, ...limits };
  }

  /**
   * Get current limits
   */
  static getLimits(): Readonly<ResourceLimits> {
    return { ...ResourceLimiter.limits };
  }

  // ============================================================
  // File Operations
  // ============================================================

  /**
   * Check if file size is within limits
   */
  static checkFileSize(sizeBytes: number): { allowed: boolean; reason?: string } {
    if (sizeBytes > ResourceLimiter.limits.maxFileSize) {
      return {
        allowed: false,
        reason: `File size (${ResourceLimiter.formatBytes(sizeBytes)}) exceeds limit (${ResourceLimiter.formatBytes(ResourceLimiter.limits.maxFileSize)})`,
      };
    }
    return { allowed: true };
  }

  /**
   * Track a file being opened
   */
  static trackFileOpen(path: string): { allowed: boolean; reason?: string } {
    if (ResourceLimiter.metrics.openFiles.size >= ResourceLimiter.limits.maxOpenFiles) {
      return {
        allowed: false,
        reason: `Too many open files (${ResourceLimiter.metrics.openFiles.size}/${ResourceLimiter.limits.maxOpenFiles})`,
      };
    }
    ResourceLimiter.metrics.openFiles.add(path);
    return { allowed: true };
  }

  /**
   * Track a file being closed
   */
  static trackFileClose(path: string): void {
    ResourceLimiter.metrics.openFiles.delete(path);
  }

  // ============================================================
  // Tool Execution
  // ============================================================

  /**
   * Acquire a slot for tool execution
   */
  static async acquireToolSlot(): Promise<{ allowed: boolean; reason?: string }> {
    if (ResourceLimiter.metrics.runningTools >= ResourceLimiter.limits.maxConcurrentTools) {
      return {
        allowed: false,
        reason: `Too many concurrent tools (${ResourceLimiter.metrics.runningTools}/${ResourceLimiter.limits.maxConcurrentTools})`,
      };
    }

    ResourceLimiter.metrics.runningTools++;
    ResourceLimiter.metrics.totalToolCalls++;
    return { allowed: true };
  }

  /**
   * Release a tool execution slot
   */
  static releaseToolSlot(): void {
    ResourceLimiter.metrics.runningTools = Math.max(0, ResourceLimiter.metrics.runningTools - 1);
  }

  /**
   * Record a failed tool call
   */
  static recordToolFailure(): void {
    ResourceLimiter.metrics.failedToolCalls++;
  }

  // ============================================================
  // Memory Management
  // ============================================================

  /**
   * Check current memory usage
   */
  static checkMemoryUsage(): { withinLimits: boolean; usage: number; limit: number } {
    const usage = process.memoryUsage();
    const heapUsed = usage.heapUsed;

    return {
      withinLimits: heapUsed < ResourceLimiter.limits.maxMemoryUsage,
      usage: heapUsed,
      limit: ResourceLimiter.limits.maxMemoryUsage,
    };
  }

  /**
   * Check if content length is within limits
   */
  static checkContentLength(length: number): { allowed: boolean; reason?: string } {
    if (length > ResourceLimiter.limits.maxContentLength) {
      return {
        allowed: false,
        reason: `Content length (${ResourceLimiter.formatBytes(length)}) exceeds limit (${ResourceLimiter.formatBytes(ResourceLimiter.limits.maxContentLength)})`,
      };
    }
    return { allowed: true };
  }

  // ============================================================
  // Metrics & Reporting
  // ============================================================

  /**
   * Get current resource metrics
   */
  static getMetrics(): Readonly<ResourceMetrics> {
    return {
      openFiles: new Set(ResourceLimiter.metrics.openFiles),
      runningTools: ResourceLimiter.metrics.runningTools,
      totalToolCalls: ResourceLimiter.metrics.totalToolCalls,
      failedToolCalls: ResourceLimiter.metrics.failedToolCalls,
      startTime: ResourceLimiter.metrics.startTime,
    };
  }

  /**
   * Get resource usage summary
   */
  static getSummary(): {
    memory: { withinLimits: boolean; usage: number; limit: number };
    tools: { running: number; total: number; failed: number };
    files: { open: number; limit: number };
    uptime: number;
  } {
    return {
      memory: ResourceLimiter.checkMemoryUsage(),
      tools: {
        running: ResourceLimiter.metrics.runningTools,
        total: ResourceLimiter.metrics.totalToolCalls,
        failed: ResourceLimiter.metrics.failedToolCalls,
      },
      files: {
        open: ResourceLimiter.metrics.openFiles.size,
        limit: ResourceLimiter.limits.maxOpenFiles,
      },
      uptime: Date.now() - ResourceLimiter.metrics.startTime,
    };
  }

  /**
   * Reset metrics (for testing)
   */
  static resetMetrics(): void {
    ResourceLimiter.metrics = {
      openFiles: new Set<string>(),
      runningTools: 0,
      totalToolCalls: 0,
      failedToolCalls: 0,
      startTime: Date.now(),
    };
  }

  // ============================================================
  // Utilities
  // ============================================================

  /**
   * Format bytes for display
   */
  private static formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  /**
   * Create a timeout promise for tool execution
   */
  static createTimeout(timeoutMs?: number): {
    promise: Promise<never>;
    clear: () => void;
  } {
    const timeout = timeoutMs ?? ResourceLimiter.limits.maxToolExecutionTime;
    let timeoutId: NodeJS.Timeout;
    const promise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Tool execution timeout after ${timeout}ms`));
      }, timeout);
    });

    return {
      promise,
      clear: () => clearTimeout(timeoutId),
    };
  }
}
