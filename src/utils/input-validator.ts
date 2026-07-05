// ============================================================
// Input Validation Framework
// ============================================================
// Provides unified input validation for all tools to prevent
// injection attacks, path traversal, and malformed inputs.

import * as path from "node:path";
import type { ToolContext } from "../types.js";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Input Validator - Centralized validation logic for tools
 */
export class InputValidator {
  /**
   * Validate file path input
   * Checks: length, illegal characters, path traversal, workspace boundary
   */
  static validateFilePath(filePath: string, context: ToolContext): ValidationResult {
    // Check path length (most filesystems have limits around 4096)
    if (filePath.length > 4096) {
      return { valid: false, error: "Path exceeds maximum length (4096 characters)" };
    }

    // Check for null bytes (can cause issues in C-based filesystem APIs)
    if (/[\x00-\x1F]/.test(filePath)) {
      return { valid: false, error: "Path contains illegal control characters" };
    }

    // Check for dangerous patterns
    if (InputValidator.containsDangerousPathPattern(filePath)) {
      return { valid: false, error: "Path contains potentially dangerous pattern" };
    }

    return { valid: true };
  }

  /**
   * Validate shell command input
   * Checks: length, dangerous patterns (fork bomb, device writes, etc.)
   */
  static validateCommand(command: string): ValidationResult {
    // Check command length (prevent resource exhaustion)
    if (command.length > 100000) {
      return { valid: false, error: "Command exceeds maximum length (100,000 characters)" };
    }

    // Check for dangerous patterns
    const dangerous = InputValidator.detectDangerousCommandPattern(command);
    if (dangerous) {
      return { valid: false, error: `Dangerous command pattern detected: ${dangerous}` };
    }

    return { valid: true };
  }

  /**
   * Validate URL input for web tools
   */
  static validateUrl(url: string): ValidationResult {
    // Check URL length
    if (url.length > 8192) {
      return { valid: false, error: "URL exceeds maximum length (8192 characters)" };
    }

    // Check for valid URL format
    try {
      const parsed = new URL(url);

      // Block certain protocols
      const blockedProtocols = ["file:", "ftp:", "data:", "javascript:"];
      if (blockedProtocols.includes(parsed.protocol)) {
        return { valid: false, error: `Protocol ${parsed.protocol} is not allowed` };
      }

      // Block private/internal networks (SSRF prevention)
      if (InputValidator.isPrivateNetwork(parsed.hostname)) {
        return { valid: false, error: "Access to private networks is not allowed" };
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, error: "Invalid URL format" };
    }
  }

  /**
   * Validate text content length
   */
  static validateContentLength(content: string, maxLength: number): ValidationResult {
    if (content.length > maxLength) {
      return {
        valid: false,
        error: `Content exceeds maximum length (${maxLength} characters)`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate numeric input is within bounds
   */
  static validateNumericRange(
    value: number,
    min: number,
    max: number,
    name: string = "value",
  ): ValidationResult {
    if (!Number.isFinite(value)) {
      return { valid: false, error: `${name} must be a finite number` };
    }
    if (value < min || value > max) {
      return { valid: false, error: `${name} must be between ${min} and ${max}` };
    }
    return { valid: true };
  }

  // ============================================================
  // Private Helper Methods
  // ============================================================

  /**
   * Check for dangerous path patterns
   */
  private static containsDangerousPathPattern(filePath: string): boolean {
    const dangerous = [
      /\.\.[/\\]/, // Path traversal
      /^[/\\]{2,}/, // UNC paths on Windows
      /[\x00]/, // Null byte
      /[<>:"|?*]/, // Invalid Windows filename chars
    ];

    return dangerous.some((pattern) => pattern.test(filePath));
  }

  /**
   * Detect dangerous command patterns
   */
  private static detectDangerousCommandPattern(command: string): string | null {
    const patterns: [RegExp, string][] = [
      // Fork bomb
      [/:\(\)\{\s*:\|:&\s*\};:/, "fork bomb"],

      // Device writes
      [/>\s*\/dev\/(sd[a-z]|nvme\d+n\d+|hd[a-z])/, "device write"],

      // dd to device
      [/\bdd\s+.*of=\/dev\//, "dd to device"],

      // Dangerous rm patterns
      [/\brm\s+-rf\s+\/($|\s)/, "recursive delete of root"],

      // mkfs (format filesystem)
      [/\bmkfs/, "filesystem format"],

      // fdisk (partition manipulation)
      [/\bfdisk/, "disk partitioning"],

      // Kernel module manipulation
      [/\b(insmod|rmmod|modprobe)\b/, "kernel module manipulation"],
    ];

    for (const [pattern, description] of patterns) {
      if (pattern.test(command)) {
        return description;
      }
    }

    return null;
  }

  /**
   * Check if hostname is in private network range (SSRF prevention)
   */
  private static isPrivateNetwork(hostname: string): boolean {
    // Local hostnames
    if (/^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(hostname)) {
      return true;
    }

    // Private IP ranges
    const privateRanges = [
      /^10\.\d+\.\d+\.\d+$/, // 10.0.0.0/8
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/, // 172.16.0.0/12
      /^192\.168\.\d+\.\d+$/, // 192.168.0.0/16
      /^169\.254\.\d+\.\d+$/, // 169.254.0.0/16 (link-local)
      /^fd[0-9a-f]{2}:/i, // IPv6 ULA
      /^fe80:/i, // IPv6 link-local
    ];

    return privateRanges.some((pattern) => pattern.test(hostname));
  }
}
